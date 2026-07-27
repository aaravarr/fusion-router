/**
 * xAI Grok Free Provider
 *
 * Supports xAI free-tier Grok accounts that authenticate via OAuth (refresh
 * token grant against https://auth.x.ai/oauth2/token using the Grok CLI client
 * id). The free tier enforces a rolling 24h token window with a 1,000,000
 * token limit, surfaced via the x-ratelimit-* response headers.
 *
 * OAuth/free-tier inference is served from https://cli-chat-proxy.grok.com/v1.
 * Direct API-key accounts use api.x.ai, but that endpoint rejects CLI OAuth
 * bearer tokens. Billing/subscription metadata is also served from the CLI
 * gateway, but for free-tier
 * accounts we rely on the per-response x-ratelimit-* headers for quota, so
 * billing probing is best-effort and only used to detect the subscription tier
 * when the headers are absent.
 *
 * Constants are derived from the Wei-Shaw/sub2api reference implementation
 * (internal/pkg/xai) which is the authoritative source for these endpoints.
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
import { apiFetch, apiFetchWithMirrorContext } from "../api-fetch"

// ─── Constants ───────────────────────────────────────────────────────────

const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token"
const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
// OAuth (free-tier) accounts must go through the CLI gateway — api.x.ai/v1
// rejects CLI OAuth bearer tokens with "Access to the chat endpoint is denied".
const XAI_UPSTREAM_BASE_URL = "https://cli-chat-proxy.grok.com/v1"

const REQUEST_TIMEOUT_MS = 30000

const ACCOUNT_DENIED_MARKERS = [
  "permission-denied",
  "access to the chat endpoint is denied",
] as const

const CREDENTIAL_INVALID_MESSAGES = [
  "invalid or expired credentials",
  "no auth context",
] as const

function parsedErrorFields(body: string): { code: string | null; type: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const nested = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null
    const stringField = (value: unknown): string | null => typeof value === "string" ? value : null
    return {
      code: stringField(parsed.code) ?? stringField(nested?.code),
      type: stringField(parsed.type) ?? stringField(nested?.type),
      message: stringField(parsed.message) ?? stringField(nested?.message) ?? stringField(parsed.error),
    }
  } catch {
    return { code: null, type: null, message: body || null }
  }
}

function normalizedIdentifier(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[-_\s]/g, "")
}

export function isXaiCredentialInvalidResponse(status: number, body: string): boolean {
  if (status !== 401) return false
  const fields = parsedErrorFields(body)
  const permissionDenied = [fields.code, fields.type, fields.message].some((value) => normalizedIdentifier(value) === "permissiondenied")
  const message = (fields.message ?? "").toLowerCase()
  return permissionDenied || CREDENTIAL_INVALID_MESSAGES.some((marker) => message.includes(marker))
}

export function isXaiSpendingBlockedResponse(status: number, body: string): boolean {
  if (status !== 402) return false
  return parsedErrorFields(body).code?.trim().toLowerCase() === "personal-team-blocked:spending-limit"
}

export class XAIAccountBannedError extends Error {
  readonly status = 403
  constructor(message = "xAI 账号已被上游禁止访问") {
    super(message)
    this.name = "XAIAccountBannedError"
  }
}

export function isXaiAccountBannedResponse(status: number, body: string): boolean {
  if (status !== 403) return false
  const normalized = body.toLowerCase()
  return ACCOUNT_DENIED_MARKERS.some((marker) => normalized.includes(marker))
}

/** Free OAuth seats should not get server tools; paid/super seats may. */
export function isXaiPaidCredentialData(data: ProviderAccountData | null | undefined): boolean {
  const blob = [data?.subscriptionTier, data?.planType, data?.entitlementStatus]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")
    .toLowerCase()
  if (!blob) return false
  if (/(^|[^a-z])free([^a-z]|$)|trial|inactive|none|unpaid/.test(blob)) return false
  return /(super|premium|pro|plus|paid|enterprise|team|business|grok\s*pro)/.test(blob)
}

export function isXaiPaidAccount(accountId: string): boolean {
  try {
    const db = getDatabase()
    const row = db
      .prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?")
      .get(accountId) as { credential_data_ciphertext: string } | undefined
    if (!row?.credential_data_ciphertext) return false
    const vault = new SecretVault()
    const data = JSON.parse(vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
    return isXaiPaidCredentialData(data)
  } catch {
    return false
  }
}

export async function exchangeXaiRefreshToken(refreshToken: string, clientId = XAI_DEFAULT_CLIENT_ID): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: string
  idToken?: string
  tokenType?: string
  scope?: string
}> {
  const resp = await apiFetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId || XAI_DEFAULT_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await resp.text()
  if (!resp.ok) throw new Error(`xAI refresh token 刷新失败（HTTP ${resp.status}）`)
  const token = JSON.parse(body) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; token_type?: string; scope?: string }
  if (!token.access_token) throw new Error("xAI refresh token 响应缺少 access_token")
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    expiresAt: String(Math.floor(Date.now() / 1000) + (token.expires_in ?? 21600)),
    idToken: token.id_token,
    tokenType: token.token_type,
    scope: token.scope,
  }
}

