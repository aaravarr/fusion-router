import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  db: null as unknown,
}))

vi.mock("../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => mocks.db }))
vi.mock("@/server/model-pricing", () => ({ estimateUsageCost: () => ({ costUsd: null }), formatUsd: () => "$0" }))

import { GET } from "./route"

/** 建立测试用最小表结构（覆盖 requests 路由查询到的列）。 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE gateway_requests (
      id TEXT PRIMARY KEY, owner_user_id TEXT, api_key_id TEXT, endpoint TEXT, model TEXT,
      status INTEGER, outcome TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, completed_at TEXT,
      ok INTEGER, stream INTEGER, api_key_prefix TEXT, account_id TEXT, account_name TEXT,
      latency_ms INTEGER, local_prep_ms INTEGER, first_token_ms INTEGER,
      prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
      text_tokens INTEGER, image_tokens INTEGER, audio_tokens INTEGER,
      client TEXT, error TEXT, inbound_endpoint TEXT, upstream_endpoint TEXT,
      process_mode TEXT, route_mode TEXT, route_reason TEXT, converted INTEGER, transform_summary TEXT
    );
    CREATE TABLE request_bodies (request_id TEXT PRIMARY KEY, has_request INTEGER, has_response INTEGER);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, owner_user_id TEXT, pool_type TEXT NOT NULL);
  `)
  return db
}

interface InsertOpts {
  apiKeyId?: string | null;
  accountId?: string | null;
  model?: string | null;
  ok?: number;
  startedAt: string;
  client?: string | null;
  inbound?: string | null;
  upstream?: string | null;
  error?: string | null;
}

function insertRequest(db: Database.Database, id: string, opts: InsertOpts) {
  db.prepare(
    `INSERT INTO gateway_requests
      (id, owner_user_id, api_key_id, api_key_prefix, endpoint, model, status, outcome, attempt_count, started_at,
       ok, stream, account_id, account_name, client, error, inbound_endpoint, upstream_endpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .run(
      id,
      "owner",
      opts.apiKeyId ?? null,
      opts.apiKeyId ? "sk-" + opts.apiKeyId : null,
      "/v1/chat/completions",
      opts.model ?? null,
      opts.ok === 0 ? 500 : 200,
      opts.ok === 0 ? "error" : "success",
      1,
      opts.startedAt,
      opts.ok ?? 1,
      0,
      opts.accountId ?? null,
      opts.accountId ?? null,
      opts.client ?? null,
      opts.error ?? null,
      opts.inbound ?? "/v1/chat/completions",
      opts.upstream ?? "/v1/chat/completions",
    )
}

const hourMs = 3600 * 1000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockReturnValue({ id: "owner" })
  const db = createTestDb()
  db.prepare(`INSERT INTO api_keys (id, owner_user_id, name) VALUES (?, ?, ?)`).run("key-1", "owner", "主密钥")
  db.prepare(`INSERT INTO api_keys (id, owner_user_id, name) VALUES (?, ?, ?)`).run("key-2", "owner", "备用密钥")
  db.prepare(`INSERT INTO accounts (id, owner_user_id, pool_type) VALUES (?, ?, ?)`).run("acct-1", "owner", "opencode-go")
  db.prepare(`INSERT INTO accounts (id, owner_user_id, pool_type) VALUES (?, ?, ?)`).run("acct-2", "owner", "kimi-code")
  db.prepare(`INSERT INTO accounts (id, owner_user_id, pool_type) VALUES (?, ?, ?)`).run("acct-3", "other-user", "opencode-go")
  mocks.db = db
})

async function listIds(url: string): Promise<{ ids: string[]; payload: { total: number; totalApproximate?: boolean; page: number; pageSize: number }; status: number }> {
  const response = await GET(new Request(url))
  const payload = (await response.json()) as { items: Array<{ id: string }>; total: number; totalApproximate?: boolean; page: number; pageSize: number }
  return { ids: payload.items.map((item) => item.id), payload, status: response.status }
}

describe("GET /api/admin/requests 组合筛选", () => {
  it("无参数回归：返回全部本用户请求且带 totalApproximate 字段", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "r-1", { startedAt: iso(1 * hourMs), accountId: "acct-1", apiKeyId: "key-1", model: "gpt-x" })
    insertRequest(db, "r-2", { startedAt: iso(2 * hourMs), accountId: "acct-2", apiKeyId: "key-2", model: "kimi-k2" })
    const { ids, payload, status } = await listIds("http://x/api/admin/requests")
    expect(status).toBe(200)
    expect(ids.sort()).toEqual(["r-1", "r-2"])
    expect(payload.totalApproximate).toBe(false)
    expect(payload.page).toBe(1)
  })

  it("多值 IN 组合 AND：models × accountIds × apiKeyIds 同时命中才返回", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "hit", { startedAt: iso(1 * hourMs), accountId: "acct-1", apiKeyId: "key-1", model: "gpt-x" })
    insertRequest(db, "miss-model", { startedAt: iso(1 * hourMs), accountId: "acct-1", apiKeyId: "key-1", model: "kimi-k2" })
    insertRequest(db, "miss-key", { startedAt: iso(1 * hourMs), accountId: "acct-1", apiKeyId: "key-2", model: "gpt-x" })
    const { ids } = await listIds("http://x/api/admin/requests?models=gpt-x&accountIds=acct-1&apiKeyIds=key-1")
    expect(ids).toEqual(["hit"])
  })

  it("时间范围 from/to 只保留窗口内数据，非法值返回 400", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "in-window", { startedAt: iso(1 * hourMs) })
    insertRequest(db, "old", { startedAt: iso(48 * hourMs) })
    const url = `http://x/api/admin/requests?from=${encodeURIComponent(iso(24 * hourMs))}&to=${encodeURIComponent(iso(0))}`
    const { ids } = await listIds(url)
    expect(ids).toEqual(["in-window"])

    const bad = await GET(new Request("http://x/api/admin/requests?from=not-a-date"))
    expect(bad.status).toBe(400)
    const reversed = await GET(new Request(`http://x/api/admin/requests?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(5 * hourMs))}`))
    expect(reversed.status).toBe(400)
  })

  it("关键词 q 覆盖 request id / model / client / error", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "req-special-id", { startedAt: iso(1 * hourMs) })
    insertRequest(db, "r-model", { startedAt: iso(2 * hourMs), model: "gemini-flash-pro" })
    insertRequest(db, "r-client", { startedAt: iso(3 * hourMs), client: "codex-cli/7.1" })
    insertRequest(db, "r-error", { startedAt: iso(4 * hourMs), error: "upstream quota exceeded", ok: 0 })
    insertRequest(db, "r-other", { startedAt: iso(5 * hourMs), model: "kimi-k2" })

    for (const [q, expected] of [
      ["special", ["req-special-id"]],
      ["flash-pro", ["r-model"]],
      ["codex-cli", ["r-client"]],
      ["quota exceeded", ["r-error"]],
    ] as const) {
      const { ids } = await listIds(`http://x/api/admin/requests?q=${encodeURIComponent(q)}`)
      expect(ids, `q=${q}`).toEqual(expected)
    }
  })

  it("providers 过滤走账号 pool_type 子查询（含跨用户隔离）", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "go-req", { startedAt: iso(1 * hourMs), accountId: "acct-1" })
    insertRequest(db, "kimi-req", { startedAt: iso(1 * hourMs), accountId: "acct-2" })
    const { ids } = await listIds("http://x/api/admin/requests?providers=kimi-code")
    expect(ids).toEqual(["kimi-req"])

    const multi = await listIds("http://x/api/admin/requests?providers=opencode-go,kimi-code")
    expect(multi.ids.sort()).toEqual(["go-req", "kimi-req"])
  })

  it("双路径与客户端维度过滤", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "messages-in", { startedAt: iso(1 * hourMs), inbound: "/v1/messages", upstream: "/v1/chat/completions" })
    insertRequest(db, "responses-native", { startedAt: iso(2 * hourMs), inbound: "/v1/responses", upstream: "/v1/responses", client: "codex-cli" })
    const inbound = await listIds("http://x/api/admin/requests?inboundEndpoints=/v1/messages")
    expect(inbound.ids).toEqual(["messages-in"])
    const upstream = await listIds("http://x/api/admin/requests?upstreamEndpoints=/v1/responses")
    expect(upstream.ids).toEqual(["responses-native"])
    const clients = await listIds("http://x/api/admin/requests?clients=codex-cli")
    expect(clients.ids).toEqual(["responses-native"])
  })

  it("组合筛选同时作用于封顶计数缓存 key（不同条件 total 不串数据）", async () => {
    const db = mocks.db as Database.Database
    insertRequest(db, "a", { startedAt: iso(1 * hourMs), accountId: "acct-1" })
    insertRequest(db, "b", { startedAt: iso(1 * hourMs), accountId: "acct-2" })
    insertRequest(db, "c", { startedAt: iso(1 * hourMs), accountId: "acct-2" })
    const one = await listIds("http://x/api/admin/requests?accountIds=acct-1")
    const two = await listIds("http://x/api/admin/requests?accountIds=acct-2")
    expect(one.payload.total).toBe(1)
    expect(two.payload.total).toBe(2)
  })
})