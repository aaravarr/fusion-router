export type QuotaState = "available" | "blocked" | "unknown";

/** 账户钱包余额（美分），来自上游 /usages 类余额接口。 */
export interface QuotaWallet {
  balanceCents: number;
  totalCents: number;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: number;
  monthlyUsedCents: number;
  currency: string;
}

export interface QuotaWindow {
  kind?: string;
  status?: QuotaState;
  blockedAt?: string | null;
  resetAt?: string | null;
  nextProbeAt?: string | null;
  retryAfterSeconds?: number | null;
  lastObservedAt?: string | null;
  resetInSec?: number | null;
  usagePercent?: number | null;
  source?: string | null;
  limitValue?: number | null;
  remainingValue?: number | null;
  unit?: string | null;
  wallet?: QuotaWallet | null;
  /** 附加结构化信息（订阅周期、会员档位等），来自上游 billing/summary。 */
  extra?: Record<string, unknown> | null;
}

export interface Account {
  id: string;
  name?: string | null;
  email?: string | null;
  status?: string | null;
  enabled?: boolean;
  isCurrent?: boolean;
  isPreferred?: boolean;
  routingEligible?: boolean;
  routingBlocked?: boolean;
  routingBlockedUntil?: string | null;
  routeState?: "READY" | "TEMP_BLOCKED" | "SPENDING_BLOCKED" | "CREDENTIAL_INVALID" | "ADMIN_DISABLED" | "UPSTREAM_BANNED" | "SUBSCRIPTION_INACTIVE" | "BILLING_UNSAFE" | "UNAVAILABLE";
  routeReason?: string | null;
  blockedUntil?: string | null;
  billingGuard?: string | null;
  adminState?: string | null;
  authState?: string | null;
  subscriptionState?: string | null;
  goSubscriptionId?: string | null;
  isZenSubscribed?: boolean;
  zenSubscriptionId?: string | null;
  hasManageSubscriptionButton?: boolean;
  useBalance?: boolean | null;
  useChinaProviders?: boolean;
  workspaceId?: string | null;
  goKeyId?: string | null;
  credentialSource?: string | null;
  extensionVersion?: string | null;
  lastSyncedAt?: string | null;
  lastUsageCheckAt?: string | null;
  nextUsageCheckAt?: string | null;
  credentialVersion?: number | null;
  fiveHour?: QuotaWindow | null;
  weekly?: QuotaWindow | null;
  monthly?: QuotaWindow | null;
  quotas?: {
    fiveHour?: QuotaWindow | null;
    weekly?: QuotaWindow | null;
    monthly?: QuotaWindow | null;
  } | null;
  quotaWindows?: Array<QuotaWindow> | {
    fiveHour?: QuotaWindow | null;
    weekly?: QuotaWindow | null;
    monthly?: QuotaWindow | null;
  } | null;
  lastUsedAt?: string | null;
  lastRequestAt?: string | null;
  lastCheckedAt?: string | null;
  nextEligibleAt?: string | null;
  lastError?: string | null;
  disabledReason?: string | null;
  disabledAt?: string | null;
  externalId?: string | null;
  poolType?: string;
  poolLabel?: string | null;
}

export interface ApiKeyRecord {
  id: string;
  name?: string | null;
  alias?: string | null;
  prefix?: string | null;
  keyPrefix?: string | null;
  status?: string | null;
 enabled?: boolean;
 revealable?: boolean;
 createdAt?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  requestCount?: number | null;
  useCount?: number | null;
}

export interface RouteAttempt {
  id?: string;
  accountId?: string | null;
  accountName?: string | null;
  outcome?: string | null;
  reason?: string | null;
  limitName?: string | null;
  startedAt?: string | null;
  durationMs?: number | null;
}

