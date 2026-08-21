import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { ApiKeyHasher, SecretVault } from "./crypto"
import { getSystemSecret } from "./settings"
import type { AccountCredential, AccountRecord, AdminState, AuthState, BillingGuard, QuotaKind, SubscriptionState } from "./types"
import type { ModelRouteRule, PoolType } from "./types"
import type { ParsedUsage } from "./opencode-web/parser"
import { deriveAccountRouteStatus } from "./account-route-state"
import { isBuiltinProviderEnabled } from "./builtin-provider-state"

type Row = Record<string, unknown>
const nowIso = () => new Date().toISOString()
const nullableString = (value: unknown): string | null => typeof value === "string" ? value : null

export function accountFromRow(row: Row): AccountRecord {
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id), name: String(row.name), workspaceId: String(row.workspace_id),
    poolType: (nullableString(row.pool_type) ?? "opencode-go") as PoolType,
    email: nullableString(row.email), goKeyId: String(row.go_key_id), credentialSource: String(row.credential_source),
    extensionVersion: nullableString(row.extension_version), lastSyncedAt: String(row.last_synced_at),
    adminState: row.admin_state as AdminState, authState: row.auth_state as AuthState,
    subscriptionState: row.subscription_state as SubscriptionState, billingGuard: row.billing_guard as BillingGuard,
    goSubscriptionId: nullableString(row.go_subscription_id), isZenSubscribed: Boolean(row.is_zen_subscribed),
    zenSubscriptionId: nullableString(row.zen_subscription_id), hasManageSubscriptionButton: Boolean(row.has_manage_subscription_button),
    useBalance: row.use_balance === null ? null : Boolean(row.use_balance), useChinaProviders: Boolean(row.use_china_providers), credentialVersion: Number(row.credential_version),
    lastUsageCheckAt: nullableString(row.last_usage_check_at), nextUsageCheckAt: String(row.next_usage_check_at),
    lastSelectedAt: nullableString(row.last_selected_at), lastRequestAt: nullableString(row.last_request_at),
    lastSuccessAt: nullableString(row.last_success_at), lastLimitAt: nullableString(row.last_limit_at),
    disabledReason: nullableString(row.disabled_reason), disabledAt: nullableString(row.disabled_at), lastError: nullableString(row.last_error),
    externalId: nullableString(row.external_id),
    maxConcurrency: Number(row.max_concurrency), ordinal: Number(row.ordinal), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

export interface UpsertBrowserAccountInput {
  name?: string
  workspaceId: string
  email?: string | null
  authCookie: string
  goApiKey: string
  goKeyId: string
  extensionVersion?: string | null
  subscriptionState: SubscriptionState
  goSubscriptionId?: string | null
  isZenSubscribed?: boolean
  zenSubscriptionId?: string | null
  hasManageSubscriptionButton?: boolean
  billingGuard: BillingGuard
  useBalance: boolean | null
  useChinaProviders?: boolean | null
  usage: ParsedUsage | null
}

export class AccountOwnershipConflictError extends Error {
  constructor() { super("This OpenCode workspace is already registered to another user"); this.name = "AccountOwnershipConflictError" }
}


export type AccountListStatusFilter = "all" | "ready" | "temp_blocked" | "spending_blocked" | "credential_invalid" | "admin_disabled" | "upstream_banned" | "subscription_inactive" | "billing_unsafe" | "unavailable"
export type AccountListSort = "recent" | "usage" | "name" | "created"

export interface AccountListQuery {
  q?: string | null
  poolType?: string | null
  status?: AccountListStatusFilter | null
  sort?: AccountListSort | null
  page?: number
  pageSize?: number | null
  /** Pool types to hide entirely (e.g. disabled builtin providers). Excluded from items AND stats. */
  excludePoolTypes?: string[] | null
}

export interface AccountPoolStats {
  total: number
  ready: number
  blocked: number
  inactive: number
  overQuota: number
}

export interface AccountListStats {
  total: number
  ready: number
  blocked: number
  disabled: number
  banned: number
  authError: number
  inactive: number
  overQuota: number
  avgUsagePercent: number | null
  byPoolType: Record<string, AccountPoolStats>
}

export interface AccountListResult {
  items: AccountRecord[]
  total: number
  page: number
  pageSize: number
  stats: AccountListStats
}

function parsePositiveInt(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  const rounded = Math.round(parsed)
  return max == null ? rounded : Math.min(max, rounded)
}

function emptyPoolStats(): AccountPoolStats {
  return { total: 0, ready: 0, blocked: 0, inactive: 0, overQuota: 0 }
}

function emptyAccountStats(): AccountListStats {
  return {
    total: 0,
    ready: 0,
    blocked: 0,
    disabled: 0,
    banned: 0,
    authError: 0,
    inactive: 0,
    overQuota: 0,
    avgUsagePercent: null,
    byPoolType: {},
  }
}

function accountPrimaryUsagePercent(windows: Array<{ kind?: string | null; usagePercent?: number | null }>): number | null {
  if (!windows.length) return null
  const preferred = windows.find((window) => {
    const kind = String(window.kind || "").toUpperCase()
    return kind === "ROLLING_24H" || kind === "ROLLING" || kind === "24H" || kind === "FIVE_HOUR" || kind === "FIVEHOUR" || kind === "5H"
  }) ?? windows[0]
  const value = preferred?.usagePercent
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value)
}

