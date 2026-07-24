import { z } from "zod"
import { requireSession } from "../../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import {
  cancelKimiOAuthSession,
  decodeJwtEmail,
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
    const identity = decodeJwtEmail(result.token.accessToken)
    const email = identity.email
    const name = email || "Kimi Code"
    const externalId = kimiExternalId(identity.subject || email, result.token.refreshToken)

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
      clientId: KIMI_CODE_CLIENT_ID,
      tokenType: result.token.tokenType || "Bearer",
    }
    if (result.token.scope) credentialData.scope = result.token.scope
    if (email) credentialData.email = email
    if (identity.subject) credentialData.subject = identity.subject

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
