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

/** 账户钱包余额（美分），来自上游 /usages 类余额接口；非金额类窗口为 null。 */
export interface QuotaWallet {
  /** 剩余余额（美分）。 */
  balanceCents: number
  /** 总余额（美分）。 */
  totalCents: number
  /** 是否启用了月度消费上限。 */
  monthlyChargeLimitEnabled: boolean
  /** 月度消费上限（美分）；0 表示不限额。 */
  monthlyChargeLimitCents: number
  /** 本月已消费（美分）。 */
  monthlyUsedCents: number
  /** ISO 货币代码，如 USD / CNY。 */
  currency: string
}

export interface QuotaWindow {
  kind: QuotaKind
  usagePercent: number
  resetAt: string | null
  resetInSeconds: number | null
  lastObservedAt: string
  source: "DASHBOARD" | "UPSTREAM_429" | "UPSTREAM_HEADER" | "API_PROBE" | "LOCAL_USAGE"
  limitValue?: number | null
  remainingValue?: number | null
  unit?: string | null
  /** 附加的钱包余额；仅当该窗口同时携带账户余额时存在。 */
  wallet?: QuotaWallet | null
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
  /** Optional endpoint-level capability check for catalogs containing non-chat models. */
  supportsEndpoint?(model: string, endpoint: string): boolean
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