export class AccountRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase(), private readonly vault?: SecretVault) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }

  list(): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts WHERE owner_user_id = ? ORDER BY ordinal, created_at").all(this.ownerUserId) as Row[]).map(accountFromRow)
  }

  listPage(query: AccountListQuery = {}): AccountListResult {
    const page = parsePositiveInt(query.page, 1, 10_000)
    const unlimited = query.pageSize == null
    const pageSize = unlimited ? Number.MAX_SAFE_INTEGER : parsePositiveInt(query.pageSize, 50, 500)
    const poolType = query.poolType && query.poolType !== "all" ? String(query.poolType) : null
    const status = (query.status && query.status !== "all" ? query.status : "all") as AccountListStatusFilter
    const sort = (query.sort || "recent") as AccountListSort
    const term = String(query.q || "").trim().toLowerCase()

    // Intentionally omit pool_type from SQL so byPoolType chip counts stay global
    // (still respect search term). Pool filter is applied after status filtering.
    const conditions = ["owner_user_id = ?"]
    const params: Array<string | number> = [this.ownerUserId]
    if (term) {
      conditions.push("(LOWER(COALESCE(name,'')) LIKE ? OR LOWER(COALESCE(email,'')) LIKE ? OR LOWER(id) LIKE ? OR LOWER(COALESCE(workspace_id,'')) LIKE ? OR LOWER(COALESCE(external_id,'')) LIKE ?)")
      const like = `%${term}%`
      params.push(like, like, like, like, like)
    }

    const where = conditions.join(" AND ")
    const rows = this.db.prepare(`SELECT * FROM accounts WHERE ${where}`).all(...params) as Row[]
    let accounts = rows.map(accountFromRow)

    // Disabled builtin providers exit the account pool UI entirely: their
    // accounts count neither in the list nor in stats/byPoolType chips.
    const excludedPoolTypes = new Set((query.excludePoolTypes ?? []).filter(Boolean))
    if (excludedPoolTypes.size > 0) {
      accounts = accounts.filter((account) => !excludedPoolTypes.has(account.poolType))
    }

    const timestamp = nowIso()
    const blockedRows = this.db.prepare(`SELECT DISTINCT account_id FROM quota_windows
      WHERE owner_user_id = ? AND usage_percent >= 100 AND (reset_at IS NULL OR reset_at > ?)`)
      .all(this.ownerUserId, timestamp) as { account_id: string }[]
    const blockedSet = new Set(blockedRows.map((row) => row.account_id))
    const customProviderRows = this.db.prepare("SELECT id,enabled FROM custom_providers WHERE owner_user_id=?")
      .all(this.ownerUserId) as Array<{ id: string; enabled: number }>
    const customProviderEnabled = new Map(customProviderRows.map((row) => [`custom:${row.id}`, Boolean(row.enabled)]))

    const usageRows = this.db.prepare(`SELECT account_id, kind, usage_percent, reset_at FROM quota_windows WHERE owner_user_id = ?`)
      .all(this.ownerUserId) as Array<{ account_id: string; kind: string; usage_percent: number | null; reset_at: string | null }>
    const usageByAccount = new Map<string, Array<{ kind: string; usagePercent: number | null; resetAt: string | null }>>()
    for (const row of usageRows) {
      const list = usageByAccount.get(row.account_id) ?? []
      list.push({ kind: row.kind, usagePercent: row.usage_percent, resetAt: row.reset_at })
      usageByAccount.set(row.account_id, list)
    }

    const classify = (account: AccountRecord) => {
      const providerReady = account.poolType === "opencode-go"
        ? account.adminState === "ENABLED" && account.authState === "VALID" && account.subscriptionState === "ACTIVE" && account.billingGuard === "VERIFIED_GO_ONLY" && account.useBalance === false
        : account.poolType.startsWith("custom:")
          ? customProviderEnabled.get(account.poolType) === true && account.adminState === "ENABLED" && account.authState === "VALID" && account.subscriptionState === "ACTIVE"
          : account.adminState === "ENABLED" && account.authState === "VALID"
      const routeState = deriveAccountRouteStatus(account, usageByAccount.get(account.id) ?? [], Date.parse(timestamp), {
        providerReady,
        providerUnavailableReason: account.poolType.startsWith("custom:") && customProviderEnabled.get(account.poolType) !== true
          ? "自定义 Provider 已停用"
          : null,
      }).routeState
      const banned = routeState === "UPSTREAM_BANNED"
      const disabled = account.adminState === "DISABLED"
      const authError = routeState === "CREDENTIAL_INVALID"
      const overQuota = (accountPrimaryUsagePercent(usageByAccount.get(account.id) ?? []) ?? 0) >= 100 || blockedSet.has(account.id)
      const ready = routeState === "READY"
      const blocked = routeState === "TEMP_BLOCKED"
      const inactive = !ready && !blocked
      return { routeState, banned, disabled, authError, overQuota, ready, inactive, blocked }
    }

    if (status !== "all") {
      accounts = accounts.filter((account) => {
        const flags = classify(account)
        if (status === "ready") return flags.ready
        if (status === "temp_blocked") return flags.routeState === "TEMP_BLOCKED"
        if (status === "spending_blocked") return flags.routeState === "SPENDING_BLOCKED"
        if (status === "credential_invalid") return flags.routeState === "CREDENTIAL_INVALID"
        if (status === "admin_disabled") return flags.routeState === "ADMIN_DISABLED"
        if (status === "upstream_banned") return flags.routeState === "UPSTREAM_BANNED"
        if (status === "subscription_inactive") return flags.routeState === "SUBSCRIPTION_INACTIVE"
        if (status === "billing_unsafe") return flags.routeState === "BILLING_UNSAFE"
        if (status === "unavailable") return flags.routeState === "UNAVAILABLE"
        return true
      })
    }

    // Pool chip counts must ignore the active poolType filter; otherwise selecting
    // "xai-grok" would zero out OpenCode Go / 全部 badges.
    const byPoolType: Record<string, AccountPoolStats> = {}
    for (const account of accounts) {
      const flags = classify(account)
      const pool = byPoolType[account.poolType] ?? emptyPoolStats()
      pool.total += 1
      if (flags.ready) pool.ready += 1
      if (flags.blocked) pool.blocked += 1
      if (flags.inactive) pool.inactive += 1
      if (flags.overQuota) pool.overQuota += 1
      byPoolType[account.poolType] = pool
    }

    if (poolType) {
      accounts = accounts.filter((account) => account.poolType === poolType)
    }

    const stats = emptyAccountStats()
    stats.byPoolType = byPoolType
    const usageSamples: number[] = []
    for (const account of accounts) {
      const flags = classify(account)
      stats.total += 1
      if (flags.ready) stats.ready += 1
      if (flags.blocked) stats.blocked += 1
      if (flags.disabled) stats.disabled += 1
      if (flags.banned) stats.banned += 1
      if (flags.authError) stats.authError += 1
      if (flags.inactive) stats.inactive += 1
      if (flags.overQuota) stats.overQuota += 1

      const usage = accountPrimaryUsagePercent(usageByAccount.get(account.id) ?? [])
      if (usage != null) usageSamples.push(usage)
    }
    stats.avgUsagePercent = usageSamples.length
      ? Math.round((usageSamples.reduce((sum, value) => sum + value, 0) / usageSamples.length) * 100) / 100
      : null

    const availabilityRank = (account: AccountRecord) => {
      const flags = classify(account)
      if (flags.ready) return 0
      if (flags.blocked) return 1
      if (!flags.disabled && !flags.banned) return 2
      return 3
    }
    accounts.sort((left, right) => {
      const rankDifference = availabilityRank(left) - availabilityRank(right)
      if (rankDifference !== 0) return rankDifference

      if (sort === "name") {
        return String(left.name || left.email || left.id).localeCompare(String(right.name || right.email || right.id), "zh-CN")
      }
      if (sort === "created") {
        return String(right.createdAt).localeCompare(String(left.createdAt))
      }
      if (sort === "usage") {
        const leftUsage = accountPrimaryUsagePercent(usageByAccount.get(left.id) ?? []) ?? -1
        const rightUsage = accountPrimaryUsagePercent(usageByAccount.get(right.id) ?? []) ?? -1
        if (rightUsage !== leftUsage) return rightUsage - leftUsage
      }
      const leftRecent = left.lastRequestAt || left.lastSelectedAt || left.lastSyncedAt || left.updatedAt || left.createdAt
      const rightRecent = right.lastRequestAt || right.lastSelectedAt || right.lastSyncedAt || right.updatedAt || right.createdAt
      const recentCmp = String(rightRecent).localeCompare(String(leftRecent))
      if (recentCmp !== 0) return recentCmp
      if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal
      return String(left.createdAt).localeCompare(String(right.createdAt))
    })

    const total = accounts.length
    const safePageSize = unlimited ? Math.max(total, 1) : pageSize
    const offset = unlimited ? 0 : (page - 1) * safePageSize
    const items = unlimited ? accounts : accounts.slice(offset, offset + safePageSize)

    return {
      items,
      total,
      page: unlimited ? 1 : page,
      pageSize: unlimited ? total : safePageSize,
      stats,
    }
  }

  listQuotaWindows(accountIds?: string[]): Array<{
    accountId: string
    kind: string
    usagePercent: number | null
    resetAt: string | null
    source: string | null
    lastObservedAt: string | null
    limitValue: number | null
    remainingValue: number | null
    unit: string | null
    wallet: Record<string, unknown> | null
    extra: Record<string, unknown> | null
  }> {
    if (accountIds && accountIds.length === 0) return []
    if (accountIds && accountIds.length > 0) {
      const placeholders = accountIds.map(() => "?").join(",")
      const rows = this.db.prepare(`SELECT account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value,unit,wallet_json,extra_json
        FROM quota_windows WHERE owner_user_id=? AND account_id IN (${placeholders}) ORDER BY last_observed_at DESC`)
        .all(this.ownerUserId, ...accountIds) as Row[]
      return rows.map((row) => ({
        accountId: String(row.account_id),
        kind: String(row.kind),
        usagePercent: row.usage_percent == null ? null : Number(row.usage_percent),
        resetAt: nullableString(row.reset_at),
        source: nullableString(row.source),
        lastObservedAt: nullableString(row.last_observed_at),
        limitValue: row.limit_value == null ? null : Number(row.limit_value),
        remainingValue: row.remaining_value == null ? null : Number(row.remaining_value),
        unit: nullableString(row.unit),
        wallet: row.wallet_json ? JSON.parse(String(row.wallet_json)) as Record<string, unknown> : null,
        extra: row.extra_json ? JSON.parse(String(row.extra_json)) as Record<string, unknown> : null,
      }))
    }
    const rows = this.db.prepare(`SELECT account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value,unit,wallet_json,extra_json
      FROM quota_windows WHERE owner_user_id=? ORDER BY last_observed_at DESC`).all(this.ownerUserId) as Row[]
    return rows.map((row) => ({
      accountId: String(row.account_id),
      kind: String(row.kind),
      usagePercent: row.usage_percent == null ? null : Number(row.usage_percent),
      resetAt: nullableString(row.reset_at),
      source: nullableString(row.source),
      lastObservedAt: nullableString(row.last_observed_at),
      limitValue: row.limit_value == null ? null : Number(row.limit_value),
      remainingValue: row.remaining_value == null ? null : Number(row.remaining_value),
      unit: nullableString(row.unit),
      wallet: row.wallet_json ? JSON.parse(String(row.wallet_json)) as Record<string, unknown> : null,
      extra: row.extra_json ? JSON.parse(String(row.extra_json)) as Record<string, unknown> : null,
    }))
  }

  get(accountId: string): AccountRecord | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? AND owner_user_id = ?").get(accountId, this.ownerUserId) as Row | undefined
    return row ? accountFromRow(row) : null
  }

  listByPoolType(poolType: PoolType): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts WHERE owner_user_id = ? AND pool_type = ? ORDER BY ordinal, created_at").all(this.ownerUserId, poolType) as Row[]).map(accountFromRow)
  }

  listPoolTypes(): PoolType[] {
    const rows = this.db.prepare("SELECT DISTINCT pool_type FROM accounts WHERE owner_user_id = ? ORDER BY pool_type").all(this.ownerUserId) as { pool_type: string }[]
    return rows.map((r) => r.pool_type as PoolType)
  }

  createCpaAccount(input: { name: string; email?: string | null }): AccountRecord {
    return this.createProviderAccount({ name: input.name, email: input.email, poolType: "openai" })
  }

  /**
   * Generic provider-backed account creation for pool types that don't use
   * the browser extension (openai, xai-grok, ...). Stores
   * placeholder auth/cookie ciphertext; the provider layer populates
   * `provider_credentials` separately. Defaults match createCpaAccount.
   */
  createProviderAccount(input: { name: string; poolType: PoolType; email?: string | null; subscriptionState?: string; externalId?: string | null; maxConcurrency?: number }): AccountRecord {
    return this.createProviderAccountTracked(input).account
  }

  createProviderAccountTracked(input: { name: string; poolType: PoolType; email?: string | null; subscriptionState?: string; externalId?: string | null; maxConcurrency?: number }): { account: AccountRecord; created: boolean } {
    if (input.externalId) {
      const existing = this.db.prepare("SELECT id,disabled_reason FROM accounts WHERE owner_user_id=? AND pool_type=? AND external_id=?").get(this.ownerUserId, input.poolType, input.externalId) as { id: string; disabled_reason: string | null } | undefined
      if (existing) {
        if (existing.disabled_reason === "XAI_ACCOUNT_BANNED") {
          this.db.prepare("UPDATE accounts SET name=?,email=COALESCE(?,email),updated_at=? WHERE id=? AND owner_user_id=?")
            .run(input.name, input.email ?? null, nowIso(), existing.id, this.ownerUserId)
        } else {
          this.db.prepare(`UPDATE accounts SET name=?,email=COALESCE(?,email),admin_state='ENABLED',auth_state='VALID',disabled_reason=NULL,disabled_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND owner_user_id=?`)
            .run(input.name, input.email ?? null, nowIso(), existing.id, this.ownerUserId)
        }
        return { account: this.get(existing.id)!, created: false }
      }
    }
    const id = randomUUID()
    const timestamp = nowIso()
    const ordinal = Number((this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 value FROM accounts WHERE owner_user_id=?").get(this.ownerUserId) as Row).value)
    const workspaceId = `${input.poolType === "xai-grok" ? "grok" : input.poolType}_${this.ownerUserId}_${input.externalId ?? id}`
    this.db.prepare(`INSERT INTO accounts(id, owner_user_id, name, pool_type, workspace_id, go_key_id, credential_source, last_synced_at,
      auth_cookie_ciphertext, go_api_key_ciphertext, subscription_state, billing_guard, next_usage_check_at, ordinal, created_at, updated_at, external_id, max_concurrency)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, this.ownerUserId, input.name, input.poolType, workspaceId, input.poolType, "PROVIDER_IMPORT", timestamp,
      this.secretVault().encrypt("unused"), this.secretVault().encrypt("unused"),
      input.subscriptionState ?? "ACTIVE", "VERIFIED_GO_ONLY",
      new Date(Date.now() + 60_000).toISOString(), ordinal, timestamp, timestamp, input.externalId ?? null,
      input.maxConcurrency ?? 4,
    )
    if (input.email) this.db.prepare("UPDATE accounts SET email=? WHERE id=? AND owner_user_id=?").run(input.email, id, this.ownerUserId)
    return { account: this.get(id)!, created: true }
  }


  getCredential(accountId: string): AccountCredential | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? AND owner_user_id = ?").get(accountId, this.ownerUserId) as Row | undefined
    if (!row) return null
    return { ...accountFromRow(row), authCookie: this.secretVault().decrypt(String(row.auth_cookie_ciphertext)), goApiKey: this.secretVault().decrypt(String(row.go_api_key_ciphertext)) }
  }

  upsertBrowserAccount(input: UpsertBrowserAccountInput): AccountRecord {
    const existing = this.db.prepare("SELECT id, owner_user_id FROM accounts WHERE workspace_id = ?").get(input.workspaceId) as { id: string; owner_user_id: string } | undefined
    if (existing && existing.owner_user_id !== this.ownerUserId) throw new AccountOwnershipConflictError()
    const timestamp = nowIso()
    const id = existing?.id ?? randomUUID()
    const nextUsage = new Date(Date.now() + 60_000).toISOString()
    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(`UPDATE accounts SET name=COALESCE(?,name), email=?, auth_cookie_ciphertext=?, go_api_key_ciphertext=?, go_key_id=?,
          extension_version=COALESCE(?,extension_version), last_synced_at=?, auth_state='VALID', subscription_state=?,
          go_subscription_id=?, is_zen_subscribed=?, zen_subscription_id=?, has_manage_subscription_button=?, billing_guard=?, use_balance=?,
          use_china_providers=?,
          credential_version=credential_version+1, last_usage_check_at=?, next_usage_check_at=?, updated_at=?
          WHERE id=? AND owner_user_id=?`).run(
          input.name ?? null, input.email ?? null, this.secretVault().encrypt(input.authCookie),
          this.secretVault().encrypt(input.goApiKey), input.goKeyId, input.extensionVersion ?? null, timestamp,
          input.subscriptionState, input.goSubscriptionId ?? null, Number(input.isZenSubscribed ?? false), input.zenSubscriptionId ?? null,
          Number(input.hasManageSubscriptionButton ?? false), input.billingGuard, input.useBalance === null ? null : Number(input.useBalance), Number(input.useChinaProviders ?? false),
          input.usage ? timestamp : null, nextUsage, timestamp, id, this.ownerUserId,
        )
      } else {
        const ordinal = Number((this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 value FROM accounts WHERE owner_user_id=?").get(this.ownerUserId) as Row).value)
        this.db.prepare(`INSERT INTO accounts(id,owner_user_id,name,workspace_id,email,go_key_id,credential_source,extension_version,last_synced_at,
          auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,go_subscription_id,is_zen_subscribed,zen_subscription_id,
          has_manage_subscription_button,billing_guard,use_balance,use_china_providers,last_usage_check_at,next_usage_check_at,
          ordinal,created_at,updated_at) VALUES(?,?,?,?,?,?,'BROWSER_EXTENSION',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, this.ownerUserId, input.name ?? input.email ?? input.workspaceId, input.workspaceId, input.email ?? null, input.goKeyId,
          input.extensionVersion ?? null, timestamp, this.secretVault().encrypt(input.authCookie), this.secretVault().encrypt(input.goApiKey),
          input.subscriptionState, input.goSubscriptionId ?? null, Number(input.isZenSubscribed ?? false), input.zenSubscriptionId ?? null,
          Number(input.hasManageSubscriptionButton ?? false), input.billingGuard, input.useBalance === null ? null : Number(input.useBalance), Number(input.useChinaProviders ?? false), input.usage ? timestamp : null,
          nextUsage, ordinal, timestamp, timestamp,
        )
      }
      if (input.usage) this.writeUsage(id, input.usage, new Date(timestamp))
    }).immediate()
    return this.get(id)!
  }

  updateUsage(accountId: string, usage: ParsedUsage, observedAt = new Date()): void {
    this.db.transaction(() => {
      this.writeUsage(accountId, usage, observedAt)
      this.db.prepare("UPDATE accounts SET last_usage_check_at=?, next_usage_check_at=?, auth_state='VALID', updated_at=? WHERE id=? AND owner_user_id=?")
        .run(observedAt.toISOString(), new Date(observedAt.getTime() + 60_000).toISOString(), observedAt.toISOString(), accountId, this.ownerUserId)
    })()
  }

  updateState(accountId: string, input: Partial<{ name: string; adminState: AdminState; authState: AuthState; subscriptionState: SubscriptionState; goSubscriptionId: string | null; isZenSubscribed: boolean; zenSubscriptionId: string | null; hasManageSubscriptionButton: boolean; billingGuard: BillingGuard; useBalance: boolean | null; useChinaProviders: boolean; maxConcurrency: number; lastSyncedAt: string; disabledReason: string | null; disabledAt: string | null; lastError: string | null }>): AccountRecord | null {
    const entries: [string, unknown][] = []
    if (input.name !== undefined) entries.push(["name", input.name])
    if (input.adminState !== undefined) entries.push(["admin_state", input.adminState])
    if (input.authState !== undefined) entries.push(["auth_state", input.authState])
    if (input.subscriptionState !== undefined) entries.push(["subscription_state", input.subscriptionState])
    if (input.goSubscriptionId !== undefined) entries.push(["go_subscription_id", input.goSubscriptionId])
    if (input.isZenSubscribed !== undefined) entries.push(["is_zen_subscribed", Number(input.isZenSubscribed)])
    if (input.zenSubscriptionId !== undefined) entries.push(["zen_subscription_id", input.zenSubscriptionId])
    if (input.hasManageSubscriptionButton !== undefined) entries.push(["has_manage_subscription_button", Number(input.hasManageSubscriptionButton)])
    if (input.billingGuard !== undefined) entries.push(["billing_guard", input.billingGuard])
    if (input.useBalance !== undefined) entries.push(["use_balance", input.useBalance === null ? null : Number(input.useBalance)])
    if (input.useChinaProviders !== undefined) entries.push(["use_china_providers", Number(input.useChinaProviders)])
    if (input.maxConcurrency !== undefined) entries.push(["max_concurrency", input.maxConcurrency])
    if (input.lastSyncedAt !== undefined) entries.push(["last_synced_at", input.lastSyncedAt])
    if (input.disabledReason !== undefined) entries.push(["disabled_reason", input.disabledReason])
    if (input.disabledAt !== undefined) entries.push(["disabled_at", input.disabledAt])
    if (input.lastError !== undefined) entries.push(["last_error", input.lastError])
    if (entries.length) this.db.prepare(`UPDATE accounts SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=? AND owner_user_id=?`)
      .run(...entries.map(([, value]) => value), nowIso(), accountId, this.ownerUserId)
    return this.get(accountId)
  }

  markAuthError(accountId: string, terminal: boolean): void {
    this.updateState(accountId, { authState: terminal ? "REAUTH_REQUIRED" : "AUTH_ERROR" })
  }

  scheduleUsageCheck(accountId: string, nextAt: Date): void {
    this.db.prepare("UPDATE accounts SET next_usage_check_at=?,updated_at=? WHERE id=? AND owner_user_id=?")
      .run(nextAt.toISOString(), nowIso(), accountId, this.ownerUserId)
  }

  delete(accountId: string): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id=? AND owner_user_id=?").run(accountId, this.ownerUserId).changes === 1
  }

  bulkSetAdminState(
    accountIds: string[],
    adminState: AdminState,
    options: { reason?: string; confirmSpendingBlocked?: boolean } = {},
  ): { updated: number; unchanged: number; skippedBanned: number; skippedCredentialInvalid: number; skippedSpendingBlocked: number; notFound: number } {
    const ids = [...new Set(accountIds)]
    const result = { updated: 0, unchanged: 0, skippedBanned: 0, skippedCredentialInvalid: 0, skippedSpendingBlocked: 0, notFound: 0 }
    this.db.transaction(() => {
      for (const accountId of ids) {
        const account = this.get(accountId)
        if (!account) {
          result.notFound += 1
          continue
        }
        if (adminState === "ENABLED" && account.disabledReason === "XAI_ACCOUNT_BANNED") {
          result.skippedBanned += 1
          continue
        }
        if (adminState === "ENABLED" && (account.disabledReason === "CREDENTIAL_INVALID" || account.authState !== "VALID")) {
          result.skippedCredentialInvalid += 1
          continue
        }
        if (adminState === "ENABLED" && account.disabledReason === "SPENDING_BLOCKED" && !options.confirmSpendingBlocked) {
          result.skippedSpendingBlocked += 1
          continue
        }
        const hasActualChange = adminState === "ENABLED"
          ? account.adminState !== "ENABLED" || account.disabledReason !== null || account.disabledAt !== null
          : account.adminState !== "DISABLED" || account.disabledReason === null || account.disabledAt === null
        if (!hasActualChange) {
          result.unchanged += 1
          continue
        }
        const timestamp = nowIso()
        const reason = options.reason?.trim() || (adminState === "DISABLED" ? "ADMIN_DISABLED" : "ADMIN_ENABLED")
        const nextDisabledReason = adminState === "DISABLED"
          ? account.disabledReason || "ADMIN_DISABLED"
          : null
        this.updateState(accountId, {
          adminState,
          disabledReason: nextDisabledReason,
          disabledAt: adminState === "DISABLED" ? timestamp : null,
        })
        this.db.prepare("INSERT INTO events(id,owner_user_id,type,severity,account_id,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,NULL,?,?)")
          .run(randomUUID(), this.ownerUserId, adminState === "ENABLED" ? "ACCOUNT_ADMIN_ENABLED" : "ACCOUNT_ADMIN_DISABLED", "INFO", accountId,
            JSON.stringify({ reason, previousAdminState: account.adminState, previousDisabledReason: account.disabledReason }), timestamp)
        result.updated += 1
      }
    }).immediate()
    return result
  }

  bulkDelete(accountIds: string[]): { deleted: number; notFound: number } {
    const ids = [...new Set(accountIds)]
    const result = { deleted: 0, notFound: 0 }
    this.db.transaction(() => {
      for (const accountId of ids) {
        if (this.delete(accountId)) result.deleted += 1
        else result.notFound += 1
      }
    }).immediate()
    return result
  }

  private writeUsage(accountId: string, usage: ParsedUsage, observedAt: Date): void {
    const statement = this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,?,?,?,'DASHBOARD',?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET usage_percent=excluded.usage_percent,
      reset_at=excluded.reset_at,source='DASHBOARD',observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
    for (const [kind, value] of Object.entries(usage) as [Exclude<QuotaKind, "UNKNOWN_GO_LIMIT">, ParsedUsage["FIVE_HOUR"]][]) {
      statement.run(this.ownerUserId, accountId, kind, value.usagePercent, new Date(observedAt.getTime() + value.resetInSeconds * 1000).toISOString(), observedAt.toISOString())
    }
  }

  private secretVault(): SecretVault { return this.vault ?? new SecretVault() }
}

