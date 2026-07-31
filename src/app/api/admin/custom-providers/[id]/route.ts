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
    if (provider && !provider.models?.length && (parsed.data.models !== undefined || parsed.data.baseUrl !== undefined)) {
      const account = new AccountRepository(user.id, db).listByPoolType(provider.poolType)[0]
      if (account) await syncProviderModelsForAccount(user.id, account.id, db).catch(() => null)
    }
    let warnings: string[] = []
    if (provider && apiKeys?.length) {
      const accounts = createCustomProviderKeys({ ownerUserId: user.id, poolType: provider.poolType, apiKeys }, db)
      const firstAccount = accounts[0]
      if (firstAccount) {
        const checks = await Promise.allSettled([
          syncProviderModelsForAccount(user.id, firstAccount.id, db),
          ...(provider.balanceConfig ? [syncProviderAccount(user.id, firstAccount.id, db)] : []),
        ])
        warnings = checks.filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason instanceof Error ? result.reason.message : "上游探测失败")
      }
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
