/**
 * Kimi Code Provider
 *
 * OAuth device-code accounts for Moonshot Kimi Code CLI.
 * Upstream: https://api.kimi.com/coding/v1 (OpenAI-compatible).
 * Quota windows come from GET /usages (5h + weekly).
 */

import type {
  Provider,
  QuotaWindow,
  QuotaWallet,
  ProviderCredential,
  ForwardRequestInput,
  ForwardTarget,
  UpstreamErrorClassification,
} from "./types"
import type { AccountRecord, QuotaKind, ProviderAccountData } from "../types"
import type { PoolType } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { apiFetch } from "../api-fetch"
import {
  createKimiDeviceHeaders,
  fetchKimiModels,
  fetchKimiUsage,
  fetchKimiUserInfo,
  kimiCodeBaseUrl,
  kimiRefreshThresholdSeconds,
  KIMI_CODE_CLIENT_ID,
  KimiTokenInvalidError,
  refreshKimiAccessToken,
  type KimiUsageRow,
  type KimiWalletInfo,
} from "../kimi-oauth"

const REQUEST_TIMEOUT_MS = 30_000
const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY"]
const DEFAULT_MODELS = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"] as const
const PASSTHROUGH_HEADERS = ["accept-language", "anthropic-version", "anthropic-beta"] as const

function walletToQuota(wallet: KimiWalletInfo): QuotaWallet {
  return {
    balanceCents: wallet.balanceCents,
    totalCents: wallet.totalCents,
    monthlyChargeLimitEnabled: wallet.monthlyChargeLimitEnabled,
    monthlyChargeLimitCents: wallet.monthlyChargeLimitCents,
    monthlyUsedCents: wallet.monthlyUsedCents,
    currency: wallet.currency,
  }
}

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function usageToWindow(row: KimiUsageRow, kind: QuotaKind): QuotaWindow {
  const usagePercent = row.limit > 0 ? roundPercent((row.used / row.limit) * 100) : 0
  const remaining = row.limit > 0 ? Math.max(0, row.limit - row.used) : null
  let resetInSeconds: number | null = null
  if (row.resetAt) {
    const parsed = Date.parse(row.resetAt)
    if (!Number.isNaN(parsed)) resetInSeconds = Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
  }
  return {
    kind,
    usagePercent,
    limitValue: row.limit || null,
    remainingValue: remaining,
    resetAt: row.resetAt,
    resetInSeconds,
    lastObservedAt: new Date().toISOString(),
    source: "API_PROBE",
  }
}

function classifyUsageLabel(label: string): QuotaKind | null {
  const lower = label.toLowerCase()
  if (lower.includes("5h") || lower.includes("5 h") || lower.includes("300m") || lower.includes("five")) {
    return "FIVE_HOUR"
  }
  if (lower.includes("week") || lower.includes("weekly") || lower.includes("7d") || lower.includes("周")) {
    return "WEEKLY"
  }
  if (lower.includes("hour") || /\d+h/.test(lower)) {
    const match = lower.match(/(\d+)\s*h/)
    if (match && Number(match[1]) <= 6) return "FIVE_HOUR"
  }
  return null
}

function windowsFromUsage(summary: KimiUsageRow | null, limits: KimiUsageRow[]): QuotaWindow[] {
  const windows = new Map<QuotaKind, QuotaWindow>()
  for (const row of limits) {
    const kind = classifyUsageLabel(row.label)
    if (!kind || windows.has(kind)) continue
    windows.set(kind, usageToWindow(row, kind))
  }
  if (summary) {
    const kind = classifyUsageLabel(summary.label) || "WEEKLY"
    if (!windows.has(kind)) windows.set(kind, usageToWindow(summary, kind))
  }
  // Prefer known shapes; if only one limit came back, map it to weekly.
  if (windows.size === 0 && limits[0]) {
    windows.set("WEEKLY", usageToWindow(limits[0], "WEEKLY"))
  }
  return [...windows.values()]
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(1, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(1, Math.ceil((parsed - Date.now()) / 1000))
}

// 对齐官方 kimi-errors.ts：Moonshot 用 429 + 结构化 error.type/code
// （exceeded_current_quota_error）或 billing 措辞表达配额/余额耗尽，
// 与瞬时限流（普通 429）区分。
const KIMI_QUOTA_EXHAUSTED_CODES = new Set(["exceeded_current_quota_error"])
const KIMI_QUOTA_EXHAUSTED_PATTERNS = [
  /exceeded your current (?:token )?quota/,
  /check your account balance/,
  /insufficient balance/,
  /recharge your account|please recharge/,
  /account (?:is )?in arrears/,
] as const

function isKimiQuotaExhausted(body: string): boolean {
  if (!body) return false
  try {
    // 结构化：遍历 error → error.error 最多 3 层，收集 code/type。
    const codes: string[] = []
    let current: unknown = JSON.parse(body)
    for (let depth = 0; current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3; depth += 1) {
      const record = current as Record<string, unknown>
      if (typeof record.code === "string") codes.push(record.code)
      if (typeof record.type === "string") codes.push(record.type)
      current = record.error
    }
    if (codes.some((code) => KIMI_QUOTA_EXHAUSTED_CODES.has(code))) return true
  } catch {
    // 非 JSON（如纯文本），走 message 匹配。
  }
  const lower = body.toLowerCase()
  return KIMI_QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(lower))
}