export interface RequestRecord {
  id: string;
  endpoint?: string | null;
  createdAt?: string | null;
  model?: string | null;
  stream?: boolean;
  status?: string | number | null;
  outcome?: string | null;
  ok?: boolean;
  apiKeyPrefix?: string | null;
  apiKeyName?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  attemptCount?: number | null;
  attempts?: RouteAttempt[] | null;
  latencyMs?: number | null;
  localPrepMs?: number | null;
 firstTokenMs?: number | null;
 tps?: number | null;
 promptTokens?: number | null;
  inputTokens?: number | null;
  completionTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  textTokens?: number | null;
  imageTokens?: number | null;
  audioTokens?: number | null;
  hasRequest?: boolean;
  hasResponse?: boolean;
  client?: string | null;
  error?: string | null;
  inboundEndpoint?: string | null;
  upstreamEndpoint?: string | null;
  processMode?: string | null;
  routeMode?: string | null;
  routeReason?: string | null;
  converted?: boolean;
  transformSummary?: string | null;
  costUsd?: number | null;
  costLabel?: string | null;
  pricingModelId?: string | null;
  costBreakdown?: {
    uncachedPromptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    promptRate: number;
    cacheRate: number;
    completionRate: number;
  } | null;
}

export interface AttemptDetail {
  id: string;
  attemptNumber: number;
  accountId?: string | null;
  accountName?: string | null;
  status?: number | null;
  decision?: string;
  errorType?: string | null;
  errorMessage?: string | null;
  responseBody?: string | null;
  latencyMs?: number | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface RequestDetail {
  request: RequestRecord & {
    request?: unknown;
    requestTruncated?: boolean;
    response?: unknown;
    responseTruncated?: boolean;
    headers?: Record<string, string>;
    userAgent?: string | null;
    error?: string | null;
    localPrepMs?: number | null;
    requestSizeBytes?: number | null;
    responseSizeBytes?: number | null;
  };
  attempts: AttemptDetail[];
}


export interface AccountListStats {
  total: number;
  ready: number;
  blocked: number;
  disabled: number;
  banned: number;
  authError: number;
  inactive: number;
  overQuota: number;
  avgUsagePercent: number | null;
  byPoolType?: Record<string, { total: number; ready: number; blocked: number; inactive: number; overQuota?: number }>;
}

export interface AccountListResponse {
  items?: Account[];
  accounts?: Account[];
  total: number;
  page: number;
  pageSize: number;
  stats?: AccountListStats;
  poolPreferences?: Record<string, string | null>;
  poolTypes?: Array<{ type: string; label: string; description?: string; quotaKinds?: string[] }>;
}

export interface RequestListResponse {
  items: RequestRecord[];
  total: number;
  /** true 表示 total 为封顶近似值（触达计数上限）。 */
  totalApproximate?: boolean;
  page: number;
  pageSize: number;
}

/** GET /api/admin/keys 响应。 */
export interface ApiKeysResponse {
  apiKeys?: Array<{ id: string; name: string; prefix?: string }>;
}

/** /api/admin/requests/facets 响应：各筛选维度的候选项（近 N 行采样，可能截断）。 */
export interface RequestFacets {
  sampledRows: number;
  approximate: boolean;
  accounts: Array<{ id: string; name: string }>;
  apiKeys: Array<{ id: string; name: string; prefix: string }>;
  providers: string[];
  models: string[];
  inboundEndpoints: string[];
  upstreamEndpoints: string[];
  clients: string[];
}

export interface Bucket {
  key: string;
  label: string;
  requests: number;
  ok: number;
  fail: number;
  latencySum: number;
  firstTokenSum: number;
  firstTokenCount: number;
  tpsSampleCount: number;
  genLatencySum: number;
  genTokensForTps: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd?: number;
  poolType?: string;
}

export interface UsageSummary {
  requests: number;
  ok: number;
  fail: number;
  avgLatencyMs: number;
  avgFirstTokenMs: number | null;
  avgTps: number | null;
  tpsSampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd?: number;
}


export interface QuotaForecastPoint {
  at: string;
  hourOffset: number;
  label: string;
  availableAmount: number;
  availableTokens: number | null;
  availableCapacity: number;
  routingReadyAccounts: number;
  eligibleAccounts: number;
  blockedAccounts: number;
}

export interface QuotaForecastSummary {
  metric: "tokens" | "capacity" | "accounts";
  metricLabel: string;
  primaryWindow: "fiveHour" | "rolling24h" | "mixed";
  nowAvailableAmount: number;
  laterAvailableAmount: number;
  nowRoutingReadyAccounts: number;
  laterRoutingReadyAccounts: number;
  peakRoutingReadyAccounts: number;
  peakAt: string | null;
  eligibleAccounts: number;
}

export interface QuotaForecastResult {
  generatedAt: string;
  hours: number;
  poolType: string | null;
  metric: "tokens" | "capacity" | "accounts";
  metricLabel: string;
  primaryWindow: "fiveHour" | "rolling24h" | "mixed";
  points: QuotaForecastPoint[];
  summary: QuotaForecastSummary;
  notes?: string[];
}

export interface UsageStats {
  summary: UsageSummary;
  byTime: Bucket[];
  byModel: Bucket[];
  byAccount: Bucket[];
  byKey: Bucket[];
  poolTypes?: Array<{ type: string; label: string }>;
}

export interface LogSettings {
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
}

export interface LogsCleanupResponse {
  deletedRequests?: number;
  deletedBodies?: number;
  stripped?: number;
}

export interface LogStats {
  dbFileBytes: number;
  bodies: { count: number; bytes: number };
  /** 加列前写入的旧日志行数（body_bytes=0），回填后归零。 */
  unmeasuredRows?: number;
  requests: number;
  retentionDays: number;
  logBodies: boolean;
  logBodiesOnError: boolean;
}

export interface EventRecord {
  id: string;
  createdAt?: string | null;
  type?: string | null;
  level?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  message?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RoutingConfig {
  mode?: string;
  preferredAccountId?: string | null;
  currentAccountId?: string | null;
  candidates?: Account[];
  poolPreferences?: Record<string, string | null>;
  poolTypes?: Array<string | { type: string; label: string }>;
}

export interface AdminSettings {
  refreshIntervalMinutes?: number | null;
  activeQuotaCheckSeconds?: number | null;
  idleQuotaCheckMinutes?: number | null;
  requestLogRetentionDays?: number | null;
  loggingEnabled?: boolean;
  logBodies?: boolean;
  logBodiesOnError?: boolean;
  logRetentionDays?: number;
  maxBodyCaptureBytes?: number;
}

export interface OverviewPayload {
  poolTypes?: Array<{ type: string; label: string }>;
  counts?: {
    totalAccounts?: number;
    readyAccounts?: number;
   quotaBlocked?: number;
   inactiveAccounts?: number;
   apiKeys?: number;
    byPoolType?: Record<string, { total: number; ready: number; blocked: number; inactive: number }>;
 };
 stats?: {
   totalAccounts?: number;
   availableAccounts?: number;
   coolingAccounts?: number;
   unavailableAccounts?: number;
 };
 routing?: {
   currentAccountName?: string | null;
   currentAccountId?: string | null;
   preferredAccountName?: string | null;
   preferredAccountId?: string | null;
   nextRecoveryAt?: string | null;
 };
 recentRequests?: RequestRecord[];
 recentEvents?: EventRecord[];
 recentAttempts?: Record<string, AttemptDetail[]>;
  /** 账号下拉数据源（来自 /api/admin/overview 的 accounts 字段）。 */
  accounts?: Array<{ id: string; name: string; email: string | null }>;
}

export interface PoolTypeInfo {
  type: string;
  label: string;
  description: string;
  quotaKinds: string[];
}

export interface ModelRouteRule {
  id: string;
  modelPattern: string;
  poolTypePriority: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** OpenCode Go 邀请奖励（来自 /api/admin/accounts/{id}/referrals）。 */
export interface ReferralReward {
  id: string;
  source: "inviter" | "invitee";
  status: "available" | "applied" | "pending";
  email: string | null;
  amount: number;
  timeCreated: string | null;
  timeApplied: string | null;
}

export interface ReferralSummary {
  referralCode: string | null;
  rewardAmount: number | null;
  rewards: ReferralReward[];
}