import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  startGlmOAuthSession: vi.fn(),
}))

vi.mock("../../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/glm-coding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/glm-coding")>()),
  startGlmOAuthSession: mocks.startGlmOAuthSession,
}))

import { POST } from "./route"

describe("POST /api/admin/accounts/glm-oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "owner" })
  })

  it("默认 cn region 发起会话并返回授权 URL", async () => {
    mocks.startGlmOAuthSession.mockResolvedValue({
      sessionId: "sess-1",
      authorizeUrl: "https://bigmodel.cn/login?appId=zcode&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=abc",
      intervalSec: 2,
      expiresInSeconds: 900,
    })
    const response = await POST(new Request("http://x/api/admin/accounts/glm-oauth/start", { method: "POST" }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { sessionId: string; authorizeUrl: string }
    expect(payload.sessionId).toBe("sess-1")
    expect(payload.authorizeUrl).toContain("bigmodel.cn/login")
    expect(mocks.startGlmOAuthSession).toHaveBeenCalledWith("owner", "cn")
  })

  it("region=global 时透传给会话创建", async () => {
    mocks.startGlmOAuthSession.mockResolvedValue({ sessionId: "sess-2", authorizeUrl: "https://chat.z.ai/api/oauth/authorize?...", intervalSec: 2, expiresInSeconds: 900 })
    const response = await POST(new Request("http://x/api/admin/accounts/glm-oauth/start", {
      method: "POST",
      body: JSON.stringify({ region: "global" }),
    }))
    expect(response.status).toBe(200)
    expect(mocks.startGlmOAuthSession).toHaveBeenCalledWith("owner", "global")
  })

  it("非法 region 返回 400", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/glm-oauth/start", {
      method: "POST",
      body: JSON.stringify({ region: "eu" }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.startGlmOAuthSession).not.toHaveBeenCalled()
  })

  it("上游 init 失败返回 502", async () => {
    mocks.startGlmOAuthSession.mockRejectedValue(new Error("GLM OAuth init 失败（HTTP 503，code=1）: boom"))
    const response = await POST(new Request("http://x/api/admin/accounts/glm-oauth/start", { method: "POST" }))
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("glm_oauth_error")
  })
})
