/**
 * OpenAI Codex Provider
 *
 * Unified pool for OpenAI Codex accounts: Personal Access Tokens (at-*) and
 * OAuth accounts with refresh tokens. Refresh is applied automatically when
 * refreshToken is present. Upstream: chatgpt.com/backend-api/codex.
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

// ─── Constants ───────────────────────────────────────────────────────────

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENAI_PAT_WHOAMI_URL = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami"
const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex"
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com"
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_USER_AGENT = "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color"

// Windows with limit_window_seconds <= 21600 (6h) are classified as 5h;
// anything larger is weekly.
const FIVE_HOUR_THRESHOLD_SECONDS = 21600
const FIVE_HOUR_THRESHOLD_MINUTES = 360

const REQUEST_TIMEOUT_MS = 20000

const CODEX_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4-mini",
  "gpt-5.4-codex",
  "o3",
  "o4-mini",
  "codex-mini-latest",
] as const

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY"]

export async function exchangeOpenAIRefreshToken(
  refreshToken: string,
  clientId = OPENAI_CLIENT_ID,
): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: string
}> {
  const resp = await apiFetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId || OPENAI_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await resp.text()
  if (!resp.ok) throw new Error(`OpenAI refresh token 刷新失败（HTTP ${resp.status}）`)
  const token = JSON.parse(body) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!token.access_token) throw new Error("OpenAI refresh token 响应缺少 access_token")
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    expiresAt: String(Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600)),
  }
}


// Headers forwarded from the incoming request to the upstream.
const PASSTHROUGH_HEADERS = [
  "accept",
  "accept-language",
  "conversation_id",
  "session_id",
  "openai-beta",
] as const

// ─── Upstream Response Types ─────────────────────────────────────────────

interface RateLimitWindowData {
  used_percent: number
  limit_window_seconds: number
  reset_after_seconds: number
  reset_at: number
}

interface RateLimitEnvelope {
  allowed?: boolean
  limit_reached?: boolean
  primary_window?: RateLimitWindowData | null
  secondary_window?: RateLimitWindowData | null
}

interface UsageResponseBody {
  rate_limit?: RateLimitEnvelope
  rate_limit_reached?: boolean
}

interface WhoamiResponseBody {
  email?: string
  chatgpt_user_id?: string
  chatgpt_account_id?: string
  chatgpt_plan_type?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function classifyWindowBySeconds(limitWindowSeconds: number): QuotaKind {
  return limitWindowSeconds <= FIVE_HOUR_THRESHOLD_SECONDS ? "FIVE_HOUR" : "WEEKLY"
}

function classifyWindowByMinutes(windowMinutes: number): QuotaKind {
  return windowMinutes <= FIVE_HOUR_THRESHOLD_MINUTES ? "FIVE_HOUR" : "WEEKLY"
}

function toISOFromUnixSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function toISOFromNowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function parseNumberFromHeader(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Given two rate-limit windows, determine which one triggered the 429 and
 * return its quotaKind and reset_after_seconds. Falls back to the primary
 * window when neither is clearly exhausted.
 */
function identifyExhaustedWindow(
  primary: RateLimitWindowData | null | undefined,
  secondary: RateLimitWindowData | null | undefined,
): { quotaKind: QuotaKind; resetAfterSeconds: number | null } {
  if (!primary && !secondary) {
    return { quotaKind: "FIVE_HOUR", resetAfterSeconds: null }
  }
  if (primary && secondary) {
    const pExhausted = primary.used_percent >= 100
    const sExhausted = secondary.used_percent >= 100
    if (pExhausted && !sExhausted) {
      return {
        quotaKind: classifyWindowBySeconds(primary.limit_window_seconds),
        resetAfterSeconds: primary.reset_after_seconds,
      }
    }
    if (sExhausted && !pExhausted) {
      return {
        quotaKind: classifyWindowBySeconds(secondary.limit_window_seconds),
        resetAfterSeconds: secondary.reset_after_seconds,
      }
    }
    // Both exhausted (or neither): pick the smaller window (typically 5h).
    const smaller =
      primary.limit_window_seconds <= secondary.limit_window_seconds ? primary : secondary
    return {
      quotaKind: classifyWindowBySeconds(smaller.limit_window_seconds),
      resetAfterSeconds: smaller.reset_after_seconds,
    }
  }
  // Only one window present.
  const window = primary ?? secondary!
  return {
    quotaKind: classifyWindowBySeconds(window.limit_window_seconds),
    resetAfterSeconds: window.reset_after_seconds,
  }
}

// ─── Provider ────────────────────────────────────────────────────────────

export class OpenAICPAProvider implements Provider {
  readonly poolType: PoolType = "openai"
  readonly displayName = "OpenAI"

  constructor() {}

