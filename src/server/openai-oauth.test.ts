import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetOpenAIOAuthSessionsForTests,
  completeOpenAIOAuthSession,
  OPENAI_OAUTH_CLIENT_ID,
  startOpenAIOAuthSession,
} from "./openai-oauth"

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
})
