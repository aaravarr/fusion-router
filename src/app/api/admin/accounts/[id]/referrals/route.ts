import { getDatabase } from "@/server/db"
import { AccountRepository } from "@/server/repository"
import { OpenCodeWebError } from "@/server/opencode-web/client"
import { getOpenCodeWebService } from "@/server/opencode-web/service"
import { requireSession } from "../../../_auth"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const existing = new AccountRepository(user.id, getDatabase()).get(id)
  if (!existing) return Response.json({ error: { type: "not_found", message: "账号不存在" } }, { status: 404 })
  if (existing.poolType !== "opencode-go") {
    return Response.json({ error: { type: "validation_error", message: "邀请奖励仅支持 OpenCode Go 账号" } }, { status: 400 })
  }
  try {
    const summary = await getOpenCodeWebService(user.id).listReferralRewards(id)
    return Response.json(summary)
  } catch (cause) {
    const authenticationFailed = cause instanceof OpenCodeWebError && cause.code === "AUTH"
    return Response.json({
      error: {
        type: authenticationFailed ? "opencode_auth_invalid" : "referral_fetch_failed",
        message: cause instanceof Error ? cause.message : "获取邀请奖励失败",
      },
    }, { status: authenticationFailed ? 422 : 502 })
  }
}
