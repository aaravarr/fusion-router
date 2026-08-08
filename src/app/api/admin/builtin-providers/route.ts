import { z } from "zod"
import { requireSession } from "../_auth"
import { getDatabase, type AppDatabase } from "@/server/db"
import { AccountRepository } from "@/server/repository"
import { POOL_TYPES, POOL_TYPE_METADATA, tryGetProvider } from "@/server/providers"
import type { BuiltinPoolType } from "@/server/providers/types"
import { getBuiltinProviderStates, setBuiltinProviderEnabled } from "@/server/builtin-provider-state"

export const runtime = "nodejs"

interface BuiltinProviderPayload {
  poolType: BuiltinPoolType
  label: string
  description: string
  quotaKinds: string[]
  accountCount: number
  readyAccountCount: number
  enabled: boolean
  updatedAt: string | null
}

function listBuiltinProviders(ownerUserId: string, db: AppDatabase): BuiltinProviderPayload[] {
  const states = getBuiltinProviderStates(db)
  const accounts = new AccountRepository(ownerUserId, db).list()
  return POOL_TYPES.map((poolType) => {
    const meta = POOL_TYPE_METADATA[poolType]
    const provider = tryGetProvider(poolType)
    const poolAccounts = accounts.filter((account) => account.poolType === poolType)
    return {
      poolType,
      label: meta?.label ?? poolType,
      description: meta?.description ?? "",
      quotaKinds: meta ? [...meta.quotaKinds] : [],
      accountCount: poolAccounts.length,
      readyAccountCount: provider ? poolAccounts.filter((account) => provider.isAccountReady(account)).length : 0,
      enabled: states[poolType]?.enabled !== false,
      updatedAt: states[poolType]?.updatedAt ?? null,
    }
  })
}

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const db = getDatabase()
  return Response.json({ providers: listBuiltinProviders(user.id, db) })
}

const patchSchema = z.object({
  poolType: z.enum(POOL_TYPES),
  enabled: z.boolean(),
})

export async function PATCH(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = patchSchema.safeParse(body)
  // 业务校验失败必须返回 400，不能用 401——前端 sessionFetch 会把任何 401
  // 当作会话过期跳转登录页（见 AGENTS.md 既有教训）。
  if (!parsed.success) {
    return Response.json(
      { error: { type: "validation_error", message: "poolType 必须是内置 Provider 之一，enabled 必须是 boolean", details: parsed.error.flatten() } },
      { status: 400 },
    )
  }

  const db = getDatabase()
  setBuiltinProviderEnabled(parsed.data.poolType, parsed.data.enabled, db)
  const provider = listBuiltinProviders(user.id, db).find((item) => item.poolType === parsed.data.poolType)
  return Response.json({ provider })
}
