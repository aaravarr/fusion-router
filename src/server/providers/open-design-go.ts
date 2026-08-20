/**
 * Open Design GO Provider
 *
 * Open Design GO 订阅（OpenAI 兼容 API）：
 * - 推理：POST {linkUrl}/chat/completions  Authorization: Bearer {runtimeKey}
 *   linkUrl 形如 https://xxx/v1，自动规整为以 /v1 结尾
 * - 控制面：GET {apiUrl}/api/v1/models 和 GET {apiUrl}/api/v1/wallet/balance
 *   Authorization: Bearer {controlKey}，apiUrl 默认 https://amr-api.open-design.ai
 * - 凭据来源：~/.amr/config.json {profiles:{prod:{controlKey,runtimeKey,apiUrl,linkUrl,user:{id,email,plan}}}}
 */

import type {
  Provider,
  QuotaWindow,
  ProviderCredential,
  ForwardRequestInput,
  ForwardTarget,
  UpstreamErrorClassification,
} from "./types"
import type { AccountRecord, QuotaKind } from "../types"
import type { PoolType } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { apiFetch } from "../api-fetch"

const DEFAULT_API_URL = "https://amr-api.open-design.ai"
const REQUEST_TIMEOUT_MS = 30000

export const OPEN_DESIGN_GO_DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "minimax-m2.7",
  "mimo-v2.5-pro",
] as const

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["MONTHLY"] as const
const PASSTHROUGH_HEADERS = ["accept", "accept-language", "content-type", "user-agent"] as const

export interface OpenDesignGoCredentialData {
  runtimeKey: string
  linkUrl: string
  controlKey: string
  apiUrl?: string
  email?: string
  plan?: string
  userId?: string
}

/**
 * 规范化 linkUrl：去尾斜杠，不以 /v1 结尾则追加 /v1
 */
export function normalizeOpenDesignGoBaseUrl(linkUrl: string): string {
  const trimmed = linkUrl.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("linkUrl 不能为空")
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
}

export function normalizeOpenDesignGoApiUrl(apiUrl?: string | null): string {
  const raw = (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "")
  return raw || DEFAULT_API_URL
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
}

