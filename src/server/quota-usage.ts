import type { AppDatabase } from "./db"
import { getDatabase } from "./db"

export const XAI_DEFAULT_TOKEN_LIMIT = 1_000_000
export const XAI_HARD_BLOCK_TOKEN_THRESHOLD = 900_000
export const XAI_CONSECUTIVE_FAILURE_LIMIT = 3
export const XAI_FIXED_BLOCK_SECONDS = 24 * 60 * 60
export const ROLLING_WINDOW_MS = 24 * 60 * 60_000

// Temporary rate-limit backoff ladder (inspired by sub2api).
export const XAI_RATE_LIMIT_FALLBACK_SECONDS = 2 * 60
export const XAI_RATE_LIMIT_REPEAT_SECONDS = 10 * 60
export const XAI_RATE_LIMIT_SUSTAINED_SECONDS = 30 * 60
export const XAI_RATE_LIMIT_MAX_SECONDS = 60 * 60
export const XAI_RATE_LIMIT_QUIET_PERIOD_MS = 60 * 60_000

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  // Allow >100% so over-limit free-tier accounts show real consumption
  // (e.g. a final large request can push rolling usage past 1M).
  return Math.round(Math.max(0, value) * 100) / 100
}

export function computeLocalRollingUsage(accountId: string, db: AppDatabase = getDatabase(), now = new Date()): {
  usedTokens: number
  limitTokens: number
  remainingTokens: number
  usagePercent: number
  windowStartedAt: string
} {
  const windowStartedAt = new Date(now.getTime() - ROLLING_WINDOW_MS).toISOString()
  const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(total_tokens,0)), 0) AS used
    FROM gateway_requests
    WHERE account_id=? AND ok=1 AND started_at>=?`).get(accountId, windowStartedAt) as { used: number }
  const usedTokens = Math.max(0, Number(row?.used ?? 0))

  const existing = db.prepare(`SELECT limit_value FROM quota_windows
    WHERE account_id=? AND kind='ROLLING_24H' AND limit_value IS NOT NULL AND limit_value>0
    ORDER BY last_observed_at DESC LIMIT 1`).get(accountId) as { limit_value: number } | undefined
  const limitTokens = Math.max(1, Number(existing?.limit_value ?? XAI_DEFAULT_TOKEN_LIMIT))
  // Keep signed remaining so over-limit usage is still visible (e.g. -476236).
  const remainingTokens = limitTokens - usedTokens
  const usagePercent = roundPercent((usedTokens / limitTokens) * 100)
  return { usedTokens, limitTokens, remainingTokens, usagePercent, windowStartedAt }
}

export function upsertLocalRollingUsage(ownerUserId: string, accountId: string, db: AppDatabase = getDatabase(), now = new Date()): {
  usagePercent: number
  limitValue: number
  remainingValue: number
} {
  const snapshot = computeLocalRollingUsage(accountId, db, now)
  const timestamp = now.toISOString()
  const previous = db.prepare(`SELECT usage_percent, remaining_value, limit_value, reset_at, source FROM quota_windows
    WHERE owner_user_id=? AND account_id=? AND kind='ROLLING_24H'`).get(ownerUserId, accountId) as {
    usage_percent: number | null
    remaining_value: number | null
    limit_value: number | null
    reset_at: string | null
    source: string | null
  } | undefined
  const previousResetMs = previous?.reset_at ? Date.parse(previous.reset_at) : Number.NaN
  const previousExpired = Number.isFinite(previousResetMs) && previousResetMs <= now.getTime()
  const hardBlocked = snapshot.usedTokens >= XAI_HARD_BLOCK_TOKEN_THRESHOLD
  const limitValue = Math.max(snapshot.limitTokens, Number(previous?.limit_value ?? 0) || snapshot.limitTokens)
  const previousUsage = previousExpired ? 0 : Number(previous?.usage_percent ?? 0)
  // LOCAL_USAGE is a rolling snapshot, so it must be allowed to fall as old
  // requests leave the 24-hour window. Only a stronger upstream observation
  // may hold a higher value than the local snapshot.
  const preserveUpstream = previous?.source !== "LOCAL_USAGE" && previousUsage > snapshot.usagePercent
  const clampedUsage = hardBlocked ? Math.max(100, snapshot.usagePercent) : preserveUpstream ? previousUsage : snapshot.usagePercent
  const signedRemaining = hardBlocked
    ? Math.min(0, limitValue - Math.round((clampedUsage / 100) * limitValue))
    : preserveUpstream && previous?.remaining_value != null
      ? Number(previous.remaining_value)
      : limitValue - Math.round((clampedUsage / 100) * limitValue)
  const activePreviousReset = Number.isFinite(previousResetMs) && previousResetMs > now.getTime() ? previous!.reset_at : null
  const resetAt = hardBlocked
    ? activePreviousReset ?? new Date(now.getTime() + XAI_FIXED_BLOCK_SECONDS * 1000).toISOString()
    : preserveUpstream ? previous?.reset_at ?? null : null
  const source = preserveUpstream ? previous?.source ?? "LOCAL_USAGE" : "LOCAL_USAGE"

  db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
    VALUES(?,?,'ROLLING_24H',?,?,?,?,?,?)
    ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
      usage_percent=excluded.usage_percent,
      reset_at=excluded.reset_at,
      source=excluded.source,
      last_observed_at=excluded.last_observed_at,
      limit_value=excluded.limit_value,
      remaining_value=excluded.remaining_value,
      observation_version=observation_version+1`)
    .run(ownerUserId, accountId, clampedUsage, resetAt, source, timestamp, limitValue, signedRemaining)
  return { usagePercent: clampedUsage, limitValue, remainingValue: signedRemaining }
}

