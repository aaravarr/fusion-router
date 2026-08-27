import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  db: null as unknown,
}))

vi.mock("../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => mocks.db }))
vi.mock("@/server/pool-type-options", () => ({ listPoolTypeOptions: (ownerId: string) => [
  { type: "opencode-go", label: "OpenCode Go" },
  { type: ownerId, label: "自定义池" },
] }))

import { GET } from "./route"

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
    CREATE TABLE accounts (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, pool_type TEXT NOT NULL DEFAULT 'opencode-go');
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT);
  `)
  return db
}

const hourMs = 3600 * 1000
const dayMs = 24 * hourMs
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

/** 带 query 发起 facets 请求（接口不读取任何筛选参数，选项集必须恒定）。 */
async function getFacets(query = ""): Promise<{ status: number; models: string[]; poolTypes: Array<{ type: string }> }> {
  const response = await GET(new Request(`http://x/api/admin/usage/facets${query}`))
  const payload = (await response.json()) as { models: string[]; poolTypes: Array<{ type: string }> }
  return { status: response.status, models: payload.models, poolTypes: payload.poolTypes }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockReturnValue({ id: "owner" })
  mocks.db = createTestDb()
})

describe("GET /api/admin/usage/facets", () => {
  // 注意：cachedCount 的 TTL 缓存是模块级共享的，各用例用独立 user.id 避免 key 冲突。
  it("选项来自固定来源：配置表全量 + 请求采样，与筛选结果集无关", async () => {
    mocks.requireSession.mockReturnValue({ id: "facets-owner" })
    const db = mocks.db as Database.Database
    const insert = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, started_at, model) VALUES (?, ?, ?, ?)`
    )
    insert.run("r1", "facets-owner", iso(50 * hourMs), "kimi-k2")
    insert.run("r2", "facets-owner", iso(26 * dayMs), "gpt-x")
    insert.run("r3", "other-user", iso(1 * hourMs), "leak-model")
    db.prepare("INSERT INTO api_keys (id, owner_user_id, name) VALUES (?, ?, ?)").run("key-1", "facets-owner", "主密钥")

    const { status, models, poolTypes } = await getFacets()
    expect(status).toBe(200)
    // 模型选项只取决于采样窗口内的数据，不依赖任何 usage 结果集
    expect(models).toEqual(["gpt-x", "kimi-k2"])
    expect(poolTypes.map((pool) => pool.type)).toContain("opencode-go")
    // owner 隔离：其他用户数据不可见
    expect(models).not.toContain("leak-model")
  })

  it("回归：带筛选参数调用返回的选项集与不带参数完全一致（不随筛选缩水）", async () => {
    mocks.requireSession.mockReturnValue({ id: "stable-owner" })
    const db = mocks.db as Database.Database
    const insert = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, started_at, model) VALUES (?, ?, ?, ?)`
    )
    // 三条不同模型的记录；即使按 model=gpt-x 筛选，下拉也应保留全部模型选项
    insert.run("r1", "stable-owner", iso(1 * hourMs), "gpt-x")
    insert.run("r2", "stable-owner", iso(2 * hourMs), "kimi-k2")
    insert.run("r3", "stable-owner", iso(20 * dayMs), "grok-4")

    const baseline = await getFacets()
    for (const query of [
      "?model=gpt-x",
      "?model=gpt-x,kimi-k2&poolType=opencode-go&accountId=acct-1&apiKeyIds=key-1",
      "?hours=1&granularity=5m&poolType=kimi-code",
    ]) {
      const filtered = await getFacets(query)
      expect(filtered.status).toBe(200)
      expect(filtered.models).toEqual(baseline.models)
      expect(filtered.poolTypes).toEqual(baseline.poolTypes)
    }
  })

  it("60s TTL 缓存：第二次调用不重复扫库（数据变更后仍返回缓存值）", async () => {
    mocks.requireSession.mockReturnValue({ id: "cache-owner" })
    const db = mocks.db as Database.Database
    const insert = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, started_at, model) VALUES (?, ?, ?, ?)`
    )
    insert.run("r1", "cache-owner", iso(1 * hourMs), "model-a")
    await getFacets()
    insert.run("r2", "cache-owner", iso(30 * 60 * 1000), "model-b")
    const second = await getFacets()
    expect(second.models).toEqual(["model-a"])
  })
})
