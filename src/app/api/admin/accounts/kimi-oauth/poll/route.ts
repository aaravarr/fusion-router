import { z } from "zod"
import { requireSession } from "../../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import {
  cancelKimiOAuthSession,
  decodeJwtEmail,
  fetchKimiUserInfo,
  kimiExternalId,
  KIMI_CODE_CLIENT_ID,
  pollKimiOAuthSession,
} from "@/server/kimi-oauth"

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
    const result = await pollKimiOAuthSession(user.id, parsed.data.sessionId)
    if (result.status !== "success") {
      return Response.json(result)
    }

    const db = getDatabase()
    const accountRepo = new AccountRepository(user.id, db)
    const credRepo = new ProviderCredentialRepository(user.id, db)
    // /me 拿到的 user_id/region/domain 比 JWT 解码更权威（官方用 /me 而非
    // 解析 token）；best-effort，失败不阻断建号。实测 /me 可能不含 email，
    // 所以 email 仍以 JWT 解码兜底。
    const userInfo = await fetchKimiUserInfo(result.token.accessToken).catch(() => null)
    const identity = decodeJwtEmail(result.token.accessToken)
    const email = userInfo?.email || identity.email
    const name = userInfo?.nickname || email || "Kimi Code"
    const externalId = kimiExternalId(userInfo?.userId || identity.subject || email, result.token.refreshToken)

    const account = accountRepo.createProviderAccount({
      name,
      poolType: "kimi-code",
      email: email || null,
      externalId,
    })

    const credentialData: Record<string, string> = {
      token: result.token.accessToken,
      refreshToken: result.token.refreshToken,
      expiresAt: String(result.token.expiresAt),
      expiresIn: String(result.token.expiresIn),
      clientId: KIMI_CODE_CLIENT_ID,
      tokenType: result.token.tokenType || "Bearer",
    }
    if (result.token.scope) credentialData.scope = result.token.scope
    if (email) credentialData.email = email
    if (identity.subject) credentialData.subject = identity.subject
    if (userInfo) {
      if (userInfo.userId) credentialData.kimiUserId = userInfo.userId
      if (userInfo.region) credentialData.region = userInfo.region
      if (userInfo.domainName) credentialData.domainName = userInfo.domainName
      if (userInfo.userLevel) credentialData.userLevel = String(userInfo.userLevel)
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
    })
  } catch (cause) {
    return Response.json(
      { error: { type: "kimi_oauth_error", message: cause instanceof Error ? cause.message : "轮询 Kimi OAuth 失败" } },
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
  cancelKimiOAuthSession(user.id, parsed.data.sessionId)
  return Response.json({ ok: true })
}
