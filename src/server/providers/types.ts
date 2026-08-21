import type { AccountRecord, QuotaKind } from "../types"
import type { InterfaceFormat } from "../messages/route-decision"

// Pool Type

export const POOL_TYPES = ["opencode-go", "openai", "xai-grok", "kimi-code", "open-design-go"] as const
export type BuiltinPoolType = (typeof POOL_TYPES)[number]
export type PoolType = BuiltinPoolType | `custom:${string}`

export const POOL_TYPE_LABELS: Record<BuiltinPoolType, string> = {
  "opencode-go": "OpenCode Go",
  "openai": "OpenAI",
  "xai-grok": "xAI Grok",
  "kimi-code": "Kimi Code",
  "open-design-go": "Open Design GO",
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
  /** 附加的结构化信息（如订阅周期、会员档位）；随窗口原样透传给管理端展示。 */
  extra?: Record<string, unknown> | null
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
  /**
   * 遇到该错误时先在相同账号上指数退避重试，全部失败后再按
   * shouldSwitchAccount 切账号。maxRetries 是“重试次数”：第 1 次失败后
   * 还能再重试 maxRetries 次（即最多产生 maxRetries 次额外尝试）。
   * 硬配额耗尽类错误（FIVE_HOUR/WEEKLY 等）不应携带此字段，保持直接切账号；
   * 瞬时限流（如 PROVIDER_RATE_LIMIT）可携带，先同号退避重试，用尽后再切号。
   */
  retrySameAccount?: { maxRetries: number }
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
   * 上游原生支持的接口格式（chat / responses / messages）。未声明时网关
   * 不做格式决策，保持现状直通。
   */
  /**
   * 账号原生支持的上游接口格式。可选 model 参数：某些 provider（如 opencode-go）
   * 按模型支持不同端点（gpt 系走 responses，其余走 chat/messages），可据此返回差异能力。
   */
  supportedInterfaces?(model?: string): readonly InterfaceFormat[]
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
