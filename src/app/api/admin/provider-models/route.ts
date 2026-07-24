import { z } from "zod"
import { requireSession } from "../_auth"
import { getDatabase } from "@/server/db"
import { listProviderModelCatalogs, syncAllProviderModels, syncProviderModels } from "@/server/provider-models"
import { POOL_TYPES } from "@/server/providers"
import { customProviderId, CustomProviderRepository } from "@/server/custom-providers"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ catalogs: listProviderModelCatalogs(getDatabase(), user.id) })
}

const refreshSchema = z.object({
  poolType: z.string().trim().min(1).optional(),
  accountId: z.string().min(1).optional(),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = refreshSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  const db = getDatabase()
  if (parsed.data.poolType) {
    const customId = customProviderId(parsed.data.poolType)
    if (customId && !new CustomProviderRepository(user.id, db).get(customId)) {
      return Response.json({ error: { type: "not_found", message: "自定义 Provider 不存在" } }, { status: 404 })
    }
    if (!customId && !POOL_TYPES.includes(parsed.data.poolType as (typeof POOL_TYPES)[number])) {
      return Response.json({ error: { type: "validation_error", message: "未知 Provider 类型" } }, { status: 400 })
    }
    const catalog = await syncProviderModels({
      poolType: parsed.data.poolType as import("@/server/types").PoolType,
      ownerUserId: user.id,
      accountId: parsed.data.accountId ?? null,
      db,
    })
    return Response.json({ catalog, catalogs: listProviderModelCatalogs(db, user.id) })
  }

  const catalogs = await syncAllProviderModels({ ownerUserId: user.id, db })
  return Response.json({ catalogs })
}
