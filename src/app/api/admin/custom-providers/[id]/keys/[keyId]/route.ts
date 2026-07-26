import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../../../../_auth"
import { z } from "zod"
import { syncProviderAccount } from "@/server/provider-sync"
import { syncProviderModelsForAccount } from "@/server/provider-models"

export const runtime = "nodejs"
const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional(), maxConcurrency: z.number().int().positive().max(1_000_000).nullable().optional(),
  apiKey: z.string().trim().min(1).max(20_000).optional(), extraHeaders: z.record(z.string(), z.string()).optional(),
})

export async function PATCH(request: Request, context: { params: Promise<{ id: string; keyId: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id, keyId } = await context.params
  const db = getDatabase()
  const provider = new CustomProviderRepository(user.id, db).get(id)
  const repo = new AccountRepository(user.id, db)
  const existing = repo.get(keyId)
  if (!provider || !existing || existing.poolType !== provider.poolType) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  if (parsed.data.apiKey || parsed.data.extraHeaders) {
    const credentials = new ProviderCredentialRepository(user.id, db)
    const current = credentials.get(keyId) ?? {}
    credentials.upsert({ accountId: keyId, poolType: provider.poolType, credentialData: {
      ...current,
      ...(parsed.data.apiKey ? { token: parsed.data.apiKey } : {}),
      ...(parsed.data.extraHeaders ? { extraHeaders: JSON.stringify(parsed.data.extraHeaders) } : {}),
    } })
    repo.updateState(keyId, { authState: "VALID", lastError: null })
  }
  const account = repo.updateState(keyId, { name: parsed.data.name, adminState: parsed.data.enabled === undefined ? undefined : parsed.data.enabled ? "ENABLED" : "DISABLED", maxConcurrency: parsed.data.maxConcurrency === null ? 0 : parsed.data.maxConcurrency })
  const warnings: string[] = []
  if (parsed.data.apiKey) {
    const checks = await Promise.allSettled([syncProviderModelsForAccount(user.id, keyId, db), ...(provider.balanceConfig ? [syncProviderAccount(user.id, keyId, db)] : [])])
    for (const result of checks) if (result.status === "rejected") warnings.push(result.reason instanceof Error ? result.reason.message : "上游探测失败")
  }
  return Response.json({ key: repo.get(keyId) ?? account, warnings })
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string; keyId: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id, keyId } = await context.params
  const db = getDatabase()
  const provider = new CustomProviderRepository(user.id, db).get(id)
  const repo = new AccountRepository(user.id, db)
  const existing = repo.get(keyId)
  if (!provider || !existing || existing.poolType !== provider.poolType) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  repo.delete(keyId)
  return new Response(null, { status: 204 })
}
