import type { AccountRecord, QuotaKind } from "../types"

// Pool Type

export const POOL_TYPES = ["opencode-go", "openai", "xai-grok", "kimi-code"] as const
export type BuiltinPoolType = (typeof POOL_TYPES)[number]
export type PoolType = BuiltinPoolType | `custom:${string}`

export const POOL_TYPE_LABELS: Record<BuiltinPoolType, string> = {
  "opencode-go": "OpenCode Go",
  "openai": "OpenAI",
  "xai-grok": "xAI Grok",
  "kimi-code": "Kimi Code",
}

// Quota

export interface QuotaWindow {
  kind: QuotaKind
  usagePercent: number
  resetAt: string | null
  resetInSeconds: number | null
  lastObservedAt: string
  source: "DASHBOARD" | "UPSTREAM_429" | "UPSTREAM_HEADER" | "API_PROBE" | "LOCAL_USAGE"
  limitValue?: number | null
  remainingValue?: number | null
}

// Credential

export interface ProviderCredential {
  token: string
  extraHeaders?: Record<string, string>
  credentialVersion: number
}

// Upstream Error Classification

export interface UpstreamErrorClassification {
  shouldSwitchAccount: boolean
  quotaKind?: QuotaKind
  retryAfterSeconds?: number | null
  errorType: string
  permanentlyDisableAccount?: boolean
}

// Forward Request

export interface ForwardRequestInput {
  method: string
  endpoint: string
  model: string
  upstreamModel: string
  body: Uint8Array<ArrayBuffer> | null
  headers: Headers
  signal: AbortSignal
}

export interface ForwardTarget {
  url: string
  headers: Headers
  body: Uint8Array<ArrayBuffer> | null
}

// Provider Interface

export interface Provider {
  readonly poolType: PoolType
  readonly displayName: string
  supportedQuotaKinds(): readonly QuotaKind[]
  refreshQuota(accountId: string, account: AccountRecord): Promise<QuotaWindow[]>
  getAvailableModels(accounts: AccountRecord[]): string[]
  /** Static bootstrap catalog used before a remote /models sync succeeds. */
  getDefaultModels?(): string[]
  resolveModel(account: AccountRecord, requestedModel: string): string
  /** Whether this provider can serve the requested model. Defaults to catalog membership when omitted. */
  supportsModel?(model: string, accounts?: AccountRecord[]): boolean
  /**
   * Optional live catalog fetch using a ready account credential.
   * Return null when this provider cannot list models remotely.
   */
  fetchRemoteModels?(account: AccountRecord): Promise<string[] | null>
  getCredential(account: AccountRecord): Promise<ProviderCredential>
  validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }>
  getUpstreamBaseUrl(account: AccountRecord): string
  buildForwardTarget(input: ForwardRequestInput, credential: ProviderCredential, account: AccountRecord): ForwardTarget
  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null
  extractQuotaFromResponse?(headers: Headers): QuotaWindow[] | null
  isAccountReady(account: AccountRecord): boolean
}

// Pool Type Metadata

export interface PoolTypeMeta {
  type: PoolType
  label: string
  description: string
  quotaKinds: readonly QuotaKind[]
  credentialFields: { key: string; label: string; required: boolean; type: "text" | "password" | "textarea" }[]
}
