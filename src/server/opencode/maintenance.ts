import { getDatabase } from "@/server/db"
import { getOpenCodeWebService, type OpenCodeWebService } from "@/server/opencode-web/service"
import { listDueUsageCandidates } from "@/server/repository"
import { getSystemSettings } from "@/server/settings"
import { syncProviderAccount } from "@/server/provider-sync"
import { cleanupMedia } from "@/server/media-store"

export interface RefreshUsageBatchResult {
  attempted: number
  refreshed: number
  failed: number
  failures: { accountId: string; message: string }[]
}

export async function refreshDueUsage(options: {
  limit?: number
  concurrency?: number
  now?: Date
  serviceFactory?: (ownerUserId: string) => OpenCodeWebService
} = {}): Promise<RefreshUsageBatchResult> {
  const db = getDatabase()
  const due = listDueUsageCandidates(db, options.now ?? new Date(), options.limit ?? 25)
  const failures: RefreshUsageBatchResult["failures"] = []
  let refreshed = 0
  const queue = [...due]
  const serviceFactory = options.serviceFactory ?? getOpenCodeWebService
  const db2 = getDatabase()
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, due.length || 1)) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        if (item.poolType === "opencode-go") {
          await serviceFactory(item.ownerUserId).refreshUsage(item.accountId)
        } else {
          await syncProviderAccount(item.ownerUserId, item.accountId, db2)
        }
        refreshed += 1
      } catch (cause) {
        failures.push({ accountId: item.accountId, message: cause instanceof Error ? cause.message : "Usage refresh failed" })
      }
    }
  })
  await Promise.all(workers)
  return { attempted: due.length, refreshed, failed: failures.length, failures }
}

const schedulerGlobal = globalThis as typeof globalThis & {
  __opencodeUsageScheduler?: ReturnType<typeof setInterval>
  __opencodeUsageSchedulerState?: { nextRunAt: number; lastIntervalMs: number; running: boolean }
}

export function startMaintenanceScheduler(options: { intervalMs?: number; runImmediately?: boolean } = {}) {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return
  if (schedulerGlobal.__opencodeUsageScheduler) return schedulerGlobal.__opencodeUsageScheduler
  const state = (schedulerGlobal.__opencodeUsageSchedulerState ??= { nextRunAt: 0, lastIntervalMs: 0, running: false })
  const tick = async () => {
    const settings = getSystemSettings(getDatabase())
    if (!settings.maintenanceEnabled) { state.nextRunAt = 0; state.lastIntervalMs = settings.maintenanceIntervalMs; return }
    const now = Date.now()
    if (state.lastIntervalMs !== settings.maintenanceIntervalMs) {
      state.nextRunAt = Math.min(state.nextRunAt || now, now + settings.maintenanceIntervalMs)
      state.lastIntervalMs = settings.maintenanceIntervalMs
    }
    if (state.running || now < state.nextRunAt) return
    state.nextRunAt = now + settings.maintenanceIntervalMs
    state.running = true
    try {
      await refreshDueUsage({ limit: settings.refreshBatchLimit, concurrency: settings.refreshConcurrency })
      const cleanup = cleanupMedia(getDatabase())
      if (cleanup.expiredRemoved > 0 || cleanup.overCapacityRemoved > 0) {
        console.log(`[media-maintenance] cleaned ${cleanup.expiredRemoved} expired, ${cleanup.overCapacityRemoved} over-capacity; remaining ${cleanup.remainingBytes} bytes`)
      }
    }
    catch (error) { console.error("[usage-maintenance] refresh failed", error instanceof Error ? error.message : "Unknown error") }
    finally { state.running = false }
  }
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5_000)
  timer.unref?.()
  schedulerGlobal.__opencodeUsageScheduler = timer
  if (options.runImmediately) void tick()
  return timer
}