// Grok CLI client identity — must mirror grok-api / official grok-shell.
// cli-chat-proxy gates server tools and OAuth paths on these headers.
const GROK_CLIENT_VERSION = process.env.GROK_CLIENT_VERSION?.trim() || "0.2.101"
const GROK_PRODUCT = "grok-shell"
const GROK_CLIENT_IDENTIFIER = "grok-shell"
const GROK_TOKEN_AUTH = "xai-grok-cli"
function grokUserAgent(): string {
  // Keep a stable desktop-like UA; do not forward Codex Desktop UA upstream.
  return `${GROK_PRODUCT}/${GROK_CLIENT_VERSION} (windows; x86_64)`
}

const GROK_MODELS = [
  "grok-4.5",
  "grok-4.3",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-imagine",
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-edit",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
] as const

function parseOpenAiModelList(body: string): string[] {
  const parsed = JSON.parse(body) as { data?: unknown; models?: unknown } | unknown[]
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : []
  const models = new Set<string>()
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) models.add(row.trim())
    else if (row && typeof row === "object") {
      const id = (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name
      if (typeof id === "string" && id.trim()) models.add(id.trim())
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b))
}

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["ROLLING_24H"]

// Headers forwarded from the incoming request to the upstream.
// Intentionally exclude user-agent: Codex Desktop UA must NOT replace grok-shell identity,
// otherwise cli-chat-proxy may ignore server tools (web_search/x_search).
const PASSTHROUGH_HEADERS = [
  "accept-language",
  "anthropic-version",
  "anthropic-beta",
] as const

