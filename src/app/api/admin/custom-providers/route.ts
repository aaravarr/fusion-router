import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../_auth"
import { createCustomProviderSchema } from "./_schema"
import { AccountRepository } from "@/server/repository"
import { createCustomProviderKeys } from "@/server/custom-provider-keys"
import { syncProviderModelsForAccount } from "@/server/provider-models"
import { syncProviderAccount } from "@/server/provider-sync"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const allAccounts = accountRepo.list()
  const countByPoolType = new Map<string, number>()
  for (const account of allAccounts) countByPoolType.set(account.poolType, (countByPoolType.get(account.poolType) ?? 0) + 1)
  const providers = new CustomProviderRepository(user.id, db).list().map((provider) => ({ ...provider, keyCount: countByPoolType.get(provider.poolType) ?? 0 }))
  return Response.json({ providers })
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = createCustomProviderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  try {
    const db = getDatabase()
    const { apiKeys, ...input } = parsed.data
    const provider = new CustomProviderRepository(user.id, db).create(input)
    let warnings: string[] = []
    if (apiKeys?.length) {
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
    return Response.json({ provider, keyCount: new AccountRepository(user.id, db).listByPoolType(provider.poolType).length, warnings }, { status: 201 })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "创建 Provider 失败"
    return Response.json({ error: { type: "custom_provider_create_failed", message } }, { status: message.includes("UNIQUE") ? 409 : 400 })
  }
}
