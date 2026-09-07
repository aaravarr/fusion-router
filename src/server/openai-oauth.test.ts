import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetOpenAIOAuthSessionsForTests,
  completeOpenAIOAuthSession,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_TOKEN_URL,
  startOpenAIOAuthSession,
} from "./openai-oauth"
import { getProxyDispatcher, invalidateMirrorCacheForOwner } from "./api-fetch"
import { createDatabase, type AppDatabase } from "./db"

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

describe("OpenAI OAuth PKCE flow", () => {
  afterEach(() => {
    __resetOpenAIOAuthSessionsForTests()
    vi.unstubAllGlobals()
  })

  it("builds the Codex authorization URL and exchanges a verified callback", async () => {
    const started = startOpenAIOAuthSession("user-1")
    const authorizationUrl = new URL(started.authorizationUrl)
    expect(authorizationUrl.searchParams.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID)
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizationUrl.searchParams.get("scope")).toContain("offline_access")
    const state = authorizationUrl.searchParams.get("state")!
    const idToken = jwt({
      sub: "openai-user-1",
      email: "oauth@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_user_id: "chatgpt-user-1",
        chatgpt_plan_type: "plus",
        organizations: [{ id: "org-1", is_default: true }],
      },
    })
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body))
      expect(params.get("code")).toBe("auth-code")
      expect(params.get("code_verifier")?.length).toBe(128)
      return Response.json({
        access_token: jwt({ sub: "openai-user-1" }),
        refresh_token: "refresh-1",
        id_token: idToken,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid profile email",
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const token = await completeOpenAIOAuthSession(
      "user-1",
      started.sessionId,
      `http://localhost:1455/auth/callback?code=auth-code&state=${state}`,
    )
    expect(token).toMatchObject({
      refreshToken: "refresh-1",
      email: "oauth@example.com",
      subject: "openai-user-1",
      chatgptAccountId: "account-1",
      planType: "plus",
      organizationId: "org-1",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("rejects another user and a mismatched state before token exchange", async () => {
    const started = startOpenAIOAuthSession("user-1")
    await expect(completeOpenAIOAuthSession("user-2", started.sessionId, "http://localhost:1455/auth/callback?code=x&state=y"))
      .rejects.toThrow("不存在或已过期")
    await expect(completeOpenAIOAuthSession("user-1", started.sessionId, "http://localhost:1455/auth/callback?code=x&state=wrong"))
      .rejects.toThrow("state 校验失败")
  })

  it("code 兑换走归属用户镜像上下文：代理节点注入共享 dispatcher（地域封锁下直连 403）", async () => {
    const ownerUserId = "user-proxy"
    const db: AppDatabase = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(ownerUserId, ownerUserId, ownerUserId, "Proxy", "USER", "hash", timestamp, timestamp)
    db.prepare("INSERT INTO user_mirror_groups(id,owner_user_id,name,enabled,domains_json,account_ids_json,mirrors_json,rules_json,request_rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("g-oai", ownerUserId, "g-oai", 1, JSON.stringify(["auth.openai.com"]), JSON.stringify([]),
        JSON.stringify([{ id: "m", name: "M", url: "", proxyUrl: "http://127.0.0.1:7890", enabled: true }]),
        JSON.stringify([]), null, timestamp, timestamp)
    ;(globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = db
    invalidateMirrorCacheForOwner(ownerUserId)
    try {
      const started = startOpenAIOAuthSession(ownerUserId)
      const state = new URL(started.authorizationUrl).searchParams.get("state")!
      const fetchMock = vi.fn(async () => Response.json({
        access_token: jwt({ sub: "openai-user-1" }),
        refresh_token: "refresh-1",
        id_token: jwt({ sub: "openai-user-1" }),
        expires_in: 3600,
      }))
      vi.stubGlobal("fetch", fetchMock)
      await completeOpenAIOAuthSession(
        ownerUserId,
        started.sessionId,
        `http://localhost:1455/auth/callback?code=auth-code&state=${state}`,
      )
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }]
      // 只配代理的节点：URL 保持原始上游，请求经代理发出
      expect(url).toBe(OPENAI_OAUTH_TOKEN_URL)
      expect(init.dispatcher).toBe(getProxyDispatcher("http://127.0.0.1:7890"))
    } finally {
      invalidateMirrorCacheForOwner(ownerUserId)
      ;(globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = undefined
      db.close()
    }
  })
})
