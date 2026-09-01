import { getDatabase } from "@/server/db"
import { OpenCodeWebError } from "@/server/opencode-web/client"
import { getOpenCodeWebService } from "@/server/opencode-web/service"
import { AccountRepository } from "@/server/repository"
import { syncProviderAccount } from "@/server/provider-sync"
import { XAIAccountBannedError } from "@/server/providers/xai-grok"
import { requireSession } from "../../../_auth"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const db = getDatabase()
  const existing = new AccountRepository(user.id, db).get(id)
  if (!existing) {
    return Response.json({ error: { type: "not_found", message: "账号不存在" } }, { status: 404 })
  }

  try {
    if (existing.poolType !== "opencode-go") {
      return Response.json(await syncProviderAccount(user.id, id, db))
    }
    // 管理台手动刷新：透传操作者浏览器的真实 UA 给 opencode.ai 控制面（后台定时刷新不传，走默认 UA）。
    const account = await getOpenCodeWebService(user.id).refreshUsage(id, { userAgent: request.headers.get("user-agent") ?? undefined })
    const quotaWindows = db.prepare(`SELECT kind,usage_percent,reset_at,source,last_observed_at
      FROM quota_windows WHERE owner_user_id=? AND account_id=? ORDER BY last_observed_at DESC`)
      .all(user.id, id) as Record<string, unknown>[]
    return Response.json({
      account: account ? {
        ...account,
        quotaWindows: quotaWindows.map((window) => ({
          kind: window.kind,
          usagePercent: window.usage_percent,
          resetAt: window.reset_at,
          source: window.source,
          lastObservedAt: window.last_observed_at,
        })),
      } : null,
    })
  } catch (cause) {
    if (cause instanceof XAIAccountBannedError) {
      return Response.json({ error: { type: "account_banned", message: cause.message } }, { status: 422 })
    }
    const authenticationFailed = cause instanceof OpenCodeWebError && cause.code === "AUTH"
    return Response.json({
      error: {
        type: authenticationFailed ? "opencode_auth_invalid" : "account_sync_failed",
        message: cause instanceof Error ? cause.message : "账号同步失败",
      },
    }, { status: authenticationFailed ? 422 : 502 })
  }
}
