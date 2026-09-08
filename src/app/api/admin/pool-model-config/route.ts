import { z } from "zod"
import { requireSession } from "../_auth"
import { getDatabase } from "@/server/db"
import { invalidatePoolModelConfigCache, PoolModelConfigRepository } from "@/server/pool-model-config"

export const runtime = "nodejs"

// 号池模型级配置。当前仅接入 openai 池（fast = service_tier:"priority" 预埋）；
// 结构按 pool_type 通用，后续其他池接入时放开白名单即可。

// 业务校验失败回 400/422（禁 401：前端 sessionFetch 见 401 会跳登录页）。
const SUPPORTED_POOL_TYPES = new Set(["openai"])

const getSchema = z.object({
  poolType: z.string().trim().min(1).max(50).optional(),
})

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const url = new URL(request.url)
  const parsed = getSchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }
  if (parsed.data.poolType && !SUPPORTED_POOL_TYPES.has(parsed.data.poolType)) {
    return Response.json({ error: { type: "validation_error", message: `号池类型 ${parsed.data.poolType} 暂不支持模型级配置` } }, { status: 422 })
  }
  const configs = new PoolModelConfigRepository(user.id, getDatabase()).list(parsed.data.poolType)
  return Response.json({ configs })
}

const putSchema = z.object({
  poolType: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(200),
  fastEnabled: z.boolean(),
})

export async function PUT(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = putSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }
  const { poolType, model, fastEnabled } = parsed.data
  if (!SUPPORTED_POOL_TYPES.has(poolType)) {
    return Response.json({ error: { type: "validation_error", message: `号池类型 ${poolType} 暂不支持模型级配置` } }, { status: 422 })
  }
  const config = new PoolModelConfigRepository(user.id, getDatabase()).set(poolType, model, fastEnabled)
  // 写后失效 TTL 缓存，注入查询即时生效。
  invalidatePoolModelConfigCache(user.id)
  return Response.json({ config })
}
