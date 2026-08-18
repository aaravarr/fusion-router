import { getDatabase } from "@/server/db"
import { AccountRepository } from "@/server/repository"
import { OpenCodeWebError } from "@/server/opencode-web/client"
import { getOpenCodeWebService } from "@/server/opencode-web/service"
import { requireSession } from "../../../../_auth"
import { z } from "zod"

export const runtime = "nodejs"

const applySchema = z.object({
  referralId: z.string().trim().min(1).max(200),
})

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = applySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", message: "referralId 不能为空" } }, { status: 400 })
  const { id } = await context.params
  const existing = new AccountRepository(user.id, getDatabase()).get(id)
  if (!existing) return Response.json({ error: { type: "not_found", message: "账号不存在" } }, { status: 404 })
  if (existing.poolType !== "opencode-go") {
    return Response.json({ error: { type: "validation_error", message: "邀请奖励仅支持 OpenCode Go 账号" } }, { status: 400 })
  }
  const referralId = parsed.data.referralId
  // 业务失败一律不用 401/403，避免前端 sessionFetch 误判会话过期跳登录。
  try {
    const result = await getOpenCodeWebService(user.id).applyReferralReward(id, referralId)
    return Response.json(result)
  } catch (cause) {
    const authenticationFailed = cause instanceof OpenCodeWebError && cause.code === "AUTH"
    return Response.json({
      error: {
        type: authenticationFailed ? "opencode_auth_invalid" : "referral_apply_failed",
        message: cause instanceof Error ? cause.message : "兑换邀请奖励失败",
      },
    }, { status: authenticationFailed ? 422 : 502 })
  }
}
