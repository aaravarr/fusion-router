import { AccountRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { requireSession } from "../_auth"
import { RoutingService } from "@/server/routing"
import { tryGetProvider, POOL_TYPE_METADATA } from "@/server/providers"
import type { AccountListSort, AccountListStatusFilter } from "@/server/repository"
import { CustomProviderRepository } from "@/server/custom-providers"

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
  const listed = repo.listPage({ page, pageSize, q, poolType, status, sort })
  const routing = new RoutingService(user.id, db).getState()
  const windows = repo.listQuotaWindows(listed.items.map((account) => account.id))
  const windowsByAccount = new Map<string, typeof windows>()
  for (const window of windows) {
    const list = windowsByAccount.get(window.accountId) ?? []
    list.push(window)
    windowsByAccount.set(window.accountId, list)
  }

  const accounts = listed.items.map((account) => {
    const provider = tryGetProvider(account.poolType)
    return {
      ...account,
      enabled: account.adminState === "ENABLED",
      isCurrent: routing.currentAccountId === account.id,
      isPreferred: routing.preferredAccountId === account.id,
      routingEligible: provider
        ? provider.isAccountReady(account)
        : account.adminState === "ENABLED"
          && account.authState === "VALID"
          && account.subscriptionState === "ACTIVE"
          && account.billingGuard === "VERIFIED_GO_ONLY"
          && account.useBalance === false,
      quotaWindows: (windowsByAccount.get(account.id) ?? []).map((window) => ({
        kind: window.kind,
        usagePercent: window.usagePercent,
        resetAt: window.resetAt,
        source: window.source,
        lastObservedAt: window.lastObservedAt,
        limitValue: window.limitValue,
        remainingValue: window.remainingValue,
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
    poolTypes: [...Object.keys(POOL_TYPE_METADATA).map((key) => {
      const meta = POOL_TYPE_METADATA[key as keyof typeof POOL_TYPE_METADATA]
      if (!meta) return null
      return {
        type: meta.type,
        label: meta.label,
        description: meta.description,
        quotaKinds: meta.quotaKinds,
        credentialFields: meta.credentialFields,
      }
    }).filter(Boolean), ...new CustomProviderRepository(user.id, db).list().map((provider) => ({
      type: provider.poolType,
      label: provider.name,
      description: provider.description || `${provider.interfaceType === "chat" ? "Chat Completions" : "Responses"} · ${provider.baseUrl}`,
      quotaKinds: provider.balanceConfig ? ["PERMANENT", "FIVE_HOUR", "WEEKLY", "MONTHLY", "CUSTOM_PERIOD"] : [],
      credentialFields: [{ key: "token", label: "API Key", required: true, type: "password" }],
    }))],
    poolPreferences: new RoutingService(user.id, db).getPoolPreferences(),
  })
}
