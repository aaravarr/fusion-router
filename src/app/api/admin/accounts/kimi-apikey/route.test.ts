import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  fetchKimiModels: vi.fn(),
  createProviderAccount: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/kimi-oauth", () => ({ fetchKimiModels: mocks.fetchKimiModels }))
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

describe("POST /api/admin/accounts/kimi-apikey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "owner" })
    mocks.createProviderAccount.mockReturnValue({ id: "acct-1", name: "Kimi API Key", email: null, poolType: "kimi-code" })
  })

  it("拒绝非 sk- 开头的 key", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/kimi-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "not-a-kimi-key" }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.fetchKimiModels).not.toHaveBeenCalled()
  })

  it("key 无效（401）时返回 401 且不建账户", async () => {
    mocks.fetchKimiModels.mockRejectedValue(new Error("Kimi /models failed (HTTP 401): invalid key"))
    const response = await POST(new Request("http://x/api/admin/accounts/kimi-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk-invalid" }),
    }))
    expect(response.status).toBe(401)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("kimi_apikey_invalid")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("上游故障（5xx/网络）时返回 502 且不建账户", async () => {
    mocks.fetchKimiModels.mockRejectedValue(new Error("Kimi /models failed (HTTP 503): upstream down"))
    const response = await POST(new Request("http://x/api/admin/accounts/kimi-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk-maybe-valid" }),
    }))
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("kimi_apikey_unreachable")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("验证通过后创建账户并保存凭据", async () => {
    mocks.fetchKimiModels.mockResolvedValue(["kimi-for-coding", "k3"])
    const response = await POST(new Request("http://x/api/admin/accounts/kimi-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk-valid-key" }),
    }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string; account: { id: string }; models: string[] }
    expect(payload.status).toBe("success")
    expect(payload.account.id).toBe("acct-1")
    expect(payload.models).toEqual(["kimi-for-coding", "k3"])

    const accountInput = mocks.createProviderAccount.mock.calls[0]?.[0] as { poolType: string; name: string; externalId: string }
    expect(accountInput.poolType).toBe("kimi-code")
    expect(accountInput.externalId).toMatch(/^[0-9a-f]{24}$/)

    const credentialInput = mocks.upsert.mock.calls[0]?.[0] as { credentialData: Record<string, string> }
    expect(credentialInput.credentialData.token).toBe("sk-valid-key")
    expect(credentialInput.credentialData.refreshToken).toBeUndefined()
  })
})