  private readonly vault = new SecretVault()

  // ── Token Refresh ─────────────────────────────────────────────────────

  private async refreshTokenIfNeeded(credential: ProviderCredential, accountId: string): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?").get(accountId) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) return credential
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as Record<string, string>

    // No refresh_token → AT token, no refresh needed.
    if (!data.refreshToken) return credential

    // Check if token is expired or about to expire (within 3 minutes).
    const expiresAt = data.expiresAt ? Number(data.expiresAt) : 0
    const now = Date.now()
    if (expiresAt && now < (expiresAt - 180) * 1000) return credential // Still valid

    // Refresh the token
    try {
      const resp = await apiFetch(OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: data.refreshToken,
          client_id: data.clientId || OPENAI_CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!resp.ok) return credential // If refresh fails, try with current token
      const tokenResp = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
      if (!tokenResp.access_token) return credential

      // Update stored credentials
      data.token = tokenResp.access_token
      if (tokenResp.refresh_token) data.refreshToken = tokenResp.refresh_token
      if (tokenResp.expires_in) data.expiresAt = String(Math.floor(now / 1000) + tokenResp.expires_in)
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)

      const extraHeaders = credential.extraHeaders ?? {}
      return { token: tokenResp.access_token, extraHeaders, credentialVersion: row.credential_version + 1 }
    } catch {
      return credential // If refresh fails, try with current token
    }
  }

  // ── Credential Management ──────────────────────────────────────────────

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db
      .prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined

    if (!row) {
      throw new Error(`No provider credentials found for account ${account.id}`)
    }

    const decrypted = this.vault.decrypt(row.credential_data_ciphertext)
    const data = JSON.parse(decrypted) as ProviderAccountData

    if (!data.token) {
      throw new Error(`No token in provider credentials for account ${account.id}`)
    }

    const chatgptAccountId = data.chatgptAccountId ?? ""
    const extraHeaders: Record<string, string> = {}
    if (chatgptAccountId) {
      extraHeaders["chatgpt-account-id"] = chatgptAccountId
    }

    const credential: ProviderCredential = {
      token: data.token,
      extraHeaders,
      credentialVersion: row.credential_version,
    }

    // If this account has a refresh_token, check if we need to refresh before returning.
    return this.refreshTokenIfNeeded(credential, account.id)
  }

  async validateCredential(
    account: AccountRecord,
  ): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    const credential = await this.getCredential(account)

    const resp = await apiFetch(OPENAI_PAT_WHOAMI_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        accept: "application/json",
        originator: "codex_cli_rs",
        "user-agent": CODEX_USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false }
    }
    if (!resp.ok) {
      return { valid: false }
    }

    const body = (await resp.json()) as WhoamiResponseBody

    return {
      valid: true,
      email: body.email,
      planType: body.chatgpt_plan_type,
      extra: {
        chatgptUserId: body.chatgpt_user_id,
        chatgptAccountId: body.chatgpt_account_id,
      },
    }
  }

  // ── Quota Management ───────────────────────────────────────────────────

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  async refreshQuota(accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    const credential = await this.getCredential(account)
    const chatgptAccountId = credential.extraHeaders?.["chatgpt-account-id"] ?? accountId

    const resp = await apiFetch(CHATGPT_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "chatgpt-account-id": chatgptAccountId,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!resp.ok) return []

    const body = (await resp.json()) as UsageResponseBody
    const now = new Date().toISOString()
    const windows: QuotaWindow[] = []

    const primary = body.rate_limit?.primary_window
    const secondary = body.rate_limit?.secondary_window

    if (primary) {
      windows.push({
        kind: classifyWindowBySeconds(primary.limit_window_seconds),
        usagePercent: primary.used_percent,
        resetAt: primary.reset_at ? toISOFromUnixSeconds(primary.reset_at) : null,
        resetInSeconds: primary.reset_after_seconds,
        lastObservedAt: now,
        source: "DASHBOARD",
      })
    }

    if (secondary) {
      windows.push({
        kind: classifyWindowBySeconds(secondary.limit_window_seconds),
        usagePercent: secondary.used_percent,
        resetAt: secondary.reset_at ? toISOFromUnixSeconds(secondary.reset_at) : null,
        resetInSeconds: secondary.reset_after_seconds,
        lastObservedAt: now,
        source: "DASHBOARD",
      })
    }

    return windows
  }

  extractQuotaFromResponse(headers: Headers): QuotaWindow[] | null {
    const primaryUsed = headers.get("x-codex-primary-used-percent")
    const primaryReset = headers.get("x-codex-primary-reset-after-seconds")
    const primaryWindowMinutes = headers.get("x-codex-primary-window-minutes")
    const secondaryUsed = headers.get("x-codex-secondary-used-percent")
    const secondaryReset = headers.get("x-codex-secondary-reset-after-seconds")
    const secondaryWindowMinutes = headers.get("x-codex-secondary-window-minutes")

    const hasPrimary = primaryWindowMinutes !== null || primaryUsed !== null
    const hasSecondary = secondaryWindowMinutes !== null || secondaryUsed !== null

    if (!hasPrimary && !hasSecondary) return null

    const now = new Date().toISOString()
    const windows: QuotaWindow[] = []

    if (hasPrimary && primaryWindowMinutes !== null) {
      const windowMinutes = parseInt(primaryWindowMinutes, 10)
      const resetSeconds = parseNumberFromHeader(primaryReset)
      windows.push({
        kind: classifyWindowByMinutes(windowMinutes),
        usagePercent: primaryUsed ? parseFloat(primaryUsed) : 0,
        resetAt: resetSeconds !== null ? toISOFromNowPlusSeconds(resetSeconds) : null,
        resetInSeconds: resetSeconds,
        lastObservedAt: now,
        source: "UPSTREAM_HEADER",
      })
    }

    if (hasSecondary && secondaryWindowMinutes !== null) {
      const windowMinutes = parseInt(secondaryWindowMinutes, 10)
      const resetSeconds = parseNumberFromHeader(secondaryReset)
      windows.push({
        kind: classifyWindowByMinutes(windowMinutes),
        usagePercent: secondaryUsed ? parseFloat(secondaryUsed) : 0,
        resetAt: resetSeconds !== null ? toISOFromNowPlusSeconds(resetSeconds) : null,
        resetInSeconds: resetSeconds,
        lastObservedAt: now,
        source: "UPSTREAM_HEADER",
      })
    }

    return windows.length > 0 ? windows : null
  }

  // ── Models ─────────────────────────────────────────────────────────────

  getAvailableModels(_accounts: AccountRecord[]): string[] {
    return this.readCachedModels() ?? [...CODEX_MODELS]
  }

  getDefaultModels(): string[] {
    return [...CODEX_MODELS]
  }

  supportsModel(model: string): boolean {
    return this.getAvailableModels([]).includes(model)
  }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    // Codex backend does not expose a stable public /models list for PAT/OAuth.
    // Keep defaults; callers still get a deterministic catalog.
    void account
    return null
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
    return requestedModel
  }

  // ── Upstream Forwarding ────────────────────────────────────────────────

  getUpstreamBaseUrl(_account: AccountRecord): string {
    return CODEX_UPSTREAM_BASE_URL
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    const baseUrl = this.getUpstreamBaseUrl(_account)
    const url = `${baseUrl}/${input.endpoint}`

    const headers = new Headers()
    headers.set("Authorization", `Bearer ${credential.token}`)

    const chatgptAccountId = credential.extraHeaders?.["chatgpt-account-id"]
    if (chatgptAccountId) {
      headers.set("chatgpt-account-id", chatgptAccountId)
    }

    headers.set("codex-beta", "codex-1")
    headers.set("originator", "Codex Desktop")
    headers.set("user-agent", CODEX_USER_AGENT)

    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }

    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }

    return {
      url,
      headers,
      body: input.body,
    }
  }

  // ── Error Classification ───────────────────────────────────────────────

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    if (status === 429) {
      return this.classify429(body, headers)
    }
    if (status === 401 || status === 403) {
      return {
        shouldSwitchAccount: false,
        errorType: "AuthenticationError",
      }
    }
    return null
  }

  private classify429(body: string, headers: Headers): UpstreamErrorClassification | null {
    let parsed: UsageResponseBody
    try {
      parsed = JSON.parse(body) as UsageResponseBody
    } catch {
      // Non-JSON 429 body — treat as a generic rate limit and switch account.
      const retryAfterHeader = headers.get("retry-after")
      return {
        shouldSwitchAccount: true,
        quotaKind: "FIVE_HOUR",
        retryAfterSeconds: retryAfterHeader ? parseInt(retryAfterHeader, 10) : null,
        errorType: "RateLimitError",
      }
    }

    // Only switch account when upstream explicitly signals rate_limit_reached.
    if (!parsed.rate_limit_reached) {
      return null
    }

    const { quotaKind, resetAfterSeconds } = identifyExhaustedWindow(
      parsed.rate_limit?.primary_window,
      parsed.rate_limit?.secondary_window,
    )

    // Prefer the retry-after header; fall back to the window's reset_after_seconds.
    const retryAfterHeader = headers.get("retry-after")
    const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : resetAfterSeconds

    return {
      shouldSwitchAccount: true,
      quotaKind,
      retryAfterSeconds,
      errorType: "RateLimitError",
    }
  }

  // ── Account Readiness ──────────────────────────────────────────────────

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}