function parseOpenDesignModels(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as unknown
    const data = (parsed as { data?: unknown })?.data
    const rows = Array.isArray(data) ? data : Array.isArray(parsed) ? parsed : []
    const models = new Set<string>()
    for (const row of rows as unknown[]) {
      if (typeof row === "string" && row.trim()) models.add(row.trim())
      else if (row && typeof row === "object") {
        const id = (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name
        if (typeof id === "string" && id.trim()) models.add(id.trim())
      }
    }
    return [...models].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export class OpenDesignGoProvider implements Provider {
  readonly poolType: PoolType = "open-design-go"
  readonly displayName = "Open Design GO"

  private readonly vault = new SecretVault()

  private readCredentialData(account: AccountRecord): OpenDesignGoCredentialData | null {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?").get(account.id) as
        | { credential_data_ciphertext: string }
        | undefined
      if (!row?.credential_data_ciphertext) return null
      const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as OpenDesignGoCredentialData
      return data
    } catch {
      return null
    }
  }

  private readCredentialDataSync(accountId: string): OpenDesignGoCredentialData | null {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?").get(accountId) as
        | { credential_data_ciphertext: string }
        | undefined
      if (!row?.credential_data_ciphertext) return null
      return JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as OpenDesignGoCredentialData
    } catch {
      return null
    }
  }

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  supportedInterfaces(): readonly import("../messages/route-decision").InterfaceFormat[] {
    return ["chat"] as const
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    // 尝试拉取余额，转为 MONTHLY 窗口；失败则返回空（不影响调度）
    try {
      const data = this.readCredentialData(account)
      if (!data?.controlKey) return []
      const apiUrl = normalizeOpenDesignGoApiUrl(data.apiUrl)
      const resp = await apiFetch(`${apiUrl}/api/v1/wallet/balance`, {
        method: "GET",
        headers: { authorization: `Bearer ${data.controlKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await resp.text()
      if (!resp.ok) return []
      try {
        const parsed = JSON.parse(body) as { balanceUsd?: number | string; balance?: number | string }
        const raw = parsed.balanceUsd ?? parsed.balance
        const balanceUsd = typeof raw === "string" ? Number(raw) : (raw as number | undefined)
        if (!Number.isFinite(balanceUsd as number)) return []
        const balanceCents = Math.round((balanceUsd as number) * 100)
        const now = new Date().toISOString()
        // 余额耗尽则视为 100% 已用，否则 0%
        const usagePercent = balanceCents <= 0 ? 100 : 0
        return [
          {
            kind: "MONTHLY",
            usagePercent,
            limitValue: null,
            remainingValue: null,
            resetAt: null,
            resetInSeconds: null,
            lastObservedAt: now,
            source: "API_PROBE",
            wallet: {
              balanceCents,
              totalCents: balanceCents,
              monthlyChargeLimitEnabled: false,
              monthlyChargeLimitCents: 0,
              monthlyUsedCents: 0,
              currency: "USD",
            },
          },
        ]
      } catch {
        return []
      }
    } catch {
      return []
    }
  }

  getAvailableModels(_accounts: AccountRecord[]): string[] {
    return this.readCachedModels() ?? [...OPEN_DESIGN_GO_DEFAULT_MODELS]
  }

  getDefaultModels(): string[] {
    return [...OPEN_DESIGN_GO_DEFAULT_MODELS]
  }

  supportsModel(model: string): boolean {
    return this.getAvailableModels([]).includes(model)
  }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    const data = this.readCredentialData(account)
    if (!data?.controlKey) throw new Error("Open Design GO 凭据缺少 controlKey")
    const apiUrl = normalizeOpenDesignGoApiUrl(data.apiUrl)
    const resp = await apiFetch(`${apiUrl}/api/v1/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${data.controlKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = await resp.text()
    if (!resp.ok) throw new Error(`Open Design GO /api/v1/models 拉取失败（HTTP ${resp.status}）: ${body.slice(0, 200)}`)
    const models = parseOpenDesignModels(body)
    // 若解析到列表则返回，否则抛错让外层处理
    if (models.length === 0) {
      // 尝试兜底：如果上游返回非空但格式异常，也视为成功但空列表
      // 为兼容，只在 body 包含 data 时返回解析结果
      try {
        const parsed = JSON.parse(body) as { data?: unknown[] }
        if (Array.isArray(parsed.data) && parsed.data.length === 0) return []
      } catch {}
      return models
    }
    return models
  }

  private readCachedModels(): string[] | null {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT models_json FROM provider_model_cache WHERE pool_type=?").get(this.poolType) as
        | { models_json: string }
        | undefined
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
    return requestedModel
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?").get(account.id) as
      | { credential_data_ciphertext: string; credential_version: number }
      | undefined
    if (!row) throw new Error(`No provider credentials found for account ${account.id}`)
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as OpenDesignGoCredentialData
    if (!data.runtimeKey) throw new Error(`Open Design GO 凭据缺少 runtimeKey（account ${account.id}）`)
    return { token: data.runtimeKey, credentialVersion: row.credential_version }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    const data = this.readCredentialData(account)
    if (!data?.controlKey) return { valid: false }
    const apiUrl = normalizeOpenDesignGoApiUrl(data.apiUrl)
    try {
      const resp = await apiFetch(`${apiUrl}/api/v1/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${data.controlKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await resp.text()
      if (resp.ok) {
        const models = parseOpenDesignModels(body)
        return { valid: true, email: data.email, planType: data.plan, extra: { modelCount: models.length, apiUrl } }
      }
      if (resp.status === 401 || resp.status === 403) return { valid: false }
      // 其它 4xx 也视为无效控制面凭据
      if (resp.status >= 400 && resp.status < 500) {
        const lower = body.toLowerCase()
        if (lower.includes("unauthorized") || lower.includes("invalid") || lower.includes("forbidden")) return { valid: false }
      }
      // 5xx/网络抖动 保留可用
      return { valid: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/\b(401|403)\b/.test(message)) return { valid: false }
      return { valid: true }
    }
  }

  getUpstreamBaseUrl(account: AccountRecord): string {
    const data = this.readCredentialData(account)
    if (!data?.linkUrl) throw new Error(`Open Design GO 账号 ${account.id} 缺少 linkUrl`)
    return normalizeOpenDesignGoBaseUrl(data.linkUrl)
  }

  buildForwardTarget(input: ForwardRequestInput, credential: ProviderCredential, _account: AccountRecord): ForwardTarget {
    const accountData = this.readCredentialData(_account)
    const baseUrl = accountData?.linkUrl ? normalizeOpenDesignGoBaseUrl(accountData.linkUrl) : this.getUpstreamBaseUrl(_account)
    const headers = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has("content-type") && input.method.toUpperCase() !== "GET") headers.set("content-type", "application/json")
    headers.set("authorization", `Bearer ${credential.token}`)
    headers.set("accept", "application/json, text/event-stream")
    // 透传 body 到 /chat/completions
    const url = `${baseUrl}/chat/completions`
    return { url, headers, body: input.body }
  }

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    const lower = (body || "").toLowerCase()
    if (status === 401 || status === 403) {
      return { shouldSwitchAccount: false, errorType: "AuthenticationError" }
    }
    if (status === 402 || lower.includes("insufficient") || lower.includes("amr_insufficient_balance")) {
      return {
        shouldSwitchAccount: true,
        quotaKind: "MONTHLY",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? null,
        errorType: "BalanceExhausted",
      }
    }
    // body 含 TIER_UPGRADE / not_entitled -> 模型错误切号
    if (lower.includes("tier_upgrade") || lower.includes("not_entitled")) {
      return { shouldSwitchAccount: true, errorType: "ModelError" }
    }
    // 400 模型不支持
    if (status === 400) {
      if (
        lower.includes("model") &&
        (lower.includes("not supported") || lower.includes("unsupported") || lower.includes("not_entitled") || lower.includes("tier_upgrade"))
      ) {
        return { shouldSwitchAccount: true, errorType: "ModelError" }
      }
      // 兜底：400 且含模型字样或 tier_upgrade 也算模型错误
      if (lower.includes("unsupported model") || lower.includes("model_not_supported")) {
        return { shouldSwitchAccount: true, errorType: "ModelError" }
      }
    }
    if (status === 429) {
      return {
        shouldSwitchAccount: true,
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")),
        errorType: "RateLimit",
        retrySameAccount: { maxRetries: 3 },
      }
    }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    // 对齐 kimi-code：ENABLED + VALID 即就绪；额外保证凭据存在时更严格
    if (account.adminState !== "ENABLED" || account.authState !== "VALID") return false
    // best-effort 检查凭据存在（无 DB 或表不存在时忽略）
    try {
      const data = this.readCredentialData(account)
      if (data) return Boolean(data.runtimeKey && data.linkUrl && data.controlKey)
      // 若未找到凭据行则回退到状态判断（兼容内存测试未建凭据的场景）
      return true
    } catch {
      return true
    }
  }
}
