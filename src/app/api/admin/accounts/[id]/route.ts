import { AccountRepository } from "@/server/repository"
import { z } from "zod"
import { requireSession } from "../../_auth"
import { getOpenCodeWebService } from "@/server/opencode-web/service"

export const runtime = "nodejs"

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  adminState: z.enum(["ENABLED", "DISABLED"]).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(200).optional(),
  confirmSpendingBlocked: z.boolean().optional(),
  chinaProviders: z.boolean().optional(),
})

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id } = await context.params
  const value = parsed.data
  const repository = new AccountRepository(user.id)
  const existing = repository.get(id)
  if (!existing) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  if (value.adminState === "ENABLED" && existing.disabledReason === "XAI_ACCOUNT_BANNED") {
    return Response.json({ error: { type: "account_banned", message: "该账号已被 xAI 上游封禁，不能重新启用" } }, { status: 409 })
  }
  if (value.adminState === "ENABLED" && (existing.disabledReason === "CREDENTIAL_INVALID" || existing.authState !== "VALID")) {
    return Response.json({ error: { type: "reauthentication_required", message: "凭据已失效，请重新认证后再启用" } }, { status: 409 })
  }
  if (value.adminState === "ENABLED" && existing.disabledReason === "SPENDING_BLOCKED" && !value.confirmSpendingBlocked) {
    return Response.json({ error: { type: "explicit_confirmation_required", message: "消费受限账号需要明确确认后才能重新启用" } }, { status: 409 })
  }
  if (value.adminState) {
    repository.bulkSetAdminState([id], value.adminState, {
      reason: value.reason,
      confirmSpendingBlocked: value.confirmSpendingBlocked,
    })
  }
  if (value.chinaProviders !== undefined) {
    if (existing.poolType !== "opencode-go") {
      return Response.json({ error: { type: "validation_error", message: "该开关仅支持 OpenCode Go 账号" } }, { status: 400 })
    }
    try {
      await getOpenCodeWebService(user.id).setChinaProviders(id, value.chinaProviders)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "更新 OpenCode 提供商路由失败"
      return Response.json({ error: { type: "opencode_action_failed", message } }, { status: cause instanceof Error && cause.message.includes("auth") ? 401 : 502 })
    }
  }
  const account = repository.updateState(id, { name: value.name, maxConcurrency: value.maxConcurrency }) ?? repository.get(id)
  if (!account) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  return Response.json({ account })
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  return new AccountRepository(user.id).delete(id) ? new Response(null, { status: 204 }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}
