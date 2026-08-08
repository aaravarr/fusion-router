import { createHash } from "node:crypto"
import { z } from "zod"
import { requireSession } from "../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { fetchKimiModels } from "@/server/kimi-oauth"

export const runtime = "nodejs"

const bodySchema = z.object({
  apiKey: z.string().min(1),
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
  if (!apiKey.startsWith("sk-")) {
    return Response.json(
      { error: { type: "validation_error", message: "Kimi API Key 应以 sk- 开头" } },
      { status: 400 },
    )
  }

  // 先实测验证 key：拉 /models 确认有效，无效直接拒绝。
  let models: string[] = []
  try {
    models = await fetchKimiModels(apiKey)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // 401/403 明确是 key 无效；其余（网络/5xx）按上游故障处理。
    if (/\b(401|403)\b/.test(message) || /invalid|unauthorized|expired/i.test(message)) {
      return Response.json(
        { error: { type: "kimi_apikey_invalid", message: `Kimi API Key 验证失败：${message}` } },
        { status: 401 },
      )
    }
    return Response.json(
      { error: { type: "kimi_apikey_unreachable", message: `Kimi 上游暂时不可达：${message}` } },
      { status: 502 },
    )
  }

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)
  const externalId = createHash("sha256").update(`kimi-code-apikey:${apiKey}`).digest("hex").slice(0, 24)

  const account = accountRepo.createProviderAccount({
    name: "Kimi API Key",
    poolType: "kimi-code",
    email: null,
    externalId,
  })

  // API Key 模式没有 refreshToken / expiresAt，token 直接就是 key，
  // provider.getCredential 对无 refreshToken 的凭据直接返回，不会走 OAuth 刷新。
  const credentialData: Record<string, string> = {
    token: apiKey,
    tokenType: "Bearer",
  }
  credRepo.upsert({ accountId: account.id, poolType: "kimi-code", credentialData })

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
    models,
  })
}
