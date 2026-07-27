import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { AccountRepository } from "./repository"
import { getSystemSettings, normalizeOfficialOpenCodeUpstreamUrl } from "./settings"
import type { AccountRecord, PoolType, QuotaKind, RouteSelection } from "./types"
import { tryGetProvider } from "./providers"
import { ModelRoutingRepository } from "./repository"
import { refreshStaleLocalRollingUsage, resolveXaiBlockSeconds } from "./quota-usage"

type Row = Record<string, unknown>
const nowIso = () => new Date().toISOString()

export class NoEligibleAccountError extends Error {
  constructor(readonly reason: "EXHAUSTED" | "NO_ELIGIBLE", readonly retryAfterSeconds?: number) {
    super(reason)
  }
}

// Pool types whose quota is a rolling window (e.g. the xAI free tier's
// rolling 24h token window). For these pools we balance load by the account
// with the most remaining quota rather than round-robining to ordinal, which
// would otherwise burn each account to 100% before moving on and waste the
// aggregated daily budget. Go/OpenAI pools keep ordinal behavior.
function isRollingDayPool(poolType: PoolType): boolean {
  return poolType === "xai-grok"
}

function isAccountReady(account: ReturnType<AccountRepository["list"]>[number]): boolean {
  const provider = tryGetProvider(account.poolType)
  if (provider) return provider.isAccountReady(account)
  return account.adminState === "ENABLED"
    && account.authState === "VALID"
    && account.subscriptionState === "ACTIVE"
    && account.billingGuard === "VERIFIED_GO_ONLY"
    && account.useBalance === false
}

function providerSupportsModel(poolType: PoolType, model: string | null, endpoint?: string): boolean {
  // No model on the request (e.g. non-inference endpoints) → every pool is fine.
  if (!model) return true
  const provider = tryGetProvider(poolType)
  if (!provider) return true
  if (endpoint && typeof provider.supportsEndpoint === "function") return provider.supportsEndpoint(model, endpoint)
  if (typeof provider.supportsModel === "function") return provider.supportsModel(model)
  // Prefer cached catalog when present; getAvailableModels already falls back to defaults.
  // Empty catalog means "unknown / no models", not "supports everything".
  const catalog = provider.getAvailableModels([])
  return catalog.includes(model)
}

