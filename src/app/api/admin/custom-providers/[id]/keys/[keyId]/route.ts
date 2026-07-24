import { AccountRepository } from "@/server/repository"
import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../../../../_auth"
import { z } from "zod"

export const runtime = "nodejs"
const patchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional(), maxConcurrency: z.number().int().min(1).max(64).optional() })

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
  const account = repo.updateState(keyId, { name: parsed.data.name, adminState: parsed.data.enabled === undefined ? undefined : parsed.data.enabled ? "ENABLED" : "DISABLED", maxConcurrency: parsed.data.maxConcurrency })
  return Response.json({ key: account })
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
