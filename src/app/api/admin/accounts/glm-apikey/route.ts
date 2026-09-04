import { createHash } from "node:crypto"
import { z } from "zod"
import { requireSession } from "../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { fetchGlmQuota, newGlmDeviceMid, GlmApiKeyInvalidError } from "@/server/glm-coding"

export const runtime = "nodejs"

const bodySchema = z.object({
  apiKey: z.string().min(8, "API Key 过短"),
  region: z.enum(["cn", "global"]).optional(),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  const apiKey = parsed.data.apiKey.trim()
  const region = parsed.data.region ?? "cn"
  // GLM coding-plan key 形态为 `{id}.{secret}`（OAuth 兑换同构），无统一前缀，不做前缀校验。

  // 先实测验证 key：GET quota/limit，200 带 data 即有效（顺手经异步配额同步落
  // quota_windows 与 level）。注意：key 无效必须返回 400 而非 401——前端
  // sessionFetch 会把 401 当会话过期跳转登录页。
  let level = ""
  try {
    const quota = await fetchGlmQuota(apiKey, region)
    level = quota.level
  } catch (cause) {
    if (cause instanceof GlmApiKeyInvalidError) {
      return Response.json(
        { error: { type: "glm_apikey_invalid", message: `GLM API Key 验证失败：${cause.message}` } },
        { status: 400 },
      )
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    return Response.json(
      { error: { type: "glm_apikey_unreachable", message: `GLM 上游暂时不可达：${message}` } },
      { status: 502 },
    )
  }

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)
  const externalId = createHash("sha256").update(`glm-coding-apikey:${apiKey}`).digest("hex").slice(0, 24)

  const account = accountRepo.createProviderAccount({
    name: `GLM Coding (${region === "global" ? "Global" : "CN"})${level ? ` · ${level}` : ""}`,
    poolType: "glm-coding",
    email: null,
    externalId,
  })

  // 长期 API key：无 refreshToken / expiresAt，token 直接就是 key，无 OAuth 刷新。
  const credentialData: Record<string, string> = {
    token: apiKey,
    tokenType: "Bearer",
    authMode: "apikey",
    region,
    deviceMid: newGlmDeviceMid(),
  }
  if (level) credentialData.glmLevel = level
  credRepo.upsert({ accountId: account.id, poolType: "glm-coding", credentialData })

  void import("@/server/provider-models").then(({ syncProviderModelsForAccount }) =>
    syncProviderModelsForAccount(user.id, account.id, db).catch(() => undefined),
  )
  void import("@/server/provider-sync").then(({ syncProviderAccount }) =>
    syncProviderAccount(user.id, account.id, db).catch(() => undefined),
  )

  return Response.json({
    status: "success",
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      poolType: account.poolType,
    },
    level,
  })
}
