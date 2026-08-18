import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 内存 SQLite 与路由依赖的 mock 状态（vi.hoisted 保证 mock 工厂可引用）
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  db: null as unknown,
  routingState: { currentAccountId: "acct-1", preferredAccountId: null },
  poolTypeStats: {} as Record<string, { total: number; ready: number; blocked: number; inactive: number }>,
}))

vi.mock("../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => mocks.db }))
vi.mock("@/server/routing", () => ({
  RoutingService: class {
    constructor() {}
    getState() {
      return mocks.routingState
    }
    getPoolTypeStats() {
      return mocks.poolTypeStats
    }
  },
}))
vi.mock("@/server/pool-type-options", () => ({ listPoolTypeOptions: () => [] }))

import { GET } from "./route"

/** 建立测试用最小表结构（仅覆盖 overview 路由查询到的列）。 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE gateway_requests (
      id TEXT PRIMARY KEY, owner_user_id TEXT, api_key_id TEXT, endpoint TEXT, model TEXT,
      status INTEGER, outcome TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, completed_at TEXT,
      ok INTEGER, stream INTEGER, api_key_prefix TEXT, account_id TEXT, account_name TEXT,
      latency_ms INTEGER, first_token_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
      total_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER, client TEXT, error TEXT
    );
    CREATE TABLE request_bodies (request_id TEXT PRIMARY KEY, has_request INTEGER NOT NULL DEFAULT 0, has_response INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE gateway_attempts (
      request_id TEXT, id TEXT PRIMARY KEY, account_id TEXT, account_name TEXT, attempt_number INTEGER NOT NULL,
      status INTEGER, decision TEXT, error_type TEXT, error_message TEXT, latency_ms INTEGER,
      started_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE events (id TEXT PRIMARY KEY, owner_user_id TEXT, type TEXT NOT NULL, severity TEXT NOT NULL, account_id TEXT, request_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, email TEXT);
    CREATE TABLE quota_windows (account_id TEXT, usage_percent REAL, reset_at TEXT);
  `)
  return db
}

/** 插入 overview 路由测试的基础数据。 */
function seed(db: Database.Database, ownerId = "owner") {
  const insertAccount = db.prepare("INSERT INTO accounts (id, owner_user_id, name, email) VALUES (?, ?, ?, ?)")
  insertAccount.run("acct-1", ownerId, "Go 账号", "go@example.com")
  insertAccount.run("acct-2", ownerId, "OpenAI 账号", "openai@example.com")
  // 其他用户的数据，验证 owner 过滤
  db.prepare("INSERT INTO accounts (id, owner_user_id, name, email) VALUES ('acct-other', 'other', '别人', 'other@example.com')").run()

  db.prepare("INSERT INTO api_keys (id, owner_user_id, name, enabled) VALUES ('key-1', ?, '主密钥', 1)").run(ownerId)
  db.prepare("INSERT INTO api_keys (id, owner_user_id, name, enabled) VALUES ('key-disabled', ?, '停用密钥', 0)").run(ownerId)

  const insertRequest = db.prepare(`INSERT INTO gateway_requests
    (id, owner_user_id, api_key_id, endpoint, model, status, outcome, attempt_count, started_at, completed_at,
     ok, stream, api_key_prefix, account_id, account_name, latency_ms, prompt_tokens, completion_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  insertRequest.run("req-1", ownerId, "key-1", "/v1/chat/completions", "gpt-4o", 200, "success", 1, "2026-01-10T10:00:00.000Z", "2026-01-10T10:00:05.000Z", 1, 1, "ocg_1", "acct-1", "Go 账号", 120, 100, 200, 300)
  insertRequest.run("req-2", ownerId, "key-1", "/v1/chat/completions", "gpt-4o-mini", 200, "success", 2, "2026-01-09T10:00:00.000Z", "2026-01-09T10:00:04.000Z", 1, 0, "ocg_1", "acct-1", "Go 账号", 90, 50, 80, 130)
  insertRequest.run("req-3", ownerId, "key-1", "/v1/responses", "o3-mini", 500, "error", 1, "2026-01-08T10:00:00.000Z", "2026-01-08T10:00:01.000Z", 0, 0, "ocg_2", "acct-2", "OpenAI 账号", 200, 0, 0, 0)
  insertRequest.run("req-other", "other", null, "/v1/chat/completions", "gpt-4o", 200, "success", 1, "2026-01-11T10:00:00.000Z", null, 1, 0, null, null, null, null, 0, 0, 0)

  const insertEvent = db.prepare("INSERT INTO events (id, owner_user_id, type, severity, account_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
  insertEvent.run("ev-1", ownerId, "QUOTA_RESET", "info", "acct-1", "{}", "2026-01-10T09:00:00.000Z")
  insertEvent.run("ev-2", ownerId, "CREDENTIAL_INVALID", "error", "acct-2", "{\"reason\":\"401\"}", "2026-01-07T09:00:00.000Z")
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockReturnValue({ id: "owner" })
  mocks.routingState = { currentAccountId: "acct-1", preferredAccountId: "acct-2" }
  mocks.poolTypeStats = {}
  const db = createTestDb()
  seed(db)
  mocks.db = db
})

describe("GET /api/admin/overview", () => {
  it("无参数时与原来一致：返回全部最近请求/事件与 accounts 数组", async () => {
    const response = await GET(new Request("http://x/api/admin/overview"))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      counts: { totalAccounts: number; apiKeys: number }
      recentRequests: Array<{ id: string; createdAt: string }>
      recentEvents: Array<{ id: string }>
      accounts: Array<{ id: string; name: string; email: string | null }>
      routing: { currentAccountName: string | null }
      poolTypes: unknown[]
    }
    // 最近请求按 started_at 倒序，且不包含其他用户的数据
    expect(payload.recentRequests.map((row) => row.id)).toEqual(["req-1", "req-2", "req-3"])
    expect(payload.recentRequests[0]?.createdAt).toBe("2026-01-10T10:00:00.000Z")
    expect(payload.recentEvents.length).toBe(2)
    expect(payload.counts.totalAccounts).toBe(2)
    expect(payload.counts.apiKeys).toBe(1)
    // accounts 数组按 name 排序，含 email
    expect(payload.accounts).toEqual([
      { id: "acct-1", name: "Go 账号", email: "go@example.com" },
      { id: "acct-2", name: "OpenAI 账号", email: "openai@example.com" },
    ])
    // routing 名称来自 accounts 查找
    expect(payload.routing.currentAccountName).toBe("Go 账号")
    expect(payload.poolTypes).toEqual([])
  })

  it("from/to 过滤最近请求与最近事件", async () => {
    const response = await GET(new Request(
      "http://x/api/admin/overview?from=2026-01-09T00:00:00.000Z&to=2026-01-09T23:59:59.999Z",
    ))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { recentRequests: Array<{ id: string }>; recentEvents: Array<{ id: string }> }
    expect(payload.recentRequests.map((row) => row.id)).toEqual(["req-2"])
    expect(payload.recentEvents).toEqual([])

    // 只传 from / 只传 to 也可用
    const fromOnly = await GET(new Request("http://x/api/admin/overview?from=2026-01-09T00:00:00.000Z"))
    const fromPayload = (await fromOnly.json()) as { recentRequests: Array<{ id: string }> }
    expect(fromPayload.recentRequests.map((row) => row.id)).toEqual(["req-1", "req-2"])

    const toOnly = await GET(new Request("http://x/api/admin/overview?to=2026-01-08T12:00:00.000Z"))
    const toPayload = (await toOnly.json()) as { recentRequests: Array<{ id: string }>; recentEvents: Array<{ id: string }> }
    expect(toPayload.recentRequests.map((row) => row.id)).toEqual(["req-3"])
    expect(toPayload.recentEvents.map((event) => event.id)).toEqual(["ev-2"])
  })

  it("非法时间参数返回 400 且报「时间参数格式无效」", async () => {
    const response = await GET(new Request("http://x/api/admin/overview?from=not-a-date"))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe("时间参数格式无效")
  })

  it("from 晚于 to 返回 400", async () => {
    const response = await GET(new Request("http://x/api/admin/overview?from=2026-01-10T00:00:00.000Z&to=2026-01-09T00:00:00.000Z"))
    expect(response.status).toBe(400)
  })

  it("accountId 逗号分隔多值过滤（含单值兼容与空结果）", async () => {
    const single = await GET(new Request("http://x/api/admin/overview?accountId=acct-1"))
    const singlePayload = (await single.json()) as { recentRequests: Array<{ id: string }> }
    expect(singlePayload.recentRequests.map((row) => row.id)).toEqual(["req-1", "req-2"])

    const multi = await GET(new Request("http://x/api/admin/overview?accountId=acct-1,acct-2"))
    const multiPayload = (await multi.json()) as { recentRequests: Array<{ id: string }> }
    expect(multiPayload.recentRequests.map((row) => row.id)).toEqual(["req-1", "req-2", "req-3"])

    const none = await GET(new Request("http://x/api/admin/overview?accountId=acct-9"))
    const nonePayload = (await none.json()) as { recentRequests: Array<{ id: string }>; recentEvents: Array<{ id: string }> }
    expect(nonePayload.recentRequests).toEqual([])
    expect(nonePayload.recentEvents).toEqual([])
  })

  it("空值 from/to/accountId 视为未传", async () => {
    const response = await GET(new Request("http://x/api/admin/overview?from=&to=&accountId="))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { recentRequests: Array<{ id: string }> }
    expect(payload.recentRequests.map((row) => row.id)).toEqual(["req-1", "req-2", "req-3"])
  })
})
