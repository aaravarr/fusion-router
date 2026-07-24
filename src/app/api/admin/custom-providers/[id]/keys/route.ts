import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../../../_auth"
import { createCustomProviderKeySchema } from "../../_schema"
import { syncProviderModelsForAccount } from "@/server/provider-models"
import { syncProviderAccount } from "@/server/provider-sync"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const provider = new CustomProviderRepository(user.id, getDatabase()).get(id)
  if (!provider) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  const accounts = new AccountRepository(user.id, getDatabase()).listByPoolType(provider.poolType)
  return Response.json({ keys: accounts.map((account) => ({ ...account, hasApiKey: true })) })
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = createCustomProviderKeySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id } = await context.params
  const db = getDatabase()
  const provider = new CustomProviderRepository(user.id, db).get(id)
  if (!provider) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  const accountRepo = new AccountRepository(user.id, db)
  const account = accountRepo.createProviderAccount({ name: parsed.data.name, poolType: provider.poolType })
  new ProviderCredentialRepository(user.id, db).upsert({
    accountId: account.id, poolType: provider.poolType,
    credentialData: { token: parsed.data.apiKey, ...(parsed.data.extraHeaders ? { extraHeaders: JSON.stringify(parsed.data.extraHeaders) } : {}) },
  })
  if (parsed.data.maxConcurrency) accountRepo.updateState(account.id, { maxConcurrency: parsed.data.maxConcurrency })
  const checks = await Promise.allSettled([
    syncProviderModelsForAccount(user.id, account.id, db),
    ...(provider.balanceConfig ? [syncProviderAccount(user.id, account.id, db)] : []),
  ])
  const warnings = checks.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : "上游探测失败")
  return Response.json({ key: accountRepo.get(account.id), warnings }, { status: 201 })
}
