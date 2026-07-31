import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../../_auth"
import { updateCustomProviderSchema } from "../_schema"
import { AccountRepository } from "@/server/repository"
import { syncProviderModelsForAccount } from "@/server/provider-models"
import { syncProviderAccount } from "@/server/provider-sync"
import { createCustomProviderKeys } from "@/server/custom-provider-keys"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const provider = new CustomProviderRepository(user.id, getDatabase()).get(id)
  return provider ? Response.json({ provider }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = updateCustomProviderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id } = await context.params
  try {
    const db = getDatabase()
    const { apiKeys, ...input } = parsed.data
    const provider = new CustomProviderRepository(user.id, db).update(id, input)
    let warnings: string[] = []
    // 配置变更（Key、余额、地址、协议）后，对该 Provider 全部账号重新同步模型与额度。
    if (provider && (apiKeys?.length || input.balanceConfig !== undefined || input.baseUrl !== undefined || input.interfaceType !== undefined)) {
      if (apiKeys?.length) {
        createCustomProviderKeys({ ownerUserId: user.id, poolType: provider.poolType, apiKeys }, db)
      }
      const accountIds = new AccountRepository(user.id, db).listByPoolType(provider.poolType).map((account) => account.id)
      const checks = await Promise.allSettled(accountIds.flatMap((accountId) => [
        syncProviderModelsForAccount(user.id, accountId, db),
        syncProviderAccount(user.id, accountId, db),
      ]))
      warnings = checks.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : "上游探测失败")
    }
    return provider ? Response.json({ provider, warnings }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
  } catch (cause) {
    return Response.json({ error: { type: "custom_provider_update_failed", message: cause instanceof Error ? cause.message : "更新失败" } }, { status: 400 })
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  return new CustomProviderRepository(user.id, getDatabase()).delete(id)
    ? new Response(null, { status: 204 })
    : Response.json({ error: { type: "not_found" } }, { status: 404 })
}
