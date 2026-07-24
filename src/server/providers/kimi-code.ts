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
  kimiCodeBaseUrl,
  KIMI_CODE_CLIENT_ID,
  refreshKimiAccessToken,
  type KimiUsageRow,
} from "../kimi-oauth"

const REQUEST_TIMEOUT_MS = 30_000
const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY"]
const DEFAULT_MODELS = ["kimi-for-coding"] as const
const PASSTHROUGH_HEADERS = ["accept-language", "anthropic-version", "anthropic-beta"] as const

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
    const now = Date.now()
    // Refresh when missing or within 5 minutes of expiry (kimi-code threshold floor).
    if (data.token && expiresAt && now < (expiresAt - 300) * 1000) return credential

    try {
      const token = await refreshKimiAccessToken(data.refreshToken, data.clientId || KIMI_CODE_CLIENT_ID)
      data.token = token.accessToken
      data.refreshToken = token.refreshToken
      data.expiresAt = String(token.expiresAt)
      if (token.scope) data.extraHeaders = { ...(data.extraHeaders || {}), scope: token.scope }
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
      return {
        token: token.accessToken,
        extraHeaders: credential.extraHeaders ?? {},
        credentialVersion: row.credential_version + 1,
      }
    } catch {
      return credential
    }
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new Error(`No provider credentials found for account ${account.id}`)
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
    if (!data.token) throw new Error(`No access token in provider credentials for account ${account.id}`)
    const credential: ProviderCredential = {
      token: data.token,
      extraHeaders: {},
      credentialVersion: row.credential_version,
    }
    return this.refreshTokenIfNeeded(credential, account.id)
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    const credential = await this.getCredential(account)
    try {
      const models = await fetchKimiModels(credential.token)
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?")
        .get(account.id) as { credential_data_ciphertext: string } | undefined
      let email: string | undefined
      if (row) {
        const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
        email = data.email
      }
      return { valid: true, email, planType: "kimi-code", extra: { modelCount: models.length } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("401") || message.includes("403") || message.includes("已失效")) {
        return { valid: false }
      }
      // Network / 5xx: keep account usable.
      return { valid: true }
    }
  }

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    void _accountId
    const credential = await this.getCredential(account)
    const usage = await fetchKimiUsage(credential.token)
    return windowsFromUsage(usage.summary, usage.limits)
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
    return fetchKimiModels(credential.token)
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
    void body
    if (status === 429) {
      return {
        shouldSwitchAccount: true,
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 30,
        errorType: "KIMI_RATE_LIMITED",
      }
    }
    if (status === 402) {
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

