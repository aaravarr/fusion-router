import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  verifyCommandCodeApiKey: vi.fn(),
  createProviderAccount: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/command-code", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/command-code")>()),
  verifyCommandCodeApiKey: mocks.verifyCommandCodeApiKey,
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
import { CommandCodeApiKeyInvalidError, CommandCodeProbeUnavailableError } from "@/server/command-code"

const VALID_KEY = "user_abcdef1234567890"

describe("POST /api/admin/accounts/command-code-apikey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "owner" })
    mocks.createProviderAccount.mockReturnValue({ id: "acct-1", name: "Command Code (GOAT)", email: null, poolType: "command-code" })
  })

  it("拒绝过短的 key", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "short" }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.verifyCommandCodeApiKey).not.toHaveBeenCalled()
  })

  it("key 无效（上游 401）时返回 400（非 401，避免前端误判未登录跳转）且不建账户", async () => {
    mocks.verifyCommandCodeApiKey.mockRejectedValue(
      new CommandCodeApiKeyInvalidError('Command Code API Key 验证失败（HTTP 401）: {"success":false,"error":{"code":"UNAUTHORIZED","status":401}}', 401),
    )
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: VALID_KEY }),
    }))
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("command_code_apikey_invalid")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("key 无效（上游 403）时返回 400 且不建账户", async () => {
    mocks.verifyCommandCodeApiKey.mockRejectedValue(new CommandCodeApiKeyInvalidError("HTTP 403", 403))
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: VALID_KEY }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("上游故障（5xx/网络）时返回 502 且不建账户", async () => {
    mocks.verifyCommandCodeApiKey.mockRejectedValue(new CommandCodeProbeUnavailableError("HTTP 503: upstream down", "UNREACHABLE"))
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: VALID_KEY }),
    }))
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("command_code_apikey_unreachable")
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("/alpha 未开放（404）时宽容降级：格式合法照常建号并标注 verified=false", async () => {
    mocks.verifyCommandCodeApiKey.mockRejectedValue(new CommandCodeProbeUnavailableError("404 not found", "NOT_FOUND"))
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: VALID_KEY }),
    }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string; verified: boolean }
    expect(payload.status).toBe("success")
    expect(payload.verified).toBe(false)
    const credentialInput = mocks.upsert.mock.calls[0]?.[0] as { credentialData: Record<string, string> }
    expect(credentialInput.credentialData.commandCodeVerified).toBe("false")
    expect(credentialInput.credentialData.token).toBe(VALID_KEY)
  })

  it("/alpha 未开放（404）但 key 形态非法时仍回 400", async () => {
    mocks.verifyCommandCodeApiKey.mockRejectedValue(new CommandCodeProbeUnavailableError("404 not found", "NOT_FOUND"))
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: "bad key with spaces" }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.createProviderAccount).not.toHaveBeenCalled()
  })

  it("验证通过后创建账户、保存长期 key 凭据（authMode apikey，无 refreshToken/expiresAt）", async () => {
    mocks.verifyCommandCodeApiKey.mockResolvedValue({ userId: "u_123", plan: "goat", email: "a@b.c" })
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: VALID_KEY }),
    }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string; account: { id: string }; plan: string; verified: boolean }
    expect(payload.status).toBe("success")
    expect(payload.account.id).toBe("acct-1")
    expect(payload.plan).toBe("goat")
    expect(payload.verified).toBe(true)
    expect(mocks.verifyCommandCodeApiKey).toHaveBeenCalledWith(VALID_KEY)

    const accountInput = mocks.createProviderAccount.mock.calls[0]?.[0] as { poolType: string; name: string; externalId: string; email: string | null }
    expect(accountInput.poolType).toBe("command-code")
    expect(accountInput.name).toContain("GOAT")
    expect(accountInput.name).toContain("goat")
    expect(accountInput.email).toBe("a@b.c")
    expect(accountInput.externalId).toMatch(/^[0-9a-f]{24}$/)

    const credentialInput = mocks.upsert.mock.calls[0]?.[0] as { poolType: string; credentialData: Record<string, string> }
    expect(credentialInput.poolType).toBe("command-code")
    expect(credentialInput.credentialData.token).toBe(VALID_KEY)
    expect(credentialInput.credentialData.authMode).toBe("apikey")
    expect(credentialInput.credentialData.commandCodeVerified).toBe("true")
    expect(credentialInput.credentialData.commandCodePlan).toBe("goat")
    expect(credentialInput.credentialData.commandCodeUserId).toBe("u_123")
    // 长期 key：无 refreshToken / expiresAt。
    expect(credentialInput.credentialData.refreshToken).toBeUndefined()
    expect(credentialInput.credentialData.expiresAt).toBeUndefined()
  })

  it("whoami 结构不符预期（返回 null）时仍建号（200 即 key 有效），plan 缺省", async () => {
    mocks.verifyCommandCodeApiKey.mockResolvedValue(null)
    const response = await POST(new Request("http://x/api/admin/accounts/command-code-apikey", {
      method: "POST",
      body: JSON.stringify({ apiKey: VALID_KEY }),
    }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { status: string; plan: string; verified: boolean }
    expect(payload.status).toBe("success")
    expect(payload.plan).toBe("")
    expect(payload.verified).toBe(true)
    const credentialInput = mocks.upsert.mock.calls[0]?.[0] as { credentialData: Record<string, string> }
    expect(credentialInput.credentialData.commandCodePlan).toBeUndefined()
    expect(credentialInput.credentialData.commandCodeUserId).toBeUndefined()
  })
})