export class ProviderCredentialRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase(), private readonly vault?: SecretVault) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }
  private secretVault(): SecretVault { return this.vault ?? new SecretVault() }
  upsert(input: { accountId: string; poolType: PoolType; credentialData: Record<string, string> }): void {
    const ts = nowIso()
    const ciphertext = this.secretVault().encrypt(JSON.stringify(input.credentialData))
    this.db.prepare(`INSERT INTO provider_credentials(id, owner_user_id, account_id, pool_type, credential_data_ciphertext, credential_version, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET credential_data_ciphertext=excluded.credential_data_ciphertext, credential_version=credential_version+1, updated_at=excluded.updated_at`)
      .run(randomUUID(), this.ownerUserId, input.accountId, input.poolType, ciphertext, 1, ts, ts)
    this.db.prepare("UPDATE accounts SET credential_version=credential_version+1,updated_at=? WHERE id=? AND owner_user_id=?")
      .run(ts, input.accountId, this.ownerUserId)
  }
  get(accountId: string): Record<string, string> | null {
    const row = this.db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ? AND owner_user_id = ?").get(accountId, this.ownerUserId) as Row | undefined
    if (!row) return null
    try { return JSON.parse(this.secretVault().decrypt(String(row.credential_data_ciphertext))) as Record<string, string> } catch { return null }
  }
  delete(accountId: string): boolean {
    return this.db.prepare("DELETE FROM provider_credentials WHERE account_id = ? AND owner_user_id = ?").run(accountId, this.ownerUserId).changes >= 1
  }
}

