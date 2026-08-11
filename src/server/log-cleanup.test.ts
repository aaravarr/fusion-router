import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import { clearBootstrapCacheForTests, ensureMasterKey } from "@/server/bootstrap"
import { cutoffForRetention, deleteOldRequestsBatch, stripAllBodies } from "./log-cleanup"

let db: AppDatabase

beforeEach(() => {
  clearBootstrapCacheForTests()
  ensureMasterKey()
  db = createDatabase(":memory:")
  db.prepare(
    "INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run("u1", "admin", "admin", "Admin", "ADMIN", "ACTIVE", "x", new Date().toISOString(), new Date().toISOString())
})

afterEach(() => {
  db.close()
  clearBootstrapCacheForTests()
})

function insertRequest(id: string, startedAt: string): void {
  db.prepare(
    "INSERT INTO gateway_requests(id, owner_user_id, endpoint, model, status, outcome, attempt_count, started_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, "u1", "responses", "deepseek-v4-flash", 200, "SUCCESS", 1, startedAt)
  db.prepare(
    "INSERT INTO request_bodies(request_id, request_body_json, body_bytes, created_at) VALUES(?,?,?,?)",
  ).run(id, "{}", 2, startedAt)
}

describe("cutoffForRetention", () => {
  it("生成可直接与 started_at 字典序比较的 ISO 时间", () => {
    const cutoff = cutoffForRetention(7)
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(cutoff > "2020-01-01T00:00:00.000Z").toBe(true)
  })
})

describe("deleteOldRequestsBatch", () => {
  it("只删除过期请求及其 body，保留新请求", () => {
    insertRequest("old", "2026-01-01T00:00:00.000Z")
    insertRequest("new", new Date().toISOString())
    const result = deleteOldRequestsBatch(db, cutoffForRetention(7))
    expect(result.deletedRequests).toBe(1)
    expect(result.deletedBodies).toBe(1)
    expect((db.prepare("SELECT COUNT(*) n FROM gateway_requests").get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT COUNT(*) n FROM request_bodies").get() as { n: number }).n).toBe(1)
  })

  it("受 LIMIT 控制每批删除数量", () => {
    for (let i = 0; i < 5; i++) insertRequest("old" + i, "2026-01-01T00:00:00.000Z")
    const result = deleteOldRequestsBatch(db, cutoffForRetention(7), 2)
    expect(result.deletedRequests).toBe(2)
    expect(result.deletedBodies).toBe(2)
  })
})

describe("stripAllBodies", () => {
  it("分批清空全部 request_bodies", async () => {
    for (let i = 0; i < 30; i++) insertRequest("r" + i, new Date().toISOString())
    const result = await stripAllBodies(db)
    expect(result.stripped).toBe(30)
    expect((db.prepare("SELECT COUNT(*) n FROM request_bodies").get() as { n: number }).n).toBe(0)
  })
})
