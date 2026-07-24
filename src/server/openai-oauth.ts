import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { apiFetch } from "./api-fetch"
import { decodeJwtClaims, jwtClaimString } from "./xai-sso-device"

export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback"
export const OPENAI_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
export const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"

const OPENAI_OAUTH_SCOPES = "openid profile email offline_access"
const SESSION_TTL_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 30_000

interface OpenAIOAuthSession {
  id: string
  ownerUserId: string
  state: string
  codeVerifier: string
  createdAtMs: number
  expiresAtMs: number
}

export interface OpenAIOAuthToken {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  expiresIn: number
  tokenType: string
  scope: string
  email: string
  subject: string
  chatgptAccountId: string
  chatgptUserId: string
  planType: string
  organizationId: string
}

const sessionGlobal = globalThis as typeof globalThis & { __openAIOAuthSessions?: Map<string, OpenAIOAuthSession> }
const sessions = (sessionGlobal.__openAIOAuthSessions ??= new Map<string, OpenAIOAuthSession>())

function pruneSessions(now = Date.now()): void {
  for (const [id, session] of sessions) if (session.expiresAtMs <= now) sessions.delete(id)
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCallbackUrl(value: string): { code: string; state: string } {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error("回调地址无效，请粘贴浏览器地址栏中的完整 URL")
  }
  if (url.protocol !== "http:" || url.hostname !== "localhost" || url.port !== "1455" || url.pathname !== "/auth/callback") {
    throw new Error("回调地址必须是 http://localhost:1455/auth/callback")
  }
  const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error")
  if (oauthError) throw new Error(`OpenAI OAuth 授权失败：${oauthError}`)
  const code = url.searchParams.get("code")?.trim() || ""
  const state = url.searchParams.get("state")?.trim() || ""
  if (!code || !state) throw new Error("回调地址缺少 code 或 state")
  return { code, state }
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseIdentity(idToken: string, accessToken: string): Omit<OpenAIOAuthToken, "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "expiresIn" | "tokenType" | "scope"> {
  const claims = decodeJwtClaims(idToken) ?? decodeJwtClaims(accessToken) ?? {}
  const auth = nestedRecord(claims["https://api.openai.com/auth"])
  const organizations = Array.isArray(auth.organizations) ? auth.organizations.map(nestedRecord) : []
  const defaultOrganization = organizations.find((organization) => organization.is_default === true) ?? organizations[0]
  return {
    email: jwtClaimString(claims, "email"),
    subject: jwtClaimString(claims, "sub"),
    chatgptAccountId: jwtClaimString(auth, "chatgpt_account_id"),
    chatgptUserId: jwtClaimString(auth, "chatgpt_user_id"),
    planType: jwtClaimString(auth, "chatgpt_plan_type"),
    organizationId: jwtClaimString(defaultOrganization ?? {}, "id") || jwtClaimString(auth, "poid"),
  }
}

export function startOpenAIOAuthSession(ownerUserId: string): { sessionId: string; authorizationUrl: string; expiresIn: number } {
  pruneSessions()
  const state = randomBytes(32).toString("hex")
  const codeVerifier = randomBytes(64).toString("hex")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const now = Date.now()
  const session: OpenAIOAuthSession = {
    id: randomUUID(),
    ownerUserId,
    state,
    codeVerifier,
    createdAtMs: now,
    expiresAtMs: now + SESSION_TTL_MS,
  }
  sessions.set(session.id, session)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  })
  return {
    sessionId: session.id,
    authorizationUrl: `${OPENAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  }
}

export async function completeOpenAIOAuthSession(ownerUserId: string, sessionId: string, callbackUrl: string): Promise<OpenAIOAuthToken> {
  pruneSessions()
  const session = sessions.get(sessionId)
  if (!session || session.ownerUserId !== ownerUserId) throw new Error("OAuth 会话不存在或已过期，请重新开始授权")
  const callback = parseCallbackUrl(callbackUrl)
  if (!constantTimeEqual(callback.state, session.state)) throw new Error("OAuth state 校验失败，请重新开始授权")

  const response = await apiFetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code: callback.code,
      redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
      code_verifier: session.codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const detail = typeof payload?.error_description === "string" ? payload.error_description : typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`
    throw new Error(`OpenAI OAuth token 兑换失败：${detail}`)
  }
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : ""
  const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : ""
  if (!accessToken || !refreshToken) throw new Error("OpenAI OAuth 响应缺少 access_token 或 refresh_token")
  const idToken = typeof payload?.id_token === "string" ? payload.id_token : ""
  const expiresIn = Math.max(1, Number(payload?.expires_in) || 3600)
  sessions.delete(sessionId)
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresIn,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    tokenType: typeof payload?.token_type === "string" ? payload.token_type : "Bearer",
    scope: typeof payload?.scope === "string" ? payload.scope : "",
    ...parseIdentity(idToken, accessToken),
  }
}

export function cancelOpenAIOAuthSession(ownerUserId: string, sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session?.ownerUserId === ownerUserId) sessions.delete(sessionId)
}

export function __resetOpenAIOAuthSessionsForTests(): void {
  sessions.clear()
}