export class ModelRoutingRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }
  list(): ModelRouteRule[] {
    return (this.db.prepare("SELECT * FROM model_routing WHERE owner_user_id = ? ORDER BY created_at").all(this.ownerUserId) as (Row & { model_pattern: string; pool_type_priority: string; enabled: number })[])
      .map((row) => ({
        id: String(row.id), ownerUserId: String(row.owner_user_id), modelPattern: String(row.model_pattern),
        poolTypePriority: JSON.parse(String(row.pool_type_priority)) as string[], enabled: Boolean(row.enabled),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      }))
  }
  create(modelPattern: string, poolTypePriority: string[]): ModelRouteRule {
    const id = randomUUID(); const ts = nowIso()
    this.db.prepare("INSERT INTO model_routing(id, owner_user_id, model_pattern, pool_type_priority, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, this.ownerUserId, modelPattern, JSON.stringify(poolTypePriority), 1, ts, ts)
    return { id, ownerUserId: this.ownerUserId, modelPattern, poolTypePriority, enabled: true, createdAt: ts, updatedAt: ts }
  }
  update(id: string, input: Partial<{ modelPattern: string; poolTypePriority: string[]; enabled: boolean }>): ModelRouteRule | null {
    const entries: [string, unknown][] = []
    if (input.modelPattern !== undefined) entries.push(["model_pattern", input.modelPattern])
    if (input.poolTypePriority !== undefined) entries.push(["pool_type_priority", JSON.stringify(input.poolTypePriority)])
    if (input.enabled !== undefined) entries.push(["enabled", Number(input.enabled)])
    if (entries.length) this.db.prepare(`UPDATE model_routing SET ${entries.map(([k]) => `${k}=?`).join(",")}, updated_at=? WHERE id=? AND owner_user_id=?`)
      .run(...entries.map(([, v]) => v), nowIso(), id, this.ownerUserId)
    return this.list().find((r) => r.id === id) ?? null
  }
  delete(id: string): boolean { return this.db.prepare("DELETE FROM model_routing WHERE id=? AND owner_user_id=?").run(id, this.ownerUserId).changes === 1 }
  resolveModelPriority(model: string): string[] | null {
    const rules = this.list().filter((r) => r.enabled)
    const exact = rules.find((r) => r.modelPattern === model)
    if (exact) return exact.poolTypePriority
    const wildcards = rules.filter((r) => r.modelPattern.endsWith("*")).sort((a, b) => b.modelPattern.length - a.modelPattern.length)
    for (const rule of wildcards) { if (model.startsWith(rule.modelPattern.slice(0, -1))) return rule.poolTypePriority }
    return null
  }
}