// xAI per-response rate-limit headers we observe for quota.
const RATELIMIT_LIMIT_TOKENS = "x-ratelimit-limit-tokens"
const RATELIMIT_REMAINING_TOKENS = "x-ratelimit-remaining-tokens"
const RATELIMIT_RESET_TOKENS = "x-ratelimit-reset-tokens"
const RATELIMIT_REMAINING_REQUESTS = "x-ratelimit-remaining-requests"
const RATELIMIT_RESET_REQUESTS = "x-ratelimit-reset-requests"

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseNumberFromHeader(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function toISOFromUnixSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function secondsUntilReset(value: string | null): number | null {
  if (!value) return null
  const numeric = parseNumberFromHeader(value)
  if (numeric !== null) {
    let seconds = numeric
    if (seconds > 1_000_000_000_000) seconds = Math.floor(seconds / 1000)
    return seconds > Date.now() / 1000 ? Math.max(1, Math.ceil(seconds - Date.now() / 1000)) : null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(1, Math.ceil((parsed - Date.now()) / 1000))
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(1, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(1, Math.ceil((parsed - Date.now()) / 1000))
}

// ─── Provider ────────────────────────────────────────────────────────────

export class XAIGrokProvider implements Provider {
  readonly poolType: PoolType = "xai-grok"
  readonly displayName = "xAI Grok"

  private readonly vault = new SecretVault()

  // ── Token Refresh ─────────────────────────────────────────────────────

  /**
   * Refresh the OAuth access token when it is missing or within 3 minutes of
   * expiry. xAI access tokens live ~6h; the refresh_token is persistent and
   * rotated on each refresh (we preserve the old one when the response omits
   * a new one). Mirrors GrokOAuthService.RefreshAccountToken from sub2api.
   */
  private async refreshTokenIfNeeded(credential: ProviderCredential, accountId: string): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?").get(accountId) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) return credential
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData

    // No refresh_token → static access token, cannot refresh.
    if (!data.refreshToken) return credential

    const expiresAt = data.expiresAt ? Number(data.expiresAt) : 0
    const now = Date.now()
    // Still valid with >3min margin.
    if (data.token && expiresAt && now < (expiresAt - 180) * 1000) return credential

    try {
      const tokenResp = await exchangeXaiRefreshToken(data.refreshToken, data.clientId || XAI_DEFAULT_CLIENT_ID)
      data.token = tokenResp.accessToken
      data.refreshToken = tokenResp.refreshToken
      data.expiresAt = tokenResp.expiresAt
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)

      const extraHeaders = credential.extraHeaders ?? {}
      return { token: tokenResp.accessToken, extraHeaders, credentialVersion: row.credential_version + 1 }
    } catch {
      return credential // If refresh fails, try with the current credential.
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
      throw new Error(`No access token in provider credentials for account ${account.id}`)
    }

    const credential: ProviderCredential = {
      token: data.token,
      extraHeaders: {},
      credentialVersion: row.credential_version,
    }

    return this.refreshTokenIfNeeded(credential, account.id)
  }

  async validateCredential(
    account: AccountRecord,
  ): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    const credential = await this.getCredential(account)

    // Validate by sending a minimal /responses probe to the CLI gateway, the
    // same way sub2api probes Grok OAuth accounts. A 401/403 means invalid
    // credentials; any other non-5xx means the token is accepted.
    const resp = await apiFetchWithMirrorContext(`${XAI_UPSTREAM_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "User-Agent": grokUserAgent(),
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-client-mode": "interactive",
        "X-XAI-Token-Auth": GROK_TOKEN_AUTH,
        "x-authenticateresponse": "authenticate-response",
      },
      body: JSON.stringify({ model: "grok-4.5", input: "hi", stream: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { account })

    if (resp.status === 401 || resp.status === 403) return { valid: false }
    // 400 (bad probe body) or 429 (rate limited) still means the token was
    // accepted — only auth rejections count as invalid.
    if (resp.status >= 500) return { valid: false }

    // Retrieve stored metadata (email/tier) which we captured at import time;
    // the upstream models endpoint does not return these.
    const db = getDatabase()
    const row = db
      .prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string } | undefined
    let email: string | undefined
    let subscriptionTier: string | undefined
    let entitlementStatus: string | undefined
    if (row) {
      const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
      email = data.email
      subscriptionTier = data.subscriptionTier
      entitlementStatus = data.entitlementStatus
    }

    return {
      valid: true,
      email,
      planType: subscriptionTier,
      extra: { subscriptionTier, entitlementStatus },
    }
  }

  // ── Quota Management ───────────────────────────────────────────────────

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    // Free-tier quota headers are unreliable (often remaining=limit forever).
    // Do not spend a live probe request here; local 24h request logs are the
    // source of truth for usage, and real unavailability comes from upstream
    // errors after the account is already over 1M tokens.
    void _accountId
    void account
    return []
  }

  extractQuotaFromResponse(headers: Headers): QuotaWindow[] | null {
    const limitTokens = parseNumberFromHeader(headers.get(RATELIMIT_LIMIT_TOKENS))
    const remainingTokens = parseNumberFromHeader(headers.get(RATELIMIT_REMAINING_TOKENS))
    const resetTokensRaw = headers.get(RATELIMIT_RESET_TOKENS)

    const hasTokenWindow = limitTokens !== null || remainingTokens !== null || resetTokensRaw !== null
    if (!hasTokenWindow) return null

    const now = new Date().toISOString()
    const windows: QuotaWindow[] = []

    if (hasTokenWindow) {
      const usagePercent =
        limitTokens !== null && remainingTokens !== null
          ? roundPercent(((limitTokens - remainingTokens) / limitTokens) * 100)
          : remainingTokens !== null && remainingTokens === 0
            ? 100
            : 0
      let resetInSeconds: number | null = null
      let resetAt: string | null = null
      if (resetTokensRaw) {
        const resetUnix = parseNumberFromHeader(resetTokensRaw)
        if (resetUnix !== null) {
          // xAI returns a unix timestamp (seconds or ms).
          let secs = resetUnix
          if (secs > 1_000_000_000_000) secs = Math.floor(secs / 1000)
          if (secs < Date.now() / 1000) {
            // already in the past → treat as reset shortly
            resetInSeconds = 0
            resetAt = new Date().toISOString()
          } else {
            resetInSeconds = Math.floor(secs - Date.now() / 1000)
            resetAt = toISOFromUnixSeconds(secs)
          }
        }
      }
      windows.push({
        kind: "ROLLING_24H",
        usagePercent,
        limitValue: limitTokens,
        remainingValue: remainingTokens,
        resetAt,
        resetInSeconds,
        lastObservedAt: now,
        source: "UPSTREAM_HEADER",
      })
    }

    return windows.length > 0 ? windows : null
  }

  // ── Models ─────────────────────────────────────────────────────────────

  getAvailableModels(): string[] {
    return this.readCachedModels() ?? [...GROK_MODELS]
  }

  getDefaultModels(): string[] {
    return [...GROK_MODELS]
  }

  supportsModel(model: string): boolean {
    return this.getAvailableModels().includes(model)
  }

  supportsEndpoint(model: string, endpoint: string): boolean {
    if ((endpoint === "responses" || endpoint === "chat/completions") && model.startsWith("grok-imagine")) return false
    return this.supportsModel(model)
  }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    const credential = await this.getCredential(account)
    const resp = await apiFetchWithMirrorContext(`${XAI_UPSTREAM_BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        accept: "application/json",
        "User-Agent": grokUserAgent(),
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-client-mode": "interactive",
        "X-XAI-Token-Auth": GROK_TOKEN_AUTH,
        "x-authenticateresponse": "authenticate-response",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { account })
    const body = await resp.text()
    if (!resp.ok) throw new Error(`xAI /models 拉取失败（HTTP ${resp.status}）: ${body.slice(0, 200)}`)
    return parseOpenAiModelList(body)
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

  // ── Upstream Forwarding ────────────────────────────────────────────────

  getUpstreamBaseUrl(): string {
    return XAI_UPSTREAM_BASE_URL
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    void _account
    const baseUrl = this.getUpstreamBaseUrl()
    const url = `${baseUrl}/${input.endpoint}`

    const headers = new Headers()
    headers.set("Authorization", `Bearer ${credential.token}`)
    // Match grok-api identity exactly (see grok-api/src/client/identity.ts).
    headers.set("User-Agent", grokUserAgent())
    headers.set("x-grok-client-identifier", GROK_CLIENT_IDENTIFIER)
    headers.set("x-grok-client-version", GROK_CLIENT_VERSION)
    headers.set("x-grok-client-mode", "interactive")
    headers.set("X-XAI-Token-Auth", GROK_TOKEN_AUTH)
    headers.set("x-authenticateresponse", "authenticate-response")
    headers.set("accept", "application/json, text/event-stream")

    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }

    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }

    // Re-assert identity after any passthrough so client headers cannot clobber it.
    headers.set("User-Agent", grokUserAgent())
    headers.set("x-grok-client-identifier", GROK_CLIENT_IDENTIFIER)
    headers.set("x-grok-client-version", GROK_CLIENT_VERSION)
    headers.set("x-grok-client-mode", "interactive")
    headers.set("X-XAI-Token-Auth", GROK_TOKEN_AUTH)
    headers.set("x-authenticateresponse", "authenticate-response")

    return {
      url,
      headers,
      body: input.body,
    }
  }

  // ── Error Classification ───────────────────────────────────────────────

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    if (isXaiCredentialInvalidResponse(status, body)) {
      return {
        shouldSwitchAccount: true,
        errorType: "CREDENTIAL_INVALID",
        permanentlyDisableAccount: true,
      }
    }
    if (isXaiSpendingBlockedResponse(status, body)) {
      return {
        shouldSwitchAccount: true,
        errorType: "SPENDING_BLOCKED",
        permanentlyDisableAccount: true,
      }
    }
    if (isXaiAccountBannedResponse(status, body)) {
      return {
        shouldSwitchAccount: true,
        errorType: "XAI_ACCOUNT_BANNED",
        permanentlyDisableAccount: true,
      }
    }
    if (status === 429) {
      const retry = retryAfterSeconds(headers.get("retry-after"))
      const remainingTokens = parseNumberFromHeader(headers.get(RATELIMIT_REMAINING_TOKENS))
      const remainingRequests = parseNumberFromHeader(headers.get(RATELIMIT_REMAINING_REQUESTS))
      // A generic 429 is usually a short request/concurrency throttle. Only
      // consume the rolling token window when the upstream explicitly says
      // token remaining reached zero; otherwise we would turn a 60-second
      // cooldown into a fake 100% daily usage reading.
      const tokenQuotaExhausted = remainingTokens !== null && remainingTokens <= 0
      const backoff = tokenQuotaExhausted
        ? secondsUntilReset(headers.get(RATELIMIT_RESET_TOKENS)) ?? retry
        : secondsUntilReset(headers.get(RATELIMIT_RESET_REQUESTS)) ?? retry
      return {
        shouldSwitchAccount: true,
        quotaKind: tokenQuotaExhausted ? "ROLLING_24H" : "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: backoff,
        errorType: tokenQuotaExhausted ? "XAI_TOKEN_QUOTA_EXHAUSTED" : remainingRequests === 0 ? "XAI_REQUEST_RATE_LIMITED" : "XAI_TEMPORARILY_RATE_LIMITED",
      }
    }
    return null
  }

  // ── Account Readiness ──────────────────────────────────────────────────

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}
