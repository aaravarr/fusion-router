import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  db: null as unknown,
}))

vi.mock("../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => mocks.db }))
vi.mock("@/server/model-pricing", () => ({ estimateUsageCost: () => ({ costUsd: null }) }))
vi.mock("@/server/pool-type-options", () => ({ listPoolTypeOptions: () => [] }))

import { GET } from "./route"

/** 建立测试用最小表结构（仅覆盖 usage 路由查询到的列）。 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE gateway_requests (
      id TEXT PRIMARY KEY, owner_user_id TEXT, api_key_id TEXT, endpoint TEXT, model TEXT,
      status INTEGER, outcome TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, completed_at TEXT,
      ok INTEGER, stream INTEGER, api_key_prefix TEXT, account_id TEXT, account_name TEXT,
      latency_ms INTEGER, local_prep_ms INTEGER, first_token_ms INTEGER,
      prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
      cached_tokens INTEGER, reasoning_tokens INTEGER, client TEXT, error TEXT
    );
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, pool_type TEXT NOT NULL DEFAULT 'opencode-go');
  `)
  return db
}

function insertRequest(
  db: Database.Database,
  id: string,
  opts: { accountId?: string | null; accountName?: string | null; startedAt: string; ok?: number; model?: string | null },
) {
  db.prepare(`INSERT INTO gateway_requests
    (id, owner_user_id, api_key_id, endpoint, model, status, outcome, attempt_count, started_at,
     ok, stream, api_key_prefix, account_id, account_name, latency_ms, prompt_tokens, completion_tokens, total_tokens)
    VALUES (?, 'owner', NULL, '/v1/chat/completions', ?, 200, 'success', 1, ?, ?, 0, 'prefix', ?, ?, 100, 10, 20, 30)`)
    .run(id, opts.model ?? null, opts.startedAt, opts.ok ?? 1, opts.accountId ?? null, opts.accountName ?? null)
}

const hourMs = 3600 * 1000
const dayMs = 24 * hourMs
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockReturnValue({ id: "owner" })
  const db = createTestDb()
  const insertAccount = db.prepare("INSERT INTO accounts (id, owner_user_id, name, pool_type) VALUES (?, 'owner', ?, ?)")
  insertAccount.run("acct-1", "Go 账号", "opencode-go")
  insertAccount.run("acct-2", "OpenAI 账号", "openai")
  insertAccount.run("acct-3", "Kimi 账号", "kimi-code")
  mocks.db = db
})

describe("GET /api/admin/usage", () => {
  it("无参数回归：按默认 24h 窗口统计并返回完整结构", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "r-1", { accountId: "acct-1", accountName: "Go 账号", startedAt: iso(1 * hourMs) })
    insertRequest(db, "r-2", { accountId: "acct-2", accountName: "OpenAI 账号", startedAt: iso(2 * hourMs) })

    const response = await GET(new Request("http://x/api/admin/usage?hours=24&granularity=auto"))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      summary: { requests: number; ok: number }
      byTime: unknown[]
      byAccount: Array<{ key: string }>
      byModel: unknown[]
      byKey: unknown[]
      poolTypes: unknown[]
    }
    expect(payload.summary.requests).toBe(2)
    expect(payload.summary.ok).toBe(2)
    expect(payload.byTime.length).toBeGreaterThan(0)
    expect(payload.byAccount.map((bucket) => bucket.key).sort()).toEqual(["acct-1", "acct-2"])
    expect(payload.poolTypes).toEqual([])
  })

  it("from/to 替代 hours 窗口：只统计窗口内数据（且缓存 key 含 from/to 不会串数据）", async () => {
    const db = mocks.db as Database.Database
    // 窗口内 1 条（1 小时前），窗口外 2 条（3 天前）
    insertRequest(db, "w-in", { accountId: "acct-1", accountName: "Go 账号", startedAt: iso(1 * hourMs) })
    insertRequest(db, "w-out-1", { accountId: "acct-2", accountName: "OpenAI 账号", startedAt: iso(3 * dayMs) })
    insertRequest(db, "w-out-2", { accountId: "acct-2", accountName: "OpenAI 账号", startedAt: iso(4 * dayMs) })

    const url = `http://x/api/admin/usage?from=${encodeURIComponent(iso(2 * dayMs))}&to=${encodeURIComponent(iso(0))}&granularity=auto`
    // 注意：此请求的缓存 key 包含 from/to，若实现遗漏该字段会命中"无参数"缓存导致断言失败
    const response = await GET(new Request(url))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { summary: { requests: number } }
    expect(payload.summary.requests).toBe(1)
  })

  it("非法时间参数返回 400", async () => {
    const response = await GET(new Request("http://x/api/admin/usage?from=not-a-date"))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe("时间参数格式无效")

    const responseTo = await GET(new Request("http://x/api/admin/usage?to=2026-99-99"))
    expect(responseTo.status).toBe(400)
  })

  it("from 晚于 to 返回 400", async () => {
    const response = await GET(new Request(`http://x/api/admin/usage?from=${iso(0)}&to=${iso(1 * dayMs)}`))
    expect(response.status).toBe(400)
  })

  it("自定义时间范围超过 92 天返回 400，92 天内通过", async () => {
    const over = await GET(new Request("http://x/api/admin/usage?from=2026-01-01T00:00:00.000Z&to=2026-04-10T00:00:00.000Z"))
    expect(over.status).toBe(400)
    expect(((await over.json()) as { error: string }).error).toBe("自定义时间范围最长 92 天")

    const within = await GET(new Request("http://x/api/admin/usage?from=2026-01-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z"))
    expect(within.status).toBe(200)
  })

  it("accountId 逗号分隔多值 IN 过滤（含单值兼容）", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "r-a1", { accountId: "acct-1", accountName: "Go 账号", startedAt: iso(1 * hourMs) })
    insertRequest(db, "r-a2", { accountId: "acct-2", accountName: "OpenAI 账号", startedAt: iso(2 * hourMs) })
    insertRequest(db, "r-a3", { accountId: "acct-3", accountName: "Kimi 账号", startedAt: iso(3 * hourMs) })

    const multi = await GET(new Request("http://x/api/admin/usage?accountId=acct-1,acct-2&granularity=auto"))
    expect(multi.status).toBe(200)
    const multiPayload = (await multi.json()) as { summary: { requests: number }; byAccount: Array<{ key: string }> }
    expect(multiPayload.summary.requests).toBe(2)
    expect(multiPayload.byAccount.map((bucket) => bucket.key).sort()).toEqual(["acct-1", "acct-2"])

    // 单值兼容：无逗号时行为与原来一致
    const single = await GET(new Request("http://x/api/admin/usage?accountId=acct-3&granularity=auto"))
    const singlePayload = (await single.json()) as { summary: { requests: number } }
    expect(singlePayload.summary.requests).toBe(1)
  })

  it("apiKeyId 按密钥过滤（用量看板密钥下拉）", async () => {
    const db = mocks.db as Database.Database
    const insertWithKey = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, api_key_id, endpoint, model, status, outcome, attempt_count, started_at, ok, stream, api_key_prefix, account_id, account_name, latency_ms, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const isoAt = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    insertWithKey.run("k-hit", "owner", "key-a", "/v1/chat/completions", null, 200, "success", 1, isoAt(1 * hourMs), 1, 0, "pa", null, null, 100, 10, 20, 30)
    insertWithKey.run("k-miss", "owner", "key-b", "/v1/chat/completions", null, 200, "success", 1, isoAt(1 * hourMs), 1, 0, "pb", null, null, 100, 10, 20, 30)
    const response = await GET(new Request("http://x/api/admin/usage?hours=24&granularity=auto&apiKeyId=key-a"))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { summary: { requests: number }; byKey: Array<{ key: string }> }
    expect(payload.summary.requests).toBe(1)
    expect(payload.byKey.map((bucket) => bucket.key)).toEqual(["key-a"])
  })

  it("apiKeyIds 逗号分隔多值 IN 过滤（兼容旧 apiKeyId 单值，缓存 key 不串数据）", async () => {
    const db = mocks.db as Database.Database
    const insertWithKey = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, api_key_id, endpoint, model, status, outcome, attempt_count, started_at, ok, stream, api_key_prefix, account_id, account_name, latency_ms, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const isoAt = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    insertWithKey.run("mk-1", "owner", "key-a", "/v1/chat/completions", null, 200, "success", 1, isoAt(1 * hourMs), 1, 0, "pa", null, null, 100, 10, 20, 30)
    insertWithKey.run("mk-2", "owner", "key-b", "/v1/chat/completions", null, 200, "success", 1, isoAt(1 * hourMs), 1, 0, "pb", null, null, 100, 10, 20, 30)
    insertWithKey.run("mk-3", "owner", "key-c", "/v1/chat/completions", null, 200, "success", 1, isoAt(1 * hourMs), 1, 0, "pc", null, null, 100, 10, 20, 30)

    // 多值：只统计 key-a / key-b
    const multi = await GET(new Request("http://x/api/admin/usage?hours=24&granularity=auto&apiKeyIds=key-a,key-b"))
    expect(multi.status).toBe(200)
    const multiPayload = (await multi.json()) as { summary: { requests: number }; byKey: Array<{ key: string }> }
    expect(multiPayload.summary.requests).toBe(2)
    expect(multiPayload.byKey.map((bucket) => bucket.key).sort()).toEqual(["key-a", "key-b"])

    // 单值兼容：无逗号时行为一致；且与上面多值请求缓存 key 不同，不会串数据
    const single = await GET(new Request("http://x/api/admin/usage?hours=24&granularity=auto&apiKeyIds=key-c"))
    const singlePayload = (await single.json()) as { summary: { requests: number }; byKey: Array<{ key: string }> }
    expect(singlePayload.summary.requests).toBe(1)
    expect(singlePayload.byKey.map((bucket) => bucket.key)).toEqual(["key-c"])

    // 新旧参数并存：并入去重生效（key-b 已在列表中，不重复计数）
    const both = await GET(new Request("http://x/api/admin/usage?hours=24&granularity=auto&apiKeyIds=key-a&apiKeyId=key-b"))
    const bothPayload = (await both.json()) as { summary: { requests: number }; byKey: Array<{ key: string }> }
    expect(bothPayload.summary.requests).toBe(2)
    expect(bothPayload.byKey.map((bucket) => bucket.key).sort()).toEqual(["key-a", "key-b"])

    // 旧单值参数回归：仍按精确过滤
    const legacy = await GET(new Request("http://x/api/admin/usage?hours=24&granularity=auto&apiKeyId=key-a"))
    const legacyPayload = (await legacy.json()) as { summary: { requests: number }; byKey: Array<{ key: string }> }
    expect(legacyPayload.summary.requests).toBe(1)
    expect(legacyPayload.byKey.map((bucket) => bucket.key)).toEqual(["key-a"])
  })
})