export class KimiCodeProvider implements Provider {
  readonly poolType: PoolType = "kimi-code"
  readonly displayName = "Kimi Code"

  private readonly vault = new SecretVault()

  private async refreshTokenIfNeeded(credential: ProviderCredential, accountId: string): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(accountId) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) return credential
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
    if (!data.refreshToken) return credential

    const expiresAt = data.expiresAt ? Number(data.expiresAt) : 0
    const expiresIn = data.expiresIn ? Number(data.expiresIn) : 0
    const now = Date.now()
    // 对齐官方 oauth-manager.ts defaultRefreshThreshold：剩余不足
    // max(300, expiresIn*0.5) 秒即提前刷新，避免长请求/时钟偏移中途过期。
    // expiresIn 缺失（旧数据）时退化为固定 300s。
    if (data.token && expiresAt && now < (expiresAt - kimiRefreshThresholdSeconds(expiresIn)) * 1000) return credential

    try {
      const token = await refreshKimiAccessToken(data.refreshToken, data.clientId || KIMI_CODE_CLIENT_ID)
      data.token = token.accessToken
      data.refreshToken = token.refreshToken
      data.expiresAt = String(token.expiresAt)
      data.expiresIn = String(token.expiresIn)
      delete data.revokedAt
      if (token.scope) data.extraHeaders = { ...(data.extraHeaders || {}), scope: token.scope }
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
      return {
        token: token.accessToken,
        extraHeaders: credential.extraHeaders ?? {},
        credentialVersion: row.credential_version + 1,
      }
    } catch (cause) {
      // refresh_token 被上游拒绝（401/403/invalid_grant）：落失效标记，
      // 后续请求直接报「需重新登录」，不再每次拿死 token 白刷（对齐官方
      // revoked tombstone 语义）。
      if (cause instanceof KimiTokenInvalidError) {
        data.token = ""
        data.revokedAt = new Date().toISOString()
        db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
          .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
        throw cause
      }
      // 网络 / 5xx 抖动：保留旧 token 静默降级，不误杀账号。
      return credential
    }
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new Error(`No provider credentials found for account ${account.id}`)
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
    if (!data.token) {
      throw new KimiTokenInvalidError(
        data.revokedAt
          ? `Kimi 账号凭据已失效（refresh_token 被拒绝，需重新登录），account=${account.id}`
          : `Kimi 账号缺少 access token，account=${account.id}`,
      )
    }
    const credential: ProviderCredential = {
      token: data.token,
      extraHeaders: {},
      credentialVersion: row.credential_version,
    }
    return this.refreshTokenIfNeeded(credential, account.id)
  }

  /** best-effort 拉 /me 补齐账号信息（user_id/region/domain/level/email），失败不影响主流程。 */
  private async updateUserInfo(account: AccountRecord, accessToken: string): Promise<void> {
    try {
      const info = await fetchKimiUserInfo(accessToken, account)
      if (!info) return
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
        .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined
      if (!row) return
      const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
      data.kimiUserId = info.userId
      if (info.nickname) data.kimiNickname = info.nickname
      if (info.region) data.region = info.region
      if (info.domainName) data.domainName = info.domainName
      if (info.userLevel) data.userLevel = String(info.userLevel)
      if (info.email) data.email = info.email
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), account.id)
    } catch {
      // best-effort：/me 失败不阻断校验
    }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    let credential: ProviderCredential
    try {
      credential = await this.getCredential(account)
    } catch (cause) {
      if (cause instanceof KimiTokenInvalidError) return { valid: false }
      throw cause
    }
    try {
      const models = await fetchKimiModels(credential.token, account)
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?")
        .get(account.id) as { credential_data_ciphertext: string } | undefined
      let email: string | undefined
      if (row) {
        const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
        email = data.email
      }
      void this.updateUserInfo(account, credential.token)
      return { valid: true, email, planType: "kimi-code", extra: { modelCount: models.length } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 401/402/403 均为认证/会员权益类错误（官方 managed-kimi-code 把三者
      // 都视为 auth 类）；网络/5xx 保留账号可用。
      if (/\b(401|402|403)\b/.test(message)) {
        return { valid: false }
      }
      return { valid: true }
    }
  }

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  supportedInterfaces(): readonly import("../messages/route-decision").InterfaceFormat[] {
    return ["chat", "messages"] as const
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    void _accountId
    const credential = await this.getCredential(account)
    const usage = await fetchKimiUsage(credential.token, account)
    const windows = windowsFromUsage(usage.summary, usage.limits)
    // Booster 钱包余额挂在周额度窗口上（usage.summary 即周额度）。
    if (usage.wallet && windows.length > 0) {
      const wallet = walletToQuota(usage.wallet)
      const target = windows.find((window) => window.kind === "WEEKLY") ?? windows[0]
      target.wallet = wallet
    }
    return windows
  }

  getAvailableModels(): string[] {
    return this.readCachedModels() ?? [...DEFAULT_MODELS]
  }

  getDefaultModels(): string[] {
    return [...DEFAULT_MODELS]
  }

  supportsModel(model: string): boolean {
    return this.getAvailableModels().includes(model)
  }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    const credential = await this.getCredential(account)
    return fetchKimiModels(credential.token, account)
  }

  private readCachedModels(): string[] | null {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT models_json FROM provider_model_cache WHERE pool_type=?").get(this.poolType) as { models_json: string } | undefined
      if (!row?.models_json) return null
      const parsed = JSON.parse(row.models_json) as unknown
      if (!Array.isArray(parsed)) return null
      const models = parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      return models.length ? models : null
    } catch {
      return null
    }
  }

  resolveModel(_account: AccountRecord, requestedModel: string): string {
    void _account
    return requestedModel
  }

  getUpstreamBaseUrl(): string {
    return kimiCodeBaseUrl()
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    void _account
    const url = `${this.getUpstreamBaseUrl()}/${input.endpoint}`
    const headers = new Headers(createKimiDeviceHeaders())
    headers.set("Authorization", `Bearer ${credential.token}`)
    headers.set("accept", "application/json, text/event-stream")
    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }
    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }
    // Re-assert identity after passthrough.
    for (const [key, value] of Object.entries(createKimiDeviceHeaders()) as Array<[string, string]>) {
      headers.set(key, value)
    }
    headers.set("Authorization", `Bearer ${credential.token}`)
    return { url, headers, body: input.body }
  }

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    if (status === 429) {
      // Moonshot 的配额/余额耗尽也是 429：结构化 error.type=exceeded_current_quota_error
      // 或 billing 措辞，需与瞬时限流区分（官方 kimi-errors.ts 语义）。
      if (isKimiQuotaExhausted(body)) {
        return {
          shouldSwitchAccount: true,
          quotaKind: "WEEKLY",
          retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 60,
          errorType: "KIMI_QUOTA_EXCEEDED",
        }
      }
      return {
        shouldSwitchAccount: true,
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 30,
        errorType: "KIMI_RATE_LIMITED",
      }
    }
    if (status === 402) {
      // 402 在 /models 语境是会员权益/计费类错误（官方视为 auth 类）；
      // 聊天转发时说明该号不可用，切换账号。
      return {
        shouldSwitchAccount: true,
        quotaKind: "WEEKLY",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 60,
        errorType: "KIMI_QUOTA_EXCEEDED",
      }
    }
    if (status === 401 || status === 403) {
      return {
        shouldSwitchAccount: false,
        errorType: "AuthenticationError",
      }
    }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}
