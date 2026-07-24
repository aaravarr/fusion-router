import { createHash } from "node:crypto"
import { z } from "zod"
import { requireSession } from "../../../_auth"
import { getDatabase } from "@/server/db"
import { completeOpenAIOAuthSession, OPENAI_OAUTH_CLIENT_ID } from "@/server/openai-oauth"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"

export const runtime = "nodejs"

const bodySchema = z.object({
  sessionId: z.string().min(1),
  callbackUrl: z.string().min(1),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })

  try {
    const token = await completeOpenAIOAuthSession(user.id, parsed.data.sessionId, parsed.data.callbackUrl)
    const db = getDatabase()
    const accountRepo = new AccountRepository(user.id, db)
    const credentialRepo = new ProviderCredentialRepository(user.id, db)
    const identity = token.subject || token.email.toLowerCase() || token.chatgptAccountId || token.refreshToken
    const externalId = createHash("sha256").update(`openai:${identity}`).digest("hex").slice(0, 24)
    const account = accountRepo.createProviderAccount({
      name: token.email || "OpenAI OAuth",
      poolType: "openai",
      email: token.email || null,
      externalId,
    })
    const credentialData: Record<string, string> = {
      token: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: String(token.expiresAt),
      clientId: OPENAI_OAUTH_CLIENT_ID,
      tokenType: token.tokenType,
    }
    if (token.idToken) credentialData.idToken = token.idToken
    if (token.scope) credentialData.scope = token.scope
    if (token.email) credentialData.email = token.email
    if (token.subject) credentialData.subject = token.subject
    if (token.chatgptAccountId) credentialData.chatgptAccountId = token.chatgptAccountId
    if (token.chatgptUserId) credentialData.chatgptUserId = token.chatgptUserId
    if (token.planType) credentialData.planType = token.planType
    if (token.organizationId) credentialData.organizationId = token.organizationId
    credentialRepo.upsert({ accountId: account.id, poolType: "openai", credentialData })

    void import("@/server/provider-models").then(({ syncProviderModelsForAccount }) =>
      syncProviderModelsForAccount(user.id, account.id, db).catch(() => undefined),
    )
    void import("@/server/provider-sync").then(({ syncProviderAccount }) =>
      syncProviderAccount(user.id, account.id, db).catch(() => undefined),
    )

    return Response.json({ account: { id: account.id, name: account.name, email: account.email, poolType: account.poolType } }, { status: 201 })
  } catch (cause) {
    return Response.json(
      { error: { type: "openai_oauth_error", message: cause instanceof Error ? cause.message : "OpenAI OAuth 登录失败" } },
      { status: 502 },
    )
  }
}
