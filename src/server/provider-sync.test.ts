import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, getDatabase, type AppDatabase } from "./db"
import { syncProviderAccount } from "./provider-sync"
import { AccountRepository, ProviderCredentialRepository } from "./repository"

const ownerUserId = "glm-sync-owner"
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase; __opencodeApiAccountSchemaVersion?: number }).__opencodeApiDb = value
}

const liveQuotaPayload = {
  code: 200,
  msg: "操作成功",
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 1277, remaining: 10722, percentage: 10, nextResetTime: 1789127069989 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 17130, remaining: 42869, percentage: 28, nextResetTime: 1789528364997 },
    ],
    level: "pro",
  },
  success: true,
}

beforeEach(() => {
  db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "glm-sync", "glm-sync", "GLM Sync", "USER", "hash", timestamp, timestamp)
  setGlobalDatabase(db)
  expect(getDatabase()).toBe(db)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setGlobalDatabase(undefined)
  db.close()
})

describe("syncProviderAccount GLM 配额快照", () => {
  it("用新的权威 5h 快照覆盖历史高值，而不被 MAX/MIN 合并逻辑卡住", async () => {
    const account = new AccountRepository(ownerUserId, db).createProviderAccount({ name: "live glm", poolType: "glm-coding" })
    new ProviderCredentialRepository(ownerUserId, db).upsert({
      accountId: account.id,
      poolType: "glm-coding",
      credentialData: { token: "key-id.secret-value", region: "cn", deviceMid: "a".repeat(32) },
    })
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value,unit,extra_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      ownerUserId,
      account.id,
      "FIVE_HOUR",
      99,
      "2026-09-11T11:44:29.989Z",
      "API_PROBE",
      "2026-09-11T08:22:52.191Z",
      12000,
      78,
      "tokens",
      JSON.stringify({ level: "pro" }),
    )
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(liveQuotaPayload)))

    await syncProviderAccount(ownerUserId, account.id, db)

    const row = db.prepare(`SELECT usage_percent,limit_value,remaining_value,source,last_observed_at,reset_at,unit,extra_json
      FROM quota_windows WHERE owner_user_id=? AND account_id=? AND kind='FIVE_HOUR'`).get(ownerUserId, account.id) as {
      usage_percent: number
      limit_value: number
      remaining_value: number
      source: string
      last_observed_at: string
      reset_at: string
      unit: string | null
      extra_json: string | null
    }
    expect(row).toMatchObject({
      usage_percent: 10,
      limit_value: 12000,
      remaining_value: 10722,
      source: "API_PROBE",
      reset_at: new Date(1789127069989).toISOString(),
      unit: null,
    })
    expect(row.last_observed_at).not.toBe("2026-09-11T08:22:52.191Z")
    expect(JSON.parse(row.extra_json ?? "{}")).toEqual({ level: "pro" })
    expect((vi.mocked(fetch).mock.calls[0]?.[0] as string)).toContain("/api/monitor/usage/quota/limit")
  })
})
