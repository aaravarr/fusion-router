import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../../_auth"
import type { PoolType } from "@/server/types"
import { apiFetch } from "@/server/api-fetch"

export const runtime = "nodejs"

// xAI OAuth constants (mirrors internal/pkg/xai from Wei-Shaw/sub2api).
const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token"
const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const REQUEST_TIMEOUT_MS = 30000

// Sub2API JSON account shape — only the fields we care about for import.
const sub2ApiAccountSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.string(),
  type: z.string(),
  credentials: z.record(z.string(), z.unknown()),
  extra: z.record(z.string(), z.unknown()).optional().default({}),
  concurrency: z.number().optional().default(3),
  priority: z.number().optional().default(50),
})

const sub2ApiPayloadSchema = z.object({
  type: z.string().optional(),
  version: z.number().optional(),
  exported_at: z.string().optional(),
  proxies: z.array(z.unknown()).optional().default([]),
  accounts: z.array(sub2ApiAccountSchema),
})

// Determine pool type from Sub2API account fields.
// platform=openai (any auth mode / token shape) → "openai"
// platform=grok  + type=oauth (refresh_token or access_token) → "xai-grok"
// Everything else → skipped
function resolvePoolType(platform: string, type: string, credentials: Record<string, unknown>): PoolType | null {
  const platformLower = platform.toLowerCase()
  if (platformLower === "grok" || platformLower === "xai") {
    // Grok accounts are OAuth-only; accept either refresh_token or access_token.
    const hasToken = Boolean(credentials.refresh_token || credentials.access_token)
    if (hasToken && (type === "oauth" || type === "apikey" || !type)) return "xai-grok"
    return null
  }
  if (platformLower !== "openai") return null
  const hasToken = Boolean(credentials.access_token || credentials.api_key || credentials.refresh_token)
  return hasToken ? "openai" : null
}

// Refresh an xAI OAuth refresh_token to obtain a fresh access_token + rotated
// refresh_token. If the refresh fails we fall back to the provided
// access_token (if any) so callers can still import.
async function refreshXaiToken(
  refreshToken: string,
  clientId: string,
): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: string
} | null> {
  try {
    const resp = await apiFetch(XAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId || XAI_DEFAULT_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    const tokenResp = (await resp.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!tokenResp.access_token) return null
    return {
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token || refreshToken,
      expiresAt: String(Math.floor(Date.now() / 1000) + (tokenResp.expires_in ?? 21600)),
    }
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  const parsed = sub2ApiPayloadSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)

  let imported = 0
  let skipped = 0
  const errors: { name: string; message: string }[] = []
  const importedAccounts: { id: string; name: string; poolType: string }[] = []

  for (const acct of parsed.data.accounts) {
    const poolType = resolvePoolType(acct.platform, acct.type, acct.credentials)
    if (!poolType) {
      skipped++
      continue
    }

    try {
      const credentials = acct.credentials

      if (poolType === "xai-grok") {
        const refreshToken = String(credentials.refresh_token ?? "").trim()
        const clientId = String(credentials.client_id ?? "").trim()
        let accessToken = String(credentials.access_token ?? "").trim()
        let storedRefreshToken = refreshToken
        let expiresAt = String(credentials.expires_at ?? "").trim()
        const email = String(credentials.email ?? "").trim()

        // Efficient ingestion: when only a refresh_token is provided, refresh
        // it now to mint an access_token + rotated refresh_token so the
        // account is immediately usable without a second round-trip.
        if (!accessToken && refreshToken) {
          const refreshed = await refreshXaiToken(refreshToken, clientId)
          if (!refreshed) {
            errors.push({ name: acct.name, message: "xAI refresh_token is invalid or could not be refreshed, and no access_token was provided" })
            continue
          }
          accessToken = refreshed.accessToken
          storedRefreshToken = refreshed.refreshToken
          expiresAt = refreshed.expiresAt
        }

        if (!accessToken) {
          errors.push({ name: acct.name, message: "No access_token or refresh_token in credentials" })
          continue
        }

        const subscriptionTier = String(credentials.subscription_tier ?? "").trim()
        const entitlementStatus = String(credentials.entitlement_status ?? "").trim()

        const account = accountRepo.createProviderAccount({
          name: acct.name,
          poolType: "xai-grok",
          email: email || null,
        })

        const credData: Record<string, string> = { token: accessToken }
        if (storedRefreshToken) credData.refreshToken = storedRefreshToken
        if (expiresAt) credData.expiresAt = expiresAt
        credData.clientId = clientId || XAI_DEFAULT_CLIENT_ID
        if (subscriptionTier) credData.subscriptionTier = subscriptionTier
        if (entitlementStatus) credData.entitlementStatus = entitlementStatus
        credRepo.upsert({ accountId: account.id, poolType, credentialData: credData })

        if (acct.concurrency && acct.concurrency !== 3) {
          accountRepo.updateState(account.id, { maxConcurrency: acct.concurrency })
        }

        imported++
        importedAccounts.push({ id: account.id, name: acct.name, poolType })
        continue
      }

      // OpenAI CPA / OAuth import path (existing behavior).
      const token = String(credentials.access_token ?? credentials.api_key ?? "")
      if (!token) {
        errors.push({ name: acct.name, message: "No access_token or api_key in credentials" })
        continue
      }
      const chatgptAccountId = String(credentials.chatgpt_account_id ?? "")
      const email = String(credentials.email ?? "")
      const planType = String(credentials.plan_type ?? "")

      const account = accountRepo.createProviderAccount({ name: acct.name, poolType, email: email || null })

      const credData: Record<string, string> = { token }
      if (chatgptAccountId) credData.chatgptAccountId = chatgptAccountId
      if (planType) credData.planType = planType
      // Store refresh_token, expires_at, client_id for OAuth accounts that can refresh
      const refreshToken = String(credentials.refresh_token ?? "")
      if (refreshToken) {
        credData.refreshToken = refreshToken
        const expiresAt = String(credentials.expires_at ?? "")
        if (expiresAt) credData.expiresAt = expiresAt
        const clientId = String(credentials.client_id ?? "")
        if (clientId) credData.clientId = clientId
      }
      credRepo.upsert({ accountId: account.id, poolType, credentialData: credData })

      // Update concurrency if specified
      if (acct.concurrency && acct.concurrency !== 3) {
        accountRepo.updateState(account.id, { maxConcurrency: acct.concurrency })
      }

      imported++
      importedAccounts.push({ id: account.id, name: account.name, poolType })
    } catch (cause) {
      errors.push({ name: acct.name, message: cause instanceof Error ? cause.message : "Unknown error" })
    }
  }

  // Best-effort model catalog refresh for each newly imported pool type.
  const poolTypes = [...new Set(importedAccounts.map((item) => item.poolType))]
  if (poolTypes.length) {
    void import("@/server/provider-models").then(async ({ syncProviderModels }) => {
      for (const poolType of poolTypes) {
        const accountId = importedAccounts.find((item) => item.poolType === poolType)?.id
        await syncProviderModels({ poolType: poolType as PoolType, ownerUserId: user.id, accountId, db }).catch(() => undefined)
      }
    })
  }

  return Response.json({ imported, skipped, errors, accounts: importedAccounts }, { status: 201 })
}
