import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"

// GET/PUT /api/admin/pool-model-config：会话鉴权（401 走 requireSession）、
// 业务校验 400/422（禁 401）、写后失效 TTL 缓存。

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "cfg-owner" })),
  db: null as unknown,
}))

vi.mock("../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", () => ({ getDatabase: () => mocks.db }))

import { GET, PUT } from "./route"
import { invalidatePoolModelConfigCache } from "@/server/pool-model-config"

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_normalized TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'USER')),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pool_model_config (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pool_type TEXT NOT NULL,
      model TEXT NOT NULL,
      fast_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, pool_type, model)
    );
  `)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockReturnValue({ id: "cfg-owner" })
  mocks.db = createTestDb()
  const timestamp = new Date().toISOString()
  const insertUser = (mocks.db as Database.Database).prepare(
    "INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)",
  )
  insertUser.run("cfg-owner", "cfg-owner", "cfg-owner", "Cfg Owner", "USER", "hash", timestamp, timestamp)
  insertUser.run("cfg-other", "cfg-other", "cfg-other", "Cfg Other", "USER", "hash", timestamp, timestamp)
  invalidatePoolModelConfigCache()
})

function put(body: unknown, owner = "cfg-owner"): Promise<Response> {
  mocks.requireSession.mockReturnValue({ id: owner })
  return PUT(new Request("http://x/api/admin/pool-model-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
}

describe("PUT /api/admin/pool-model-config", () => {
  it("未登录（requireSession 401）→ 原样返回 401", async () => {
    mocks.requireSession.mockReturnValue(new Response("unauthorized", { status: 401 }))
    const response = await PUT(new Request("http://x/api/admin/pool-model-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: true }),
    }))
    expect(response.status).toBe(401)
  })

  it("写入成功：返回 config；再次 GET 可读到", async () => {
    const created = await put({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: true })
    expect(created.status).toBe(200)
    const payload = await created.json() as { config: { fastEnabled: boolean; model: string } }
    expect(payload.config).toMatchObject({ model: "gpt-5.6-sol", fastEnabled: true, poolType: "openai" })

    const listed = await GET(new Request("http://x/api/admin/pool-model-config?poolType=openai")) 
    const data = await listed.json() as { configs: Array<{ model: string; fastEnabled: boolean }> }
    expect(data.configs).toHaveLength(1)
    expect(data.configs[0]).toMatchObject({ model: "gpt-5.6-sol", fastEnabled: true })
  })

  it("重复 PUT 同一模型：UPSERT 更新，不产生重复行", async () => {
    await put({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: true })
    await put({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: false })
    const listed = await GET(new Request("http://x/api/admin/pool-model-config?poolType=openai"))
    const data = await listed.json() as { configs: Array<{ fastEnabled: boolean }> }
    expect(data.configs).toHaveLength(1)
    expect(data.configs[0].fastEnabled).toBe(false)
  })

  it("body 缺字段 / fastEnabled 非布尔 → 400（禁 401）", async () => {
    const missing = await put({ poolType: "openai", model: "gpt-5.6-sol" })
    expect(missing.status).toBe(400)
    const badType = await put({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: "yes" })
    expect(badType.status).toBe(400)
    const malformed = await PUT(new Request("http://x/api/admin/pool-model-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }))
    expect(malformed.status).toBe(400)
  })

  it("非 openai 池 → 422 业务校验失败（禁 401）", async () => {
    const response = await put({ poolType: "kimi-code", model: "kimi-k2", fastEnabled: true })
    expect(response.status).toBe(422)
  })

  it("owner 隔离：A 写入的配置对 B 不可见", async () => {
    await put({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: true }, "cfg-owner")
    const listed = await GET(new Request("http://x/api/admin/pool-model-config?poolType=openai"))
    const data = await listed.json() as { configs: unknown[] }
    expect(data.configs).toHaveLength(1)

    mocks.requireSession.mockReturnValue({ id: "cfg-other" })
    const otherList = await GET(new Request("http://x/api/admin/pool-model-config?poolType=openai"))
    const otherData = await otherList.json() as { configs: unknown[] }
    expect(otherData.configs).toHaveLength(0)
  })

  it("写后失效 TTL 缓存：PUT 后 isPoolModelFastEnabled 立即读到新值（无需等 TTL）", async () => {
    expect((await import("@/server/pool-model-config")).isPoolModelFastEnabled("cfg-owner", "gpt-5.6-sol")).toBe(false)
    await put({ poolType: "openai", model: "gpt-5.6-sol", fastEnabled: true })
    expect((await import("@/server/pool-model-config")).isPoolModelFastEnabled("cfg-owner", "gpt-5.6-sol")).toBe(true)
  })
})

describe("GET /api/admin/pool-model-config", () => {
  it("未登录（requireSession 401）→ 原样返回 401", async () => {
    mocks.requireSession.mockReturnValue(new Response("unauthorized", { status: 401 }))
    const response = await GET(new Request("http://x/api/admin/pool-model-config"))
    expect(response.status).toBe(401)
  })

  it("未知 poolType 查询参数 → 422", async () => {
    const response = await GET(new Request("http://x/api/admin/pool-model-config?poolType=xai-grok"))
    expect(response.status).toBe(422)
  })

  it("非法 poolType 参数（超长）→ 400", async () => {
    const response = await GET(new Request(`http://x/api/admin/pool-model-config?poolType=${"x".repeat(60)}`))
    expect(response.status).toBe(400)
  })
})
