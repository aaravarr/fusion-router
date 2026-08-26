import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  db: null as unknown,
}))

vi.mock("../../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => mocks.db }))

import { GET } from "./route"

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
    CREATE TABLE accounts (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, pool_type TEXT NOT NULL);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT, key_prefix TEXT, created_at TEXT);
  `)
  return db
}

interface Facets {
  sampledRows: number;
  approximate: boolean;
  accounts: Array<{ id: string; name: string }>;
  apiKeys: Array<{ id: string; name: string; prefix: string }>;
  providers: string[];
  models: string[];
  inboundEndpoints: string[];
  upstreamEndpoints: string[];
  clients: string[];
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockReturnValue({ id: "owner" })
  mocks.db = createTestDb()
})

async function getFacets(): Promise<{ status: number; facets: Facets }> {
  const response = await GET(new Request("http://x/api/admin/requests/facets"))
  return { status: response.status, facets: (await response.json()) as Facets }
}

describe("GET /api/admin/requests/facets", () => {
  // 注意：cachedCount 的 TTL 缓存是模块级共享的，各用例用独立 user.id 避免 key 冲突。
  it("返回各维度去重选项（排序稳定），配置表全量、请求维度来自采样", async () => {
    const db = mocks.db as Database.Database
    const insert = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, started_at, model, inbound_endpoint, upstream_endpoint, client) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    // 故意乱序插入，验证 DISTINCT + 排序
    insert.run("r1", "owner", "2026-01-03T00:00:00Z", "kimi-k2", "/v1/messages", "/v1/chat/completions", "codex-cli")
    insert.run("r2", "owner", "2026-01-02T00:00:00Z", "gpt-x", "/v1/chat/completions", "/v1/chat/completions", null)
    insert.run("r3", "owner", "2026-01-01T00:00:00Z", "gpt-x", "/v1/responses", "/v1/responses", "claude-code")
    insert.run("r4", "other-user", "2026-01-04T00:00:00Z", "leak-model", "/leak", "/leak", "leak-client")
    db.prepare("INSERT INTO accounts (id, owner_user_id, name, pool_type) VALUES (?, ?, ?, ?)").run("acct-1", "owner", "账号 A", "opencode-go")
    db.prepare("INSERT INTO accounts (id, owner_user_id, name, pool_type) VALUES (?, ?, ?, ?)").run("acct-2", "owner", "账号 B", "kimi-code")
    db.prepare("INSERT INTO api_keys (id, owner_user_id, name, key_prefix) VALUES (?, ?, ?, ?)").run("key-1", "owner", "主密钥", "sk-main")

    const { status, facets } = await getFacets()
    expect(status).toBe(200)
    expect(facets.sampledRows).toBe(3)
    expect(facets.approximate).toBe(false)
    expect(facets.models).toEqual(["gpt-x", "kimi-k2"])
    expect(facets.inboundEndpoints).toEqual(["/v1/chat/completions", "/v1/messages", "/v1/responses"])
    expect(facets.upstreamEndpoints).toEqual(["/v1/chat/completions", "/v1/responses"])
    expect(facets.clients).toEqual(["claude-code", "codex-cli"])
    expect(facets.providers).toEqual(["kimi-code", "opencode-go"])
    expect(facets.accounts).toEqual([{ id: "acct-1", name: "账号 A" }, { id: "acct-2", name: "账号 B" }])
    expect(facets.apiKeys).toEqual([{ id: "key-1", name: "主密钥", prefix: "sk-main" }])
  })

  it("60s TTL 缓存：第二次调用不重复扫库（数据变更后仍返回缓存值）", async () => {
    mocks.requireSession.mockReturnValue({ id: "cache-owner" })
    const db = mocks.db as Database.Database
    const insert = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, started_at, model) VALUES (?, ?, ?, ?)`
    )
    insert.run("r1", "cache-owner", "2026-01-02T00:00:00Z", "model-a")
    await getFacets()
    insert.run("r2", "cache-owner", "2026-01-03T00:00:00Z", "model-b")
    const second = await getFacets()
    expect(second.facets.models).toEqual(["model-a"])
  })

  it("owner 隔离：不同用户互不可见（缓存 key 含 user.id）", async () => {
    const db = mocks.db as Database.Database
    const insert = db.prepare(
      `INSERT INTO gateway_requests (id, owner_user_id, started_at, model) VALUES (?, ?, ?, ?)`
    )
    mocks.requireSession.mockReturnValue({ id: "iso-user-a" })
    insert.run("r1", "iso-user-a", "2026-01-02T00:00:00Z", "model-a")
    await getFacets()
    mocks.requireSession.mockReturnValue({ id: "iso-user-b" })
    const other = await getFacets()
    expect(other.facets.models).toEqual([])
  })
})