export class RoutingService {
  private readonly accounts: AccountRepository
  private readonly modelRouting: ModelRoutingRepository
  private currentModel: string | null = null
  private constrainedPoolType: PoolType | null = null
  private constrainedAccountId: string | null = null

  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
    this.accounts = new AccountRepository(ownerUserId, db)
    this.modelRouting = new ModelRoutingRepository(ownerUserId, db)
  }

  getState() {
    this.db.prepare("INSERT OR IGNORE INTO routing_state(owner_user_id, updated_at) VALUES (?, ?)").run(this.ownerUserId, nowIso())
    const row = this.db.prepare("SELECT * FROM routing_state WHERE owner_user_id = ?").get(this.ownerUserId) as Row
    return {
      preferredAccountId: (row.preferred_account_id as string | null) ?? null,
      currentAccountId: (row.current_account_id as string | null) ?? null,
      cursorVersion: Number(row.cursor_version),
      updatedAt: String(row.updated_at),
    }
  }

  getPoolPreferences(): Record<string, string | null> {
    const rows = this.db.prepare("SELECT pool_type, preferred_account_id FROM pool_preferences WHERE owner_user_id = ?").all(this.ownerUserId) as { pool_type: string; preferred_account_id: string | null }[]
    const result: Record<string, string | null> = {}
    for (const row of rows) result[row.pool_type] = row.preferred_account_id
    return result
  }

  setPoolPreference(poolType: PoolType, accountId: string | null): void {
    const timestamp = nowIso()
    if (accountId && !this.accounts.get(accountId)) throw new Error("Account not found")
    this.db.prepare(`INSERT INTO pool_preferences(owner_user_id, pool_type, preferred_account_id, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(owner_user_id, pool_type) DO UPDATE SET preferred_account_id=excluded.preferred_account_id, updated_at=excluded.updated_at`)
      .run(this.ownerUserId, poolType, accountId, timestamp)
    this.event("POOL_PREFERENCE_CHANGED", "INFO", accountId, null, { poolType, preferredAccountId: accountId })
  }

  setPreferred(accountId: string | null) {
    if (accountId && !this.accounts.get(accountId)) throw new Error("Account not found")
    const timestamp = nowIso()
    this.getState()
    this.db.prepare(`UPDATE routing_state SET preferred_account_id = ?, current_account_id = COALESCE(?, current_account_id),
      cursor_version = cursor_version + 1, updated_at = ? WHERE owner_user_id = ?`)
      .run(accountId, accountId, timestamp, this.ownerUserId)
    this.event("ROUTING_PREFERENCE_CHANGED", "INFO", accountId, null, { preferredAccountId: accountId })
    return this.getState()
  }

  select(requestId: string, endpoint: string, triedAccountIds: Set<string>, now = new Date()): RouteSelection {
    return this.db.transaction(() => {
      const timestamp = now.toISOString()
      this.db.prepare("DELETE FROM route_leases WHERE owner_user_id = ? AND (completed_at IS NOT NULL OR expires_at <= ?)").run(this.ownerUserId, timestamp)
      const state = this.getState()
      const poolPrefs = this.getPoolPreferences()
      const all = this.accounts.list()
      // Repair rows written by versions that treated every xAI 429 as daily
      // token exhaustion. A positive persisted token remainder proves the 429
      // was only a temporary throttle; keep that cooldown separate and restore
      // the real rolling usage snapshot.
      this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
        SELECT q.owner_user_id,q.account_id,'PROVIDER_RATE_LIMIT',100,q.reset_at,'UPSTREAM_429',q.last_observed_at
        FROM quota_windows q JOIN accounts a ON a.id=q.account_id
        WHERE q.owner_user_id=? AND a.pool_type='xai-grok' AND q.kind='ROLLING_24H' AND q.source='UPSTREAM_429'
          AND q.limit_value>0 AND q.remaining_value>0
        ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET usage_percent=100,reset_at=excluded.reset_at,
          source='UPSTREAM_429',observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
        .run(this.ownerUserId)
      this.db.prepare(`UPDATE quota_windows SET
        usage_percent=MAX(0,MIN(100,((limit_value-remaining_value)*100.0)/limit_value)),reset_at=NULL,source='UPSTREAM_HEADER'
        WHERE owner_user_id=? AND kind='ROLLING_24H' AND source='UPSTREAM_429' AND limit_value>0 AND remaining_value>0`)
        .run(this.ownerUserId)
      // Legacy LOCAL_USAGE rows with no reset (or observations older than the
      // rolling window) can otherwise block accounts forever. Refresh only a
      // bounded stale batch; upstream cooldown rows are deliberately excluded.
      refreshStaleLocalRollingUsage(this.ownerUserId, this.db, now)
      const activeBlocks = this.db.prepare(`SELECT account_id, reset_at FROM quota_windows
        WHERE owner_user_id = ? AND usage_percent >= 100 AND (reset_at IS NULL OR reset_at > ?)`)
        .all(this.ownerUserId, timestamp) as { account_id: string; reset_at: string | null }[]
      const blocked = new Set(activeBlocks.map((row) => row.account_id))
      // Latest stored usage_percent for each account (any kind). Used to
      // balance load across rolling-window pool accounts instead of always
      // picking the lowest ordinal.
      const usageRows = this.db.prepare(`SELECT quota.account_id, quota.usage_percent
        FROM quota_windows quota
        INNER JOIN (
          SELECT account_id, MAX(last_observed_at) AS latest
          FROM quota_windows
          WHERE owner_user_id = ? AND kind = 'ROLLING_24H'
          GROUP BY account_id
        ) observed ON observed.account_id = quota.account_id AND observed.latest = quota.last_observed_at
        WHERE quota.owner_user_id = ? AND quota.kind = 'ROLLING_24H'`)
        .all(this.ownerUserId, this.ownerUserId) as { account_id: string; usage_percent: number | null }[]
      const usagePct = new Map<string, number>()
      for (const row of usageRows) {
        if (row.usage_percent != null) usagePct.set(row.account_id, Number(row.usage_percent))
      }
      const inFlight = new Map<string, number>()
      for (const row of this.db.prepare(`SELECT account_id, COUNT(*) AS count FROM route_leases
        WHERE owner_user_id = ? AND completed_at IS NULL AND expires_at > ? GROUP BY account_id`)
        .all(this.ownerUserId, timestamp) as { account_id: string; count: number }[]) {
        inFlight.set(row.account_id, Number(row.count))
      }

      const otherwiseEligible = all.filter(isAccountReady)
      // Prefer accounts whose provider can actually serve the requested model.
      // e.g. glm-* must not land on xAI just because the previous seat was xAI.
      const modelCapable = otherwiseEligible.filter((account) => providerSupportsModel(account.poolType, this.currentModel, endpoint))
      // When a model is present and no provider claims it, fail closed instead of
      // shipping the request to an incompatible upstream that will 404.
      if (this.currentModel && modelCapable.length === 0 && otherwiseEligible.length > 0) {
        throw new NoEligibleAccountError("NO_ELIGIBLE")
      }
      const unconstrainedCapabilityPool = modelCapable.length > 0 ? modelCapable : otherwiseEligible
      // A matching model-routing rule is an allow-list, not merely a sorting
      // hint. Keep only providers named by the rule (and capable of serving
      // the model) before applying request-level constraints and availability.
      const rawModelPriority = this.currentModel ? this.modelRouting.resolveModelPriority(this.currentModel) : null
      const modelPriority = rawModelPriority
        ? rawModelPriority.filter((pt) => providerSupportsModel(pt as PoolType, this.currentModel, endpoint))
        : null
      const allowedModelPools = modelPriority ? new Set(modelPriority) : null
      const routedCapabilityPool = allowedModelPools
        ? unconstrainedCapabilityPool.filter((account) => allowedModelPools.has(account.poolType))
        : unconstrainedCapabilityPool
      const capabilityPool = this.constrainedAccountId
        ? routedCapabilityPool.filter((account) => account.id === this.constrainedAccountId)
        : this.constrainedPoolType
          ? routedCapabilityPool.filter((account) => account.poolType === this.constrainedPoolType)
          : routedCapabilityPool
      if ((rawModelPriority || this.constrainedAccountId || this.constrainedPoolType) && capabilityPool.length === 0) {
        throw new NoEligibleAccountError("NO_ELIGIBLE")
      }
      const eligible = capabilityPool.filter((account) => !blocked.has(account.id)
        && !triedAccountIds.has(account.id)
        && (account.maxConcurrency <= 0 || (inFlight.get(account.id) ?? 0) < account.maxConcurrency))

      if (!eligible.length) {
        if (capabilityPool.length > 0 && capabilityPool.every((account) => blocked.has(account.id))) {
          const ids = new Set(capabilityPool.map((account) => account.id))
          const resetTimes = activeBlocks
            .filter((block) => ids.has(block.account_id) && block.reset_at)
            .map((block) => block.reset_at!)
            .sort()
          const retry = resetTimes[0]
            ? Math.max(1, Math.ceil((new Date(resetTimes[0]).getTime() - now.getTime()) / 1000))
            : undefined
          throw new NoEligibleAccountError("EXHAUSTED", retry)
        }
        throw new NoEligibleAccountError("NO_ELIGIBLE")
      }

      // Within the allowed set, preserve the configured pool order. An
      // explicit request constraint narrows that order to its selected pool.
      const constrainedPriority = this.constrainedAccountId
        ? capabilityPool[0]?.poolType
        : this.constrainedPoolType
      const rawPriority = constrainedPriority
        ? [constrainedPriority]
        : modelPriority
      const poolTypePriority = rawPriority && rawPriority.length > 0 ? rawPriority : null
      // For rolling-day pools (xAI free), pick the account with the most
      // remaining quota first to flatten the aggregated daily budget and avoid
      // burning each seat to 100% before moving on. Go/OpenAI pools keep the
      // stable ordinal ordering.
      const usageAwareCompare = (a: AccountRecord, b: AccountRecord): number => {
        if (a.poolType === b.poolType && isRollingDayPool(a.poolType)) {
          const aUsage = usagePct.get(a.id) ?? 0
          const bUsage = usagePct.get(b.id) ?? 0
          if (aUsage !== bUsage) return aUsage - bUsage
          return (a.lastSelectedAt ?? "").localeCompare(b.lastSelectedAt ?? "")
        }
        return a.ordinal - b.ordinal
      }
      let orderedEligible = eligible
      if (poolTypePriority && poolTypePriority.length > 0) {
        const poolTypeOrder = new Map<string, number>()
        poolTypePriority.forEach((pt, idx) => poolTypeOrder.set(pt, idx))
        orderedEligible = [...eligible].sort((a, b) => {
          const aIdx = poolTypeOrder.get(a.poolType) ?? Number.MAX_SAFE_INTEGER
          const bIdx = poolTypeOrder.get(b.poolType) ?? Number.MAX_SAFE_INTEGER
          if (aIdx !== bIdx) return aIdx - bIdx
          return usageAwareCompare(a, b)
        })
      }

      const byId = new Map(eligible.map((account) => [account.id, account]))
      const ordered = poolTypePriority && poolTypePriority.length > 0
        ? orderedEligible
        : [...eligible].sort(usageAwareCompare)
      let selected = state.preferredAccountId ? byId.get(state.preferredAccountId) : undefined
      if (selected && poolTypePriority && poolTypePriority.length > 0 && selected.poolType !== poolTypePriority[0]) selected = undefined
      // Per-pool-type preferred account
      if (!selected && poolTypePriority && poolTypePriority.length > 0) {
        const poolPref = poolPrefs[poolTypePriority[0] as PoolType]
        if (poolPref) selected = byId.get(poolPref)
      }
      if (!selected) {
        for (const prefId of Object.values(poolPrefs)) {
          if (prefId && byId.has(prefId)) { selected = byId.get(prefId); break }
        }
      }
      // A rolling-window pool must not stick to the previous account: doing
      // so would bypass the usage ordering above and keep burning one xAI
      // account until it reaches 100%. Explicit user preferences still win.
      if (!selected) {
        const current = state.currentAccountId ? byId.get(state.currentAccountId) : undefined
        if (current && !isRollingDayPool(current.poolType)) selected = current
        if (selected && poolTypePriority && poolTypePriority.length > 0 && selected.poolType !== poolTypePriority[0]) selected = undefined
      }
      if (!selected) {
        const priorityPool = poolTypePriority?.[0] as PoolType | undefined
        // Only stay inside a rolling-window pool when model routing explicitly
        // prioritizes it, or when every eligible account is rolling. Do NOT
        // inherit the previous request's xAI seat for unrelated models
        // (e.g. glm after grok), otherwise unmatched models keep 404ing on xAI.
        const rollingPool = priorityPool && isRollingDayPool(priorityPool)
          ? priorityPool
          : eligible.every((account) => isRollingDayPool(account.poolType))
            ? eligible[0].poolType
            : null
        if (rollingPool) {
          selected = ordered.filter((account) => account.poolType === rollingPool).sort(usageAwareCompare)[0]
          // Priority pool exhausted: fall through to any other compatible
          // candidate. `eligible` has already applied explicit account/pool
          // constraints, so this cannot escape a request-level constraint.
          if (!selected) {
            selected = ordered.find((account) => account.poolType !== rollingPool) ?? ordered[0]
          }
        } else {
          // Mixed pools without a model rule: prefer non-rolling accounts so a
          // previous grok/xAI request cannot pin subsequent glm traffic.
          const candidates = ordered.some((account) => !isRollingDayPool(account.poolType))
            ? ordered.filter((account) => !isRollingDayPool(account.poolType))
            : ordered
          const anchorAccount = all.find((account) => account.id === (state.currentAccountId ?? state.preferredAccountId))
          const anchor = anchorAccount && candidates.some((account) => account.id === anchorAccount.id)
            ? anchorAccount.ordinal
            : -1
          selected = candidates.find((account) => account.ordinal > anchor) ?? candidates[0]
        }
      }

      if (!selected) throw new NoEligibleAccountError("NO_ELIGIBLE")
      const leaseId = randomUUID()
      this.db.prepare(`INSERT INTO route_leases(id, owner_user_id, request_id, account_id, credential_version, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(leaseId, this.ownerUserId, requestId, selected.id, selected.credentialVersion, new Date(now.getTime() + 10 * 60_000).toISOString(), timestamp)
      this.db.prepare("UPDATE accounts SET last_selected_at=?, last_request_at=?, updated_at=? WHERE id=? AND owner_user_id=?")
        .run(timestamp, timestamp, timestamp, selected.id, this.ownerUserId)
      if (state.currentAccountId !== selected.id) {
        this.db.prepare("UPDATE routing_state SET current_account_id=?, cursor_version=cursor_version+1, updated_at=? WHERE owner_user_id=?")
          .run(selected.id, timestamp, this.ownerUserId)
      }
      const settings = getSystemSettings(this.db)
      return { account: selected, leaseId, target: { baseUrl: normalizeOfficialOpenCodeUpstreamUrl(settings.upstreamBaseUrl), authStyle: "BEARER" as const } }
    })()
  }

  setModel(model: string | null): void { this.currentModel = model }

  /** Constrain one request without mutating the user's persistent routing preferences. */
  setRequestConstraint(input: { poolType?: PoolType | null; accountId?: string | null }): void {
    this.constrainedPoolType = input.poolType ?? null
    this.constrainedAccountId = input.accountId ?? null
  }

  releaseLease(leaseId: string): void {
    this.db.prepare("UPDATE route_leases SET completed_at=? WHERE id=? AND owner_user_id=? AND completed_at IS NULL")
      .run(nowIso(), leaseId, this.ownerUserId)
  }

  markSuccess(accountId: string): void {
    const timestamp = nowIso()
    this.db.prepare("UPDATE accounts SET last_success_at=?, updated_at=? WHERE id=? AND owner_user_id=?")
      .run(timestamp, timestamp, accountId, this.ownerUserId)
    // Clear expired blocks always. For temporary provider rate-limits, a live
    // success is strong evidence the cooldown is stale, so clear those early
    // (sub2api-style recovery). Keep hard ROLLING_24H over-quota blocks until
    // their reset time unless they already expired.
    this.db.prepare(`DELETE FROM quota_windows
      WHERE account_id=? AND owner_user_id=? AND usage_percent>=100 AND (
        (reset_at IS NOT NULL AND reset_at<=?)
        OR kind='PROVIDER_RATE_LIMIT'
      )`).run(accountId, this.ownerUserId, timestamp)
  }

  markQuota(accountId: string, kind: QuotaKind, retryAfterSeconds: number | null, now = new Date()): void {
    const timestamp = now.toISOString()
    const account = this.accounts.get(accountId)
    const previous = this.db.prepare(`SELECT last_observed_at, reset_at, kind FROM quota_windows
      WHERE owner_user_id=? AND account_id=? AND usage_percent>=100
      ORDER BY last_observed_at DESC LIMIT 1`).get(this.ownerUserId, accountId) as {
      last_observed_at: string | null
      reset_at: string | null
      kind: string | null
    } | undefined

    let kindToStore: QuotaKind = kind
    let retry = retryAfterSeconds && retryAfterSeconds > 0 && retryAfterSeconds <= 45 * 86400 ? retryAfterSeconds : 60
    let dayUnavailable = false
    let blockReason: string | null = null
    let consecutiveFailures = 0

    if (account?.poolType === "xai-grok") {
      const failureRow = this.db.prepare(`SELECT COUNT(*) AS value FROM events
        WHERE owner_user_id=? AND account_id=? AND type='ACCOUNT_QUOTA_BLOCKED'
          AND (? IS NULL OR created_at>?)`).get(this.ownerUserId, accountId, account.lastSuccessAt, account.lastSuccessAt) as { value: number }
      consecutiveFailures = Number(failureRow.value) + 1
      const decision = resolveXaiBlockSeconds({
        accountId,
        suggestedSeconds: retryAfterSeconds,
        previousLimitedAt: previous?.last_observed_at,
        previousResetAt: previous?.reset_at,
        consecutiveFailures,
        now,
        db: this.db,
      })
      dayUnavailable = decision.dayUnavailable
      kindToStore = dayUnavailable ? "ROLLING_24H" : (kind === "ROLLING_24H" ? "PROVIDER_RATE_LIMIT" : kind)
      retry = decision.seconds
      blockReason = decision.reason
      // Never shorten an already longer active block for the same account.
      if (previous?.reset_at) {
        const previousResetMs = Date.parse(previous.reset_at)
        const candidateMs = now.getTime() + retry * 1000
        if (Number.isFinite(previousResetMs) && previousResetMs > candidateMs) {
          retry = Math.max(60, Math.ceil((previousResetMs - now.getTime()) / 1000))
        }
      }
    }

    const resetAt = new Date(now.getTime() + retry * 1000 + 1000).toISOString()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
        VALUES(?,?,?,100,?,'UPSTREAM_429',?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
        usage_percent=MAX(usage_percent, 100),
        reset_at=excluded.reset_at,
        source='UPSTREAM_429',
        observation_version=observation_version+1,
        last_observed_at=excluded.last_observed_at`)
        .run(this.ownerUserId, accountId, kindToStore, resetAt, timestamp)
      this.db.prepare("UPDATE accounts SET last_limit_at=?, updated_at=? WHERE id=? AND owner_user_id=?")
        .run(timestamp, timestamp, accountId, this.ownerUserId)
      const state = this.getState()
      if (state.currentAccountId === accountId) {
        this.db.prepare("UPDATE routing_state SET current_account_id=NULL,cursor_version=cursor_version+1,updated_at=? WHERE owner_user_id=?")
          .run(timestamp, this.ownerUserId)
      }
      this.event("ACCOUNT_QUOTA_BLOCKED", "WARN", accountId, null, {
        kind: kindToStore,
        resetAt,
        retryAfterSeconds: retry,
        dayUnavailable,
        localUsageOverQuota: dayUnavailable,
        blockReason,
        consecutiveFailures,
      })
    })()
  }

  markPermanentlyDisabled(accountId: string, reason: string, message: string): void {
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE accounts SET admin_state='DISABLED',auth_state='AUTH_ERROR',disabled_reason=?,disabled_at=?,last_error=?,updated_at=? WHERE id=? AND owner_user_id=?`)
        .run(reason, timestamp, message.slice(0, 500), timestamp, accountId, this.ownerUserId)
      this.db.prepare("UPDATE routing_state SET current_account_id=CASE WHEN current_account_id=? THEN NULL ELSE current_account_id END,preferred_account_id=CASE WHEN preferred_account_id=? THEN NULL ELSE preferred_account_id END,cursor_version=cursor_version+1,updated_at=? WHERE owner_user_id=?")
        .run(accountId, accountId, timestamp, this.ownerUserId)
      this.event("ACCOUNT_PERMANENTLY_DISABLED", "ERROR", accountId, null, { reason, message: message.slice(0, 500) })
    })()
  }

  event(type: string, severity: "INFO" | "WARN" | "ERROR", accountId: string | null, requestId: string | null, metadata: unknown): void {
    this.db.prepare("INSERT INTO events(id,owner_user_id,type,severity,account_id,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), this.ownerUserId, type, severity, accountId, requestId, JSON.stringify(metadata ?? {}), nowIso())
  }

  getPoolTypeStats(): Record<string, { total: number; ready: number; blocked: number; inactive: number }> {
    const all = this.accounts.list()
    const stats: Record<string, { total: number; ready: number; blocked: number; inactive: number }> = {}
    const timestamp = nowIso()
    const blockedRows = this.db.prepare(`SELECT DISTINCT account_id FROM quota_windows
      WHERE owner_user_id = ? AND usage_percent >= 100 AND (reset_at IS NULL OR reset_at > ?)`).all(this.ownerUserId, timestamp) as { account_id: string }[]
    const blockedSet = new Set(blockedRows.map((r) => r.account_id))
    for (const account of all) {
      const pt = account.poolType
      if (!stats[pt]) stats[pt] = { total: 0, ready: 0, blocked: 0, inactive: 0 }
      stats[pt].total++
      if (isAccountReady(account)) {
        if (blockedSet.has(account.id)) stats[pt].blocked++
        else stats[pt].ready++
      } else {
        stats[pt].inactive++
      }
    }
    return stats
  }
}