/** Refresh a bounded batch of legacy/stale local blocks before routing. */
export function refreshStaleLocalRollingUsage(ownerUserId: string, db: AppDatabase = getDatabase(), now = new Date(), limit = 100): number {
  const staleBefore = new Date(now.getTime() - ROLLING_WINDOW_MS).toISOString()
  const rows = db.prepare(`SELECT q.account_id
    FROM quota_windows q JOIN accounts a ON a.id=q.account_id AND a.owner_user_id=q.owner_user_id
    WHERE q.owner_user_id=? AND a.pool_type='xai-grok'
      AND q.kind='ROLLING_24H' AND q.source='LOCAL_USAGE' AND q.usage_percent>=100
      AND (q.reset_at IS NULL OR q.last_observed_at<=?)
    ORDER BY q.last_observed_at ASC LIMIT ?`).all(ownerUserId, staleBefore, Math.max(1, Math.min(500, Math.trunc(limit)))) as Array<{ account_id: string }>
  for (const row of rows) upsertLocalRollingUsage(ownerUserId, row.account_id, db, now)
  return rows.length
}

export function isLocallyOverQuota(accountId: string, db: AppDatabase = getDatabase(), now = new Date()): boolean {
  return computeLocalRollingUsage(accountId, db, now).usedTokens >= XAI_HARD_BLOCK_TOKEN_THRESHOLD
}

/**
 * Seconds until local rolling usage falls back under the free-tier limit.
 *
 * Unlike "wait for the oldest request to age out", this walks requests from
 * oldest to newest and stops as soon as enough tokens have aged out for the
 * remaining sum to drop below the limit. That avoids waiting a full day when
 * only a little overage needs to roll off.
 */
export function secondsUntilUsageBelowLimit(accountId: string, db: AppDatabase = getDatabase(), now = new Date()): number {
  const snapshot = computeLocalRollingUsage(accountId, db, now)
  if (snapshot.usedTokens < snapshot.limitTokens) return 60

  const rows = db.prepare(`SELECT started_at, COALESCE(total_tokens, 0) AS tokens
    FROM gateway_requests
    WHERE account_id=? AND ok=1 AND started_at>=?
    ORDER BY started_at ASC`).all(accountId, snapshot.windowStartedAt) as Array<{ started_at: string; tokens: number }>

  let used = snapshot.usedTokens
  for (const row of rows) {
    const startedMs = Date.parse(row.started_at)
    if (!Number.isFinite(startedMs)) continue
    used = Math.max(0, used - Math.max(0, Number(row.tokens || 0)))
    if (used < snapshot.limitTokens) {
      const reliefAt = startedMs + ROLLING_WINDOW_MS
      return Math.max(60, Math.ceil((reliefAt - now.getTime()) / 1000))
    }
  }
  return 24 * 60 * 60
}

