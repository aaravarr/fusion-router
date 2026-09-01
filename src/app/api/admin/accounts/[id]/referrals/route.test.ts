import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountRecord } from "@/server/types"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  account: null as AccountRecord | null,
  summary: null as unknown,
  serviceError: null as Error | null,
  listArgs: [] as unknown[][],
  applyArgs: [] as unknown[][],
}))

vi.mock("../../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => ({}) }))
vi.mock("@/server/repository", () => ({
  AccountRepository: class {
    constructor() {}
    get() {
      return mocks.account
    }
  },
}))
vi.mock("@/server/opencode-web/service", () => ({
  getOpenCodeWebService: () => ({
    listReferralRewards: async (...args: unknown[]) => {
      mocks.listArgs.push(args)
      if (mocks.serviceError) throw mocks.serviceError
      return mocks.summary
    },
    applyReferralReward: async (...args: unknown[]) => {
      mocks.applyArgs.push(args)
      if (mocks.serviceError) throw mocks.serviceError
      return { applied: true, account: mocks.account }
    },
  }),
}))

import { GET } from "./route"
import { POST } from "./apply/route"

const goAccount = { id: "acct-1", poolType: "opencode-go", workspaceId: "wrk_1", name: "Go", email: "a@b.com" } as AccountRecord

describe("GET /api/admin/accounts/[id]/referrals", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.account = goAccount
    mocks.summary = { referralCode: "CODE1", rewardAmount: 500, rewards: [] }
    mocks.serviceError = null
    mocks.listArgs = []
    mocks.applyArgs = []
  })

  it("返回奖励摘要", async () => {
    const response = await GET(new Request("http://x/api/admin/accounts/acct-1/referrals"), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(mocks.summary)
  })

  it("透传管理台请求的 User-Agent 给 service（无 UA 时为 undefined）", async () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0"
    await GET(new Request("http://x/api/admin/accounts/acct-1/referrals", { headers: { "user-agent": ua } }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(mocks.listArgs[0]).toEqual(["acct-1", { userAgent: ua }])
    await GET(new Request("http://x/api/admin/accounts/acct-1/referrals"), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(mocks.listArgs[1]).toEqual(["acct-1", { userAgent: undefined }])
  })

  it("非 Go 账号返回 400", async () => {
    mocks.account = { id: "acct-1", poolType: "openai", workspaceId: "w" } as AccountRecord
    const response = await GET(new Request("http://x/api/admin/accounts/acct-1/referrals"), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(400)
  })

  it("上游失败返回 502", async () => {
    mocks.serviceError = new Error("boom")
    const response = await GET(new Request("http://x/api/admin/accounts/acct-1/referrals"), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(502)
  })
})

describe("POST /api/admin/accounts/[id]/referrals/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.account = goAccount
    mocks.serviceError = null
    mocks.listArgs = []
    mocks.applyArgs = []
  })

  it("兑换成功返回 applied", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/acct-1/referrals/apply", {
      method: "POST",
      body: JSON.stringify({ referralId: "ref_1" }),
    }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: true })
  })

  it("透传管理台请求的 User-Agent 给兑换调用", async () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/26.0"
    const response = await POST(new Request("http://x/api/admin/accounts/acct-1/referrals/apply", {
      method: "POST",
      headers: { "user-agent": ua },
      body: JSON.stringify({ referralId: "ref_1" }),
    }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(mocks.applyArgs[0]).toEqual(["acct-1", "ref_1", { userAgent: ua }])
  })

  it("缺少 referralId 返回 400（不用 401）", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/acct-1/referrals/apply", {
      method: "POST",
      body: JSON.stringify({}),
    }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(400)
  })

  it("业务失败（非 AUTH）返回 502 非 401", async () => {
    const { OpenCodeWebError } = await import("@/server/opencode-web/client")
    mocks.serviceError = new OpenCodeWebError("Subscribe to Go before applying referral rewards", "UPSTREAM")
    const response = await POST(new Request("http://x/api/admin/accounts/acct-1/referrals/apply", {
      method: "POST",
      body: JSON.stringify({ referralId: "ref_1" }),
    }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("referral_apply_failed")
  })
})
