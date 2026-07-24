import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { tryGetProvider } from "./providers"
import { XAIAccountBannedError } from "./providers/xai-grok"
import { AccountRepository } from "./repository"
import { RoutingService } from "./routing"
import { upsertLocalRollingUsage } from "./quota-usage"
import { InvalidCustomProviderCredentialError } from "./providers/custom"

export async function syncProviderAccount(ownerUserId: string, accountId: string, db: AppDatabase = getDatabase()) {
  const accounts = new AccountRepository(ownerUserId, db)
  const account = accounts.get(accountId)
  if (!account) throw new Error("账号不存在")
  const provider = tryGetProvider(account.poolType)
  if (!provider) throw new Error(`号池 ${account.poolType} 不支持主动同步`)

  try {
    const windows = await provider.refreshQuota(accountId, account)
    const timestamp = new Date().toISOString()
    db.transaction(() => {
      for (const window of windows) {
        // xAI free probe often returns remaining=limit (0% used) even after heavy
        // traffic. Don't let that overwrite a higher local/previous usage snapshot.
        if (
          account.poolType === "xai-grok"
          && window.kind === "ROLLING_24H"
          && window.limitValue
          && window.remainingValue != null
          && window.limitValue === window.remainingValue
          && window.usagePercent === 0
        ) {
          continue
        }
        const conflictUpdate = account.poolType.startsWith("custom:")
          ? `usage_percent=excluded.usage_percent,
          reset_at=excluded.reset_at,
          source=excluded.source,
          limit_value=excluded.limit_value,
          remaining_value=excluded.remaining_value,
          unit=excluded.unit,
          observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`
          : `usage_percent=MAX(usage_percent, excluded.usage_percent),
          reset_at=excluded.reset_at,
          source=CASE WHEN excluded.usage_percent >= usage_percent THEN excluded.source ELSE source END,
          limit_value=COALESCE(excluded.limit_value, limit_value),
          remaining_value=CASE
            WHEN excluded.remaining_value IS NULL THEN remaining_value
            WHEN remaining_value IS NULL THEN excluded.remaining_value
            ELSE MIN(remaining_value, excluded.remaining_value)
          END,
          unit=COALESCE(excluded.unit, unit),
          observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`
        db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value,unit)
          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
          ${conflictUpdate}`)
          .run(ownerUserId, accountId, window.kind, window.usagePercent, window.resetAt, window.source, window.lastObservedAt, window.limitValue ?? null, window.remainingValue ?? null, window.unit ?? null)
      }
      if (account.poolType === "xai-grok") {
        upsertLocalRollingUsage(ownerUserId, accountId, db)
      }
      db.prepare(`UPDATE accounts SET last_usage_check_at=?,last_synced_at=?,next_usage_check_at=?,auth_state='VALID',last_error=NULL,updated_at=? WHERE id=? AND owner_user_id=?`)
        .run(timestamp, timestamp, new Date(Date.now() + 5 * 60_000).toISOString(), timestamp, accountId, ownerUserId)
    })()
  } catch (cause) {
    if (cause instanceof XAIAccountBannedError) {
      new RoutingService(ownerUserId, db).markPermanentlyDisabled(accountId, "XAI_ACCOUNT_BANNED", cause.message)
    } else if (cause instanceof InvalidCustomProviderCredentialError) {
      accounts.updateState(accountId, { authState: "REAUTH_REQUIRED", lastError: cause.message })
    } else {
      accounts.updateState(accountId, { lastError: cause instanceof Error ? cause.message : "账号同步失败" })
    }
    throw cause
  }

  const refreshed = accounts.get(accountId)
  const quotaWindows = db.prepare(`SELECT kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value,unit
    FROM quota_windows WHERE owner_user_id=? AND account_id=? ORDER BY last_observed_at DESC`).all(ownerUserId, accountId) as Record<string, unknown>[]
  return {
    account: refreshed ? {
      ...refreshed,
      quotaWindows: quotaWindows.map((window) => ({
        kind: window.kind,
        usagePercent: window.usage_percent,
        resetAt: window.reset_at,
        source: window.source,
        lastObservedAt: window.last_observed_at,
        limitValue: window.limit_value,
        remainingValue: window.remaining_value,
        unit: window.unit,
      })),
    } : null,
  }
}