/** @deprecated Prefer secondsUntilUsageBelowLimit; kept as a readable alias. */
export function secondsUntilRollingWindowRelief(accountId: string, db: AppDatabase = getDatabase(), now = new Date()): number {
  return secondsUntilUsageBelowLimit(accountId, db, now)
}

function clampRetrySeconds(value: number | null | undefined, fallback: number, options?: { allowShorterThanFallback?: boolean }): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback
  const rounded = Math.max(1, Math.min(45 * 86_400, Math.round(value)))
  if (options?.allowShorterThanFallback) return rounded
  return Math.max(fallback, rounded)
}

/**
 * Temporary 429 backoff for accounts that are NOT already over the local 1M
 * rolling budget. Escalates when the account was rate-limited again soon after
 * the previous cooldown (sub2api-style adaptive ladder).
 */
export function computeAdaptiveRateLimitSeconds(input: {
  suggestedSeconds?: number | null
  previousLimitedAt?: string | null
  previousResetAt?: string | null
  now?: Date
}): number {
  const now = input.now ?? new Date()
  // Temporary throttles may legitimately be shorter than the fallback ladder.
  const base = clampRetrySeconds(input.suggestedSeconds, XAI_RATE_LIMIT_FALLBACK_SECONDS, { allowShorterThanFallback: true })

  const previousResetMs = input.previousResetAt ? Date.parse(input.previousResetAt) : Number.NaN
  const previousLimitedMs = input.previousLimitedAt ? Date.parse(input.previousLimitedAt) : Number.NaN
  if (!Number.isFinite(previousResetMs) || !Number.isFinite(previousLimitedMs)) return base

  // Still cooling, or cooled down only recently: escalate.
  const quiet = now.getTime() - previousResetMs
  if (previousResetMs > now.getTime() || quiet <= XAI_RATE_LIMIT_QUIET_PERIOD_MS) {
    const previousDurationSec = Math.max(0, Math.round((previousResetMs - previousLimitedMs) / 1000))
    let adaptive = XAI_RATE_LIMIT_REPEAT_SECONDS
    if (previousDurationSec >= XAI_RATE_LIMIT_SUSTAINED_SECONDS) adaptive = XAI_RATE_LIMIT_MAX_SECONDS
    else if (previousDurationSec >= XAI_RATE_LIMIT_REPEAT_SECONDS) adaptive = XAI_RATE_LIMIT_SUSTAINED_SECONDS
    return Math.max(base, adaptive)
  }
  return base
}

/**
 * Decide how long an xAI free account should stay blocked after an upstream error.
 *
 * Priority:
 * 1. Three consecutive switchable failures: fixed 24h block
 * 2. Local rolling usage at or above 900k: fixed 24h block
 * 3. Otherwise: upstream hint or adaptive short/medium cooldown
 */
export function resolveXaiBlockSeconds(input: {
  accountId: string
  suggestedSeconds?: number | null
  previousLimitedAt?: string | null
  previousResetAt?: string | null
  now?: Date
  db?: AppDatabase
  consecutiveFailures?: number
}): { seconds: number; dayUnavailable: boolean; reason: "header" | "local_threshold" | "consecutive_failures" | "adaptive" } {
  const db = input.db ?? getDatabase()
  const now = input.now ?? new Date()
  const over = isLocallyOverQuota(input.accountId, db, now)
  const header = input.suggestedSeconds != null && Number.isFinite(input.suggestedSeconds) && input.suggestedSeconds > 0
    ? clampRetrySeconds(input.suggestedSeconds, XAI_RATE_LIMIT_FALLBACK_SECONDS, { allowShorterThanFallback: true })
    : null

  if ((input.consecutiveFailures ?? 0) >= XAI_CONSECUTIVE_FAILURE_LIMIT) return { seconds: XAI_FIXED_BLOCK_SECONDS, dayUnavailable: true, reason: "consecutive_failures" }
  if (over) return { seconds: XAI_FIXED_BLOCK_SECONDS, dayUnavailable: true, reason: "local_threshold" }

  return {
    seconds: computeAdaptiveRateLimitSeconds({
      suggestedSeconds: header,
      previousLimitedAt: input.previousLimitedAt,
      previousResetAt: input.previousResetAt,
      now,
    }),
    dayUnavailable: false,
    reason: header != null ? "header" : "adaptive",
  }
}
