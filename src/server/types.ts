export const ADMIN_STATES = ["ENABLED", "DISABLED"] as const
export const AUTH_STATES = ["VALID", "REAUTH_REQUIRED", "AUTH_ERROR"] as const
export const SUBSCRIPTION_STATES = ["ACTIVE", "INACTIVE", "VERIFY_ERROR"] as const
export const BILLING_GUARDS = ["VERIFIED_GO_ONLY", "PAYG_FALLBACK_ENABLED", "UNVERIFIED"] as const
// ROLLING_24H is the xAI Grok free-tier rolling 24h token window (limit 1,000,000 tokens).
const _ROLLING_24H = "ROLLING_24H"
export const QUOTA_KINDS = ["PERMANENT", "FIVE_HOUR", "WEEKLY", "MONTHLY", "CUSTOM_PERIOD", "UNKNOWN_GO_LIMIT", _ROLLING_24H, "PROVIDER_RATE_LIMIT"] as const

export const POOL_TYPES = ["opencode-go", "openai", "xai-grok", "kimi-code", "open-design-go", "glm-coding"] as const
export type BuiltinPoolType = (typeof POOL_TYPES)[number]
export type PoolType = BuiltinPoolType | `custom:${string}`

export type AdminState = (typeof ADMIN_STATES)[number]
export type AuthState = (typeof AUTH_STATES)[number]
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]
export type BillingGuard = (typeof BILLING_GUARDS)[number]
export type QuotaKind = (typeof QUOTA_KINDS)[number]
export type UserRole = "ADMIN" | "USER"
export type UserStatus = "ACTIVE" | "DISABLED"

export const ACCOUNT_ROUTE_STATES = [
  "READY",
  "TEMP_BLOCKED",
  "SPENDING_BLOCKED",
  "CREDENTIAL_INVALID",
  "ADMIN_DISABLED",
  "UPSTREAM_BANNED",
  "SUBSCRIPTION_INACTIVE",
  "BILLING_UNSAFE",
  "UNAVAILABLE",
] as const
export type AccountRouteState = (typeof ACCOUNT_ROUTE_STATES)[number]

export interface UserRecord {
  id: string
  username: string
  displayName: string
  role: UserRole
  status: UserStatus
  createdAt: string
  updatedAt: string
  githubId?: string | null
}

export interface AccountRecord {
  id: string
  ownerUserId: string
  name: string
  poolType: PoolType
  workspaceId: string
  email: string | null
  goKeyId: string
  credentialSource: string
  extensionVersion: string | null
  lastSyncedAt: string
  adminState: AdminState
  authState: AuthState
  subscriptionState: SubscriptionState
  goSubscriptionId: string | null
  isZenSubscribed: boolean
  zenSubscriptionId: string | null
  hasManageSubscriptionButton: boolean
  billingGuard: BillingGuard
  useBalance: boolean | null
  useChinaProviders: boolean
  allowTraining: boolean
  credentialVersion: number
  lastUsageCheckAt: string | null
  nextUsageCheckAt: string
  lastSelectedAt: string | null
  lastRequestAt: string | null
  lastSuccessAt: string | null
  lastLimitAt: string | null
  disabledReason: string | null
  disabledAt: string | null
  lastError: string | null
  externalId: string | null
  maxConcurrency: number
  ordinal: number
  createdAt: string
  updatedAt: string
}

export interface AccountCredential extends AccountRecord {
  authCookie: string
  goApiKey: string
}

export interface ProviderAccountData {
  // Generic encrypted credential storage for non-OpenCode providers
  // For openai (AT token or OAuth): { token, refreshToken?, expiresAt?, clientId?, chatgptAccountId, planType }
  // For xai-grok (xAI free OAuth): { token, refreshToken, expiresAt, clientId, email, subscriptionTier, entitlementStatus }
  // For kimi-code (Kimi Code OAuth device flow): { token, refreshToken, expiresAt, expiresIn, clientId, email, subject }
  token?: string
  refreshToken?: string
  expiresAt?: string
  clientId?: string
  chatgptAccountId?: string
  planType?: string
  email?: string
  subscriptionTier?: string
  entitlementStatus?: string
  extraHeaders?: Record<string, string>
  /** kimi-code：token 有效期秒数，用于按官方 defaultRefreshThreshold 提前刷新。 */
  expiresIn?: string
  /** kimi-code：refresh_token 被上游拒绝的时间（ISO）。存在即凭据已失效，需重新登录。 */
  revokedAt?: string
  /** kimi-code：/me 返回的账号信息（best-effort 补充）。 */
  kimiUserId?: string
  kimiNickname?: string
  region?: string
  domainName?: string
  userLevel?: string
  /** glm-coding：凭据来源（"oauth" = ZCode 设备流自动兑换 | "apikey" = 控制台手建）。 */
  authMode?: string
  /** glm-coding：每账号生成一次并持久化的 hex 设备 ID（ZCode 指纹 X-Device-Mid）。 */
  deviceMid?: string
  /** glm-coding：ZCode plan JWT（OAuth 附带，元数据留存）。 */
  zcodeJwt?: string
  /** glm-coding：OAuth user_id（external_id 去重键之一）。 */
  glmUserId?: string
  /** glm-coding：monitor usage 返回的套餐等级（如 pro）。 */
  glmLevel?: string
}

export interface ModelRouteRule {
  id: string
  ownerUserId: string
  modelPattern: string
  poolTypePriority: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface UpstreamTarget {
  baseUrl: string
  authStyle: "BEARER"
}

export interface RouteSelection {
  account: AccountRecord
  leaseId: string
  target: UpstreamTarget
}

export interface QuotaSnapshot {
  accountId: string
  kind: QuotaKind
  usagePercent: number
  resetAt: string | null
  lastObservedAt: string
  source: "DASHBOARD" | "UPSTREAM_429" | "UPSTREAM_HEADER" | "API_PROBE" | "LOCAL_USAGE"
  limitValue?: number | null
  remainingValue?: number | null
  unit?: string | null
}
