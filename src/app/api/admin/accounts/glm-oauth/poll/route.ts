import { z } from "zod"
import { requireSession } from "../../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import {
  cancelGlmOAuthSession,
  glmExternalId,
  newGlmDeviceMid,
  pollGlmOAuthSession,
  resolveGlmCodingPlanApiKey,
} from "@/server/glm-coding"

export const runtime = "nodejs"

const bodySchema = z.object({
  sessionId: z.string().min(1),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  try {
    const result = await pollGlmOAuthSession(user.id, parsed.data.sessionId)
    if (result.status !== "success") {
      return Response.json(result)
    }

    // OAuth ready 后按官方客户端/ zcode-api 的做法把 access_token 兑换成长期
    // coding-plan API key（形态与控制台手建 key 同构），凭据按 apikey 语义存
    // （无过期、无刷新）。兑换失败会话已消费（ready 只出现一次），需重新发起。
    const resolved = await resolveGlmCodingPlanApiKey(result.accessToken, result.region)

    const db = getDatabase()
    const accountRepo = new AccountRepository(user.id, db)
    const credRepo = new ProviderCredentialRepository(user.id, db)
    const externalId = glmExternalId(result.userId, resolved.apiKey)

    const account = accountRepo.createProviderAccount({
      name: `GLM Coding (${result.region === "global" ? "Global" : "CN"})`,
      poolType: "glm-coding",
      email: null,
      externalId,
    })

    const credentialData: Record<string, string> = {
      token: resolved.apiKey,
      tokenType: "Bearer",
      authMode: "oauth",
      region: result.region,
      deviceMid: newGlmDeviceMid(),
    }
    if (result.userId) credentialData.glmUserId = result.userId
    if (result.zcodeJwt) credentialData.zcodeJwt = result.zcodeJwt

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
    })
  } catch (cause) {
    return Response.json(
      { error: { type: "glm_oauth_error", message: cause instanceof Error ? cause.message : "轮询 GLM OAuth 失败" } },
      { status: 502 },
    )
  }
}

export async function DELETE(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error" } }, { status: 400 })
  }
  cancelGlmOAuthSession(user.id, parsed.data.sessionId)
  return Response.json({ ok: true })
}
