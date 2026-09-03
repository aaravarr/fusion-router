import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountRecord } from "@/server/types"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  account: null as AccountRecord | null,
  serviceError: null as Error | null,
  setAllowTrainingArgs: [] as unknown[][],
  setChinaProvidersArgs: [] as unknown[][],
}))

vi.mock("../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => ({}) }))
vi.mock("@/server/repository", () => ({
  AccountRepository: class {
    constructor() {}
    get() {
      return mocks.account
    }
    updateState() {
      return mocks.account
    }
    bulkSetAdminState() {
      return { updated: 0, unchanged: 0, skippedBanned: 0, skippedCredentialInvalid: 0, skippedSpendingBlocked: 0, notFound: 0 }
    }
  },
}))
vi.mock("@/server/opencode-web/service", () => ({
  getOpenCodeWebService: () => ({
    setAllowTraining: async (...args: unknown[]) => {
      mocks.setAllowTrainingArgs.push(args)
      if (mocks.serviceError) throw mocks.serviceError
      return mocks.account
    },
    setChinaProviders: async (...args: unknown[]) => {
      mocks.setChinaProvidersArgs.push(args)
      if (mocks.serviceError) throw mocks.serviceError
      return mocks.account
    },
  }),
}))

import { PATCH } from "./route"

const goAccount = { id: "acct-1", poolType: "opencode-go", workspaceId: "wrk_1", name: "Go", email: "a@b.com", allowTraining: false } as AccountRecord

function patchRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://x/api/admin/accounts/acct-1", { method: "PATCH", headers, body: JSON.stringify(body) })
}

describe("PATCH /api/admin/accounts/[id] allowTraining", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.account = goAccount
    mocks.serviceError = null
    mocks.setAllowTrainingArgs = []
    mocks.setChinaProvidersArgs = []
  })

  it("开启开关：调用 service 并返回最新账号", async () => {
    const response = await PATCH(patchRequest({ allowTraining: true }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(mocks.setAllowTrainingArgs[0]).toEqual(["acct-1", true, { userAgent: undefined }])
    const payload = (await response.json()) as { account: AccountRecord }
    expect(payload.account.id).toBe("acct-1")
  })

  it("透传管理台请求的 User-Agent 给 service", async () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0"
    const response = await PATCH(patchRequest({ allowTraining: false }, { "user-agent": ua }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(mocks.setAllowTrainingArgs[0]).toEqual(["acct-1", false, { userAgent: ua }])
  })

  it("非 Go 账号返回 400", async () => {
    mocks.account = { id: "acct-1", poolType: "openai", workspaceId: "w" } as AccountRecord
    const response = await PATCH(patchRequest({ allowTraining: true }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(400)
    expect(mocks.setAllowTrainingArgs).toHaveLength(0)
  })

  it("上游失败返回 502（业务错误不返回 401）", async () => {
    const { OpenCodeWebError } = await import("@/server/opencode-web/client")
    mocks.serviceError = new OpenCodeWebError("OpenCode allow training update failed (500)", "UPSTREAM")
    const response = await PATCH(patchRequest({ allowTraining: true }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("opencode_action_failed")
  })

  it("allowTraining 非布尔时返回 400 且不调用 service", async () => {
    const response = await PATCH(patchRequest({ allowTraining: "yes" }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(400)
    expect(mocks.setAllowTrainingArgs).toHaveLength(0)
  })

  it("未携带 allowTraining 字段时不触发上游调用", async () => {
    const response = await PATCH(patchRequest({ name: "新名称" }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(mocks.setAllowTrainingArgs).toHaveLength(0)
    expect(mocks.setChinaProvidersArgs).toHaveLength(0)
  })
})