export function listDueUsageCandidates(db: AppDatabase = getDatabase(), now = new Date(), limit = 25): { ownerUserId: string; accountId: string; poolType: string }[] {
  const activeSince = new Date(now.getTime() - 10 * 60_000).toISOString()
  return (db.prepare(`SELECT DISTINCT a.owner_user_id,a.id,a.pool_type FROM accounts a JOIN users u ON u.id=a.owner_user_id
    WHERE u.status='ACTIVE' AND a.admin_state='ENABLED' AND a.auth_state='VALID'
      AND a.pool_type != 'xai-grok'
      AND a.next_usage_check_at<=?
      AND a.last_request_at>=?
    ORDER BY a.next_usage_check_at LIMIT ?`).all(now.toISOString(), activeSince, limit) as { owner_user_id: string; id: string; pool_type: string }[])
    .map((row) => ({ ownerUserId: row.owner_user_id, accountId: row.id, poolType: row.pool_type ?? "opencode-go" }))
    // Disabled builtin providers exit scheduling entirely; skip their upstream quota probes too.
    .filter((candidate) => isBuiltinProviderEnabled(candidate.poolType, db))
}

export interface ApiKeyRecord { id: string; ownerUserId: string; name: string; prefix: string; enabled: boolean; allowedModels: string[] | null; expiresAt: string | null; lastUsedAt: string | null; createdAt: string; revealable: boolean; requestCount?: number }
function apiKeyFromRow(row: Row): ApiKeyRecord { return { id:String(row.id),ownerUserId:String(row.owner_user_id),name:String(row.name),prefix:String(row.key_prefix),enabled:Boolean(row.enabled),allowedModels:row.allowed_models_json?JSON.parse(String(row.allowed_models_json)):null,expiresAt:nullableString(row.expires_at),lastUsedAt:nullableString(row.last_used_at),createdAt:String(row.created_at),revealable:Boolean(row.key_ciphertext) } }
export function authenticateApiKey(plaintext:string,db:AppDatabase=getDatabase(),hasher=new ApiKeyHasher(getSystemSecret(db,"api_key_pepper"))):(ApiKeyRecord&{hash:string})|null { if(!plaintext)return null;const hash=hasher.hash(plaintext);const row=db.prepare(`SELECT k.* FROM api_keys k JOIN users u ON u.id=k.owner_user_id WHERE k.key_hash=? AND k.enabled=1 AND u.status='ACTIVE'`).get(hash) as Row|undefined;if(!row||(row.expires_at&&String(row.expires_at)<=nowIso())||!hasher.verify(plaintext,String(row.key_hash)))return null;db.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").run(nowIso(),row.id);return{...apiKeyFromRow(row),hash} }
export class ApiKeyRepository {
  private readonly hasher:ApiKeyHasher
  private readonly vault:SecretVault
  constructor(readonly ownerUserId:string,readonly db:AppDatabase=getDatabase(),hasher?:ApiKeyHasher,vault?:SecretVault){if(!ownerUserId)throw new Error("ownerUserId is required");this.hasher=hasher??new ApiKeyHasher(getSystemSecret(db,"api_key_pepper"));this.vault=vault??new SecretVault()}
  create(name:string,allowedModels?:string[]|null,expiresAt?:string|null):ApiKeyRecord&{key:string}{const id=randomUUID(),key=this.hasher.generate(),timestamp=nowIso(),ciphertext=this.vault.encrypt(key.plaintext);this.db.prepare(`INSERT INTO api_keys(id,owner_user_id,name,key_prefix,key_hash,key_ciphertext,enabled,allowed_models_json,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)`).run(id,this.ownerUserId,name,key.prefix,key.hash,ciphertext,allowedModels?JSON.stringify(allowedModels):null,expiresAt??null,timestamp,timestamp);return{id,ownerUserId:this.ownerUserId,name,prefix:key.prefix,key:key.plaintext,enabled:true,allowedModels:allowedModels??null,expiresAt:expiresAt??null,lastUsedAt:null,createdAt:timestamp,revealable:true}}
  list():ApiKeyRecord[]{return(this.db.prepare("SELECT * FROM api_keys WHERE owner_user_id=? ORDER BY created_at DESC").all(this.ownerUserId) as Row[]).map(apiKeyFromRow)}
  listWithCounts():ApiKeyRecord[]{return(this.db.prepare("SELECT k.*,COUNT(g.id) AS request_count FROM api_keys k LEFT JOIN gateway_requests g ON g.api_key_id=k.id AND g.owner_user_id=k.owner_user_id WHERE k.owner_user_id=? GROUP BY k.id ORDER BY k.created_at DESC").all(this.ownerUserId) as Row[]).map((row)=>({...apiKeyFromRow(row),requestCount:Number(row.request_count??"0")}))}
  reveal(id:string):string|null{const row=this.db.prepare("SELECT key_ciphertext FROM api_keys WHERE id=? AND owner_user_id=?").get(id,this.ownerUserId) as Row|undefined;const ciphertext=nullableString(row?.key_ciphertext??null);if(!ciphertext)return null;return this.vault.decrypt(ciphertext)}
  update(id:string,input:{name?:string;enabled?:boolean;allowedModels?:string[]|null}):ApiKeyRecord|null{const entries:[string,unknown][]=[];if(input.name!==undefined)entries.push(["name",input.name]);if(input.enabled!==undefined)entries.push(["enabled",Number(input.enabled)]);if(input.allowedModels!==undefined)entries.push(["allowed_models_json",input.allowedModels?JSON.stringify(input.allowedModels):null]);if(entries.length)this.db.prepare(`UPDATE api_keys SET ${entries.map(([key])=>`${key}=?`).join(",")},updated_at=? WHERE id=? AND owner_user_id=?`).run(...entries.map(([,value])=>value),nowIso(),id,this.ownerUserId);return this.list().find((key)=>key.id===id)??null}
  delete(id:string):boolean{return this.db.prepare("DELETE FROM api_keys WHERE id=? AND owner_user_id=?").run(id,this.ownerUserId).changes===1}
}
