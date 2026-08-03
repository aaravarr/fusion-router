import { AccountRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { requireSession } from "../_auth"
import { RoutingService } from "@/server/routing"
import { tryGetProvider } from "@/server/providers"
import { listPoolTypeOptions } from "@/server/pool-type-options"
import type { AccountListSort, AccountListStatusFilter } from "@/server/repository"
import { CustomProviderRepository } from "@/server/custom-providers"
import { deriveAccountRouteStatus } from "@/server/account-route-state"

export const runtime = "nodejs"

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(max, Math.round(parsed))
}

function parseOptionalPageSize(value: string | null): number | null {
  if (value === null) return null
  return parsePositiveInt(value, 50, 500)
}

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const url = new URL(request.url)
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 10_000)
  const pageSize = parseOptionalPageSize(url.searchParams.get("pageSize"))
  const q = url.searchParams.get("q")
  const poolType = url.searchParams.get("poolType")
  const status = (url.searchParams.get("status") || "all") as AccountListStatusFilter
  const sort = (url.searchParams.get("sort") || "recent") as AccountListSort

  const db = getDatabase()
  const repo = new AccountRepository(user.id, db)
  const customProviders = new CustomProviderRepository(user.id, db).list()
  const customProviderEnabled = new Map(customProviders.map((customProvider) => [customProvider.poolType, customProvider.enabled]))
  const listed = repo.listPage({ page, pageSize, q, poolType, status, sort })
  const routing = new RoutingService(user.id, db).getState()
  const windows = repo.listQuotaWindows(listed.items.map((account) => account.id))
  const windowsByAccount = new Map<string, typeof windows>()
  for (const window of windows) {
    const list = windowsByAccount.get(window.accountId) ?? []
    list.push(window)
    windowsByAccount.set(window.accountId, list)
  }
  const now = Date.now()

  const accounts = listed.items.map((account) => {
    const provider = tryGetProvider(account.poolType)
    const accountWindows = windowsByAccount.get(account.id) ?? []
    const customEnabled = account.poolType.startsWith("custom:") ? customProviderEnabled.get(account.poolType) === true : true
    const providerReady = customEnabled && Boolean(provider?.isAccountReady(account))
    const providerUnavailableReason = account.poolType.startsWith("custom:") && !customEnabled
      ? "自定义 Provider 已停用"
      : provider ? "Provider 规则判定该账号不可参与路由" : "未找到对应的 Provider"
    const routeStatus = deriveAccountRouteStatus(account, accountWindows, now, { providerReady, providerUnavailableReason })
    return {
      ...account,
      poolLabel: provider?.displayName ?? account.poolType,
      enabled: account.adminState === "ENABLED",
      isCurrent: routing.currentAccountId === account.id,
      isPreferred: routing.preferredAccountId === account.id,
      ...routeStatus,
      // Compatibility fields for older clients. New UI uses routeState exclusively.
      routingBlocked: routeStatus.routeState === "TEMP_BLOCKED",
      routingBlockedUntil: routeStatus.blockedUntil,
      routingEligible: routeStatus.routeState === "READY",
      quotaWindows: accountWindows.map((window) => ({
        kind: window.kind,
        usagePercent: window.usagePercent,
        resetAt: window.resetAt,
        source: window.source,
        lastObservedAt: window.lastObservedAt,
        limitValue: window.limitValue,
        remainingValue: window.remainingValue,
        unit: window.unit,
      })),
    }
  })

  return Response.json({
    items: accounts,
    accounts,
    total: listed.total,
    page: listed.page,
    pageSize: listed.pageSize,
    stats: listed.stats,
    poolTypes: listPoolTypeOptions(user.id, db),
    poolPreferences: new RoutingService(user.id, db).getPoolPreferences(),
  })
}
