import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountRecord } from "@/server/types"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  account: null as AccountRecord | null,
  summary: null as unknown,
  serviceError: null as Error | null,
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
    listReferralRewards: async () => {
      if (mocks.serviceError) throw mocks.serviceError
      return mocks.summary
    },
    applyReferralReward: async () => {
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
  })

  it("返回奖励摘要", async () => {
    const response = await GET(new Request("http://x/api/admin/accounts/acct-1/referrals"), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(mocks.summary)
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
  })

  it("兑换成功返回 applied", async () => {
    const response = await POST(new Request("http://x/api/admin/accounts/acct-1/referrals/apply", {
      method: "POST",
      body: JSON.stringify({ referralId: "ref_1" }),
    }), { params: Promise.resolve({ id: "acct-1" }) } as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: true })
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
