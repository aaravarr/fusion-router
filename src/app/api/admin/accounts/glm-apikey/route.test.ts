import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  fetchGlmQuota: vi.fn(),
  createProviderAccount: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/glm-coding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/glm-coding")>()),
  fetchGlmQuota: mocks.fetchGlmQuota,
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

import { POST } from "./route"
import { GlmApiKeyInvalidError } from "@/server/glm-coding"

describe("POST /api/admin/accounts/glm-apikey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "owner" })
    mocks.createProviderAccount.mockReturnValue({ id: "acct-1", name: "GLM Coding (CN)", email: null, poolType: "glm-coding" })
  })

  it("拒绝过短的 key", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/glm-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "short" }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.fetchGlmQuota).not.toHaveBeenCalled()
  })

  it("key 无效（上游 401）时返回 400（非 401，避免前端误判未登录跳转）且不建账户", async () => {
    mocks.fetchGlmQuota.mockRejectedValue(new GlmApiKeyInvalidError("GLM 用量接口拒绝访问（HTTP 401）: unauthorized", 401))
    const response = await POST(new Request("http://x/api/admin/accounts/glm-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "invalid-id.invalid-secret" }),
    }))
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("glm_apikey_invalid")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("key 无效（上游 403）时返回 400 且不建账户", async () => {
    mocks.fetchGlmQuota.mockRejectedValue(new GlmApiKeyInvalidError("GLM 用量接口拒绝访问（HTTP 403）: forbidden", 403))
    const response = await POST(new Request("http://x/api/admin/accounts/glm-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "invalid-id.invalid-secret" }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("上游故障（5xx/网络）时返回 502 且不建账户", async () => {
    mocks.fetchGlmQuota.mockRejectedValue(new Error("GLM 用量接口失败（HTTP 503）: upstream down"))
    const response = await POST(new Request("http://x/api/admin/accounts/glm-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "maybe-valid-id.secret" }),
    }))
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("glm_apikey_unreachable")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("验证通过后创建账户、保存长期 key 凭据（authMode apikey + region + deviceMid）", async () => {
    mocks.fetchGlmQuota.mockResolvedValue({ level: "pro", limits: [] })
    const response = await POST(new Request("http://x/api/admin/accounts/glm-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "key-id.secret-value", region: "global" }),
    }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string; account: { id: string }; level: string }
    expect(payload.status).toBe("success")
    expect(payload.account.id).toBe("acct-1")
    expect(payload.level).toBe("pro")
    expect(mocks.fetchGlmQuota).toHaveBeenCalledWith("key-id.secret-value", "global")

    const accountInput = mocks.createProviderAccount.mock.calls[0]?.[0] as { poolType: string; name: string; externalId: string }
    expect(accountInput.poolType).toBe("glm-coding")
    expect(accountInput.name).toContain("Global")
    expect(accountInput.externalId).toMatch(/^[0-9a-f]{24}$/)

    const credentialInput = mocks.upsert.mock.calls[0]?.[0] as { poolType: string; credentialData: Record<string, string> }
    expect(credentialInput.poolType).toBe("glm-coding")
    expect(credentialInput.credentialData.token).toBe("key-id.secret-value")
    expect(credentialInput.credentialData.authMode).toBe("apikey")
    expect(credentialInput.credentialData.region).toBe("global")
    expect(credentialInput.credentialData.deviceMid).toMatch(/^[0-9a-f]{32}$/)
    expect(credentialInput.credentialData.glmLevel).toBe("pro")
    // 长期 key：无 refreshToken / expiresAt。
    expect(credentialInput.credentialData.refreshToken).toBeUndefined()
    expect(credentialInput.credentialData.expiresAt).toBeUndefined()
  })

  it("region 缺省为 cn", async () => {
    mocks.fetchGlmQuota.mockResolvedValue({ level: "", limits: [] })
    const response = await POST(new Request("http://x/api/admin/accounts/glm-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "key-id.secret-value" }),
    }))
    expect(response.status).toBe(200)
    expect(mocks.fetchGlmQuota).toHaveBeenCalledWith("key-id.secret-value", "cn")
  })
})
