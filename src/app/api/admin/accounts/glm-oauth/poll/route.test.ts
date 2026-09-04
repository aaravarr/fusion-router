import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  pollGlmOAuthSession: vi.fn(),
  resolveGlmCodingPlanApiKey: vi.fn(),
  cancelGlmOAuthSession: vi.fn(),
  createProviderAccount: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("../../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/glm-coding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/glm-coding")>()),
  pollGlmOAuthSession: mocks.pollGlmOAuthSession,
  resolveGlmCodingPlanApiKey: mocks.resolveGlmCodingPlanApiKey,
  cancelGlmOAuthSession: mocks.cancelGlmOAuthSession,
}))
vi.mock("@/server/db", () => ({ getDatabase: () => ({}) }))
vi.mock("@/server/repository", () => ({
  AccountRepository: class {
    createProviderAccount(input: unknown) {
      return mocks.createProviderAccount(input)
    }
  },
  ProviderCredentialRepository: class {
    upsert(input: unknown) {
      return mocks.upsert(input)
    }
  },
}))
vi.mock("@/server/provider-models", () => ({ syncProviderModelsForAccount: async () => undefined }))
vi.mock("@/server/provider-sync", () => ({ syncProviderAccount: async () => ({}) }))

import { POST, DELETE } from "./route"

describe("POST /api/admin/accounts/glm-oauth/poll（状态机）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "owner" })
    mocks.createProviderAccount.mockReturnValue({ id: "acct-1", name: "GLM Coding (CN)", email: null, poolType: "glm-coding" })
  })

  it("pending 透传且不建账户", async () => {
    mocks.pollGlmOAuthSession.mockResolvedValue({ status: "pending", intervalSec: 2, authorizeUrl: "https://bigmodel.cn/login?..." })
    const response = await POST(request({ sessionId: "sess-1" }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string }
    expect(payload.status).toBe("pending")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
    expect(mocks.resolveGlmCodingPlanApiKey).not.toHaveBeenCalled()
  })

  it("expired / failed 透传且不建账户", async () => {
    mocks.pollGlmOAuthSession.mockResolvedValue({ status: "expired" })
    const expired = await POST(request({ sessionId: "sess-1" }))
    expect(((await expired.json()) as { status: string }).status).toBe("expired")

    mocks.pollGlmOAuthSession.mockResolvedValue({ status: "failed", description: "授权失败，请重试" })
    const failed = await POST(request({ sessionId: "sess-1" }))
    expect(((await failed.json()) as { status: string; description: string }).description).toContain("授权失败")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("ready：兑换 coding-plan API key → 建号 → 存 oauth 模式凭据", async () => {
    mocks.pollGlmOAuthSession.mockResolvedValue({
      status: "success",
      accessToken: "oauth-access-token",
      zcodeJwt: "zcode.plan.jwt",
      userId: "user-123",
      region: "cn",
    })
    mocks.resolveGlmCodingPlanApiKey.mockResolvedValue({ apiKey: "auto-key-id.auto-secret" })

    const response = await POST(request({ sessionId: "sess-1" }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string; account: { id: string } }
    expect(payload.status).toBe("success")
    expect(payload.account.id).toBe("acct-1")

    // 兑换使用 OAuth token + region。
    expect(mocks.resolveGlmCodingPlanApiKey).toHaveBeenCalledWith("oauth-access-token", "cn")

    const accountInput = mocks.createProviderAccount.mock.calls[0]?.[0] as { poolType: string; externalId: string }
    expect(accountInput.poolType).toBe("glm-coding")
    expect(accountInput.externalId).toMatch(/^[0-9a-f]{24}$/)

    const credentialInput = mocks.upsert.mock.calls[0]?.[0] as { poolType: string; credentialData: Record<string, string> }
    expect(credentialInput.poolType).toBe("glm-coding")
    // 兑换出的长期 key 即转发凭据；无 refreshToken/expiresAt。
    expect(credentialInput.credentialData.token).toBe("auto-key-id.auto-secret")
    expect(credentialDataOf(credentialInput).authMode).toBe("oauth")
    expect(credentialDataOf(credentialInput).region).toBe("cn")
    expect(credentialDataOf(credentialInput).deviceMid).toMatch(/^[0-9a-f]{32}$/)
    expect(credentialDataOf(credentialInput).glmUserId).toBe("user-123")
    expect(credentialDataOf(credentialInput).zcodeJwt).toBe("zcode.plan.jwt")
    expect(credentialDataOf(credentialInput).refreshToken).toBeUndefined()
  })

  it("兑换失败返回 502 且不建账户", async () => {
    mocks.pollGlmOAuthSession.mockResolvedValue({
      status: "success",
      accessToken: "oauth-access-token",
      region: "cn",
    })
    mocks.resolveGlmCodingPlanApiKey.mockRejectedValue(new Error("自动创建 coding-plan API key 失败"))

    const response = await POST(request({ sessionId: "sess-1" }))
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("glm_oauth_error")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("sessionId 缺失返回 400", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/glm-oauth/poll", {
      method: "POST",
      body: JSON.stringify({}),
    }))
    expect(response.status).toBe(400)
  })

  it("DELETE 取消会话", async () => {
    const response = await DELETE(request({ sessionId: "sess-1" }))
    expect(response.status).toBe(200)
    expect(mocks.cancelGlmOAuthSession).toHaveBeenCalledWith("owner", "sess-1")
  })
})

function request(body: unknown): Request {
  return new Request("http://x/api/admin/accounts/glm-oauth/poll", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function credentialDataOf(input: { credentialData: Record<string, string> }): Record<string, string> {
  return input.credentialData
}
