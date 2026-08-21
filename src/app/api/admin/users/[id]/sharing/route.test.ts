import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppDatabase } from "@/server/db"

const mocks = vi.hoisted(() => ({
  requireAdministrator: vi.fn(() => ({ id: "admin-actor" })),
  db: null as unknown as AppDatabase,
}))

vi.mock("../../../_auth", () => ({ requireAdministrator: mocks.requireAdministrator }))
vi.mock("@/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/server/db")>("@/server/db")
  return { ...actual, getDatabase: () => mocks.db }
})

import { createDatabase } from "@/server/db"
import { PATCH } from "./route"

function insertUser(db: AppDatabase, id: string, role: string) {
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, id, id, id, role, "ACTIVE", "h", new Date().toISOString(), new Date().toISOString())
}

describe("/api/admin/users/:id/sharing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAdministrator.mockReturnValue({ id: "admin-actor" })
    mocks.db = createDatabase(":memory:")
    insertUser(mocks.db, "target-user", "USER")
  })

  function patch(id: string, body: unknown): Request {
    return new Request(`http://x/api/admin/users/${id}/sharing`, { method: "PATCH", body: JSON.stringify(body) })
  }

  it("PATCH 配置共享池并落库", async () => {
    const response = await PATCH(patch("target-user", { enabled: true, poolTypes: ["xai-grok", "custom:*"] }), { params: Promise.resolve({ id: "target-user" }) })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { sharing: { enabled: boolean; poolTypes: string[] } }
    expect(payload.sharing.enabled).toBe(true)
    expect(payload.sharing.poolTypes).toEqual(["xai-grok", "custom:*"])
    const row = mocks.db.prepare("SELECT share_admin_pool_enabled FROM users WHERE id='target-user'").get() as { share_admin_pool_enabled: number }
    expect(row.share_admin_pool_enabled).toBe(1)
    const rows = mocks.db.prepare("SELECT pool_type FROM user_shared_pools WHERE user_id='target-user' ORDER BY pool_type").all() as Array<{ pool_type: string }>
    expect(rows.map((r) => r.pool_type)).toEqual(["custom:*", "xai-grok"])
  })

  it("enabled=false 时忽略 poolTypes 并清空明细", async () => {
    await PATCH(patch("target-user", { enabled: true, poolTypes: ["xai-grok"] }), { params: Promise.resolve({ id: "target-user" }) })
    const response = await PATCH(patch("target-user", { enabled: false, poolTypes: ["xai-grok"] }), { params: Promise.resolve({ id: "target-user" }) })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { sharing: { enabled: boolean; poolTypes: string[] } }
    expect(payload.sharing.enabled).toBe(false)
    expect(payload.sharing.poolTypes).toEqual([])
    expect((mocks.db.prepare("SELECT COUNT(*) AS c FROM user_shared_pools WHERE user_id='target-user'").get() as { c: number }).c).toBe(0)
  })

  it("非法 poolType 返回 400（非 401）", async () => {
    const response = await PATCH(patch("target-user", { enabled: true, poolTypes: ["nope"] }), { params: Promise.resolve({ id: "target-user" }) })
    expect(response.status).toBe(400)
  })

  it("用户不存在返回 404", async () => {
    const response = await PATCH(patch("missing-user", { enabled: true }), { params: Promise.resolve({ id: "missing-user" }) })
    expect(response.status).toBe(404)
  })
})
