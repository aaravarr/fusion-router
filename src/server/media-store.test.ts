import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDatabase, type AppDatabase } from "@/server/db"
import { clearBootstrapCacheForTests, ensureMasterKey } from "@/server/bootstrap"
import { initializeSystemSettings } from "@/server/settings"
import {
  parseDataUri,
  storeDataUri,
  buildSignedMediaPath,
  verifySignedMediaPath,
  readMedia,
  cleanupMedia,
  mediaPath,
} from "./media-store"

let db: AppDatabase
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-media-"))
  process.env.DATA_DIR = directory
  clearBootstrapCacheForTests()
  ensureMasterKey()
  db = createDatabase(":memory:")
  initializeSystemSettings(db)
})

afterEach(() => {
  db.close()
  clearBootstrapCacheForTests()
  delete process.env.DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

const PNG_1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("parseDataUri", () => {
  it("解析 mime 与 base64", () => {
    const parsed = parseDataUri(PNG_1)
    expect(parsed).not.toBeNull()
    expect(parsed!.mime).toBe("image/png")
    expect(parsed!.base64.length).toBeGreaterThan(10)
  })

  it("非 data URI 返回 null", () => {
    expect(parseDataUri("https://x.com/a.png")).toBeNull()
    expect(parseDataUri("not-a-uri")).toBeNull()
  })
})

describe("storeDataUri", () => {
  it("存储并返回 md5 与签名 URL 路径", () => {
    const stored = storeDataUri(PNG_1, db)
    expect(stored.md5).toMatch(/^[0-9a-f]{32}$/)
    expect(stored.mime).toBe("image/png")
    expect(stored.urlPath).toMatch(/^\/mcp\/media\/[0-9a-f]{32}\?exp=\d+&sig=[0-9a-f]{32}$/)
    expect(existsSync(mediaPath(stored.md5))).toBe(true)
  })

  it("相同 data URI 去重：不重复落盘，use_count 递增", () => {
    const first = storeDataUri(PNG_1, db)
    const second = storeDataUri(PNG_1, db)
    expect(second.md5).toBe(first.md5)
    const row = db.prepare("SELECT use_count FROM media_cache WHERE md5 = ?").get(first.md5) as { use_count: number }
    expect(row.use_count).toBe(2)
  })
})

describe("signed path", () => {
  it("生成的签名路径可校验通过", () => {
    const stored = storeDataUri(PNG_1, db)
    const url = new URL(`http://localhost${stored.urlPath}`)
    const md5 = stored.md5
    const exp = url.searchParams.get("exp")
    const sig = url.searchParams.get("sig")
    expect(verifySignedMediaPath(md5, exp, sig)).toBe(true)
  })

  it("篡改签名校验失败", () => {
    const stored = storeDataUri(PNG_1, db)
    const url = new URL(`http://localhost${stored.urlPath}`)
    expect(verifySignedMediaPath(stored.md5, url.searchParams.get("exp"), "deadbeef")).toBe(false)
  })

  it("过期签名校验失败", () => {
    const stored = storeDataUri(PNG_1, db)
    const url = new URL(`http://localhost${stored.urlPath}`)
    const pastExp = String(Math.floor(Date.now() / 1000) - 100)
    expect(verifySignedMediaPath(stored.md5, pastExp, url.searchParams.get("sig"))).toBe(false)
  })

  it("同一图片多次写入返回固定签名路径（保持提示词缓存前缀稳定）", () => {
    const first = storeDataUri(PNG_1, db)
    const second = storeDataUri(PNG_1, db)
    expect(second.urlPath).toBe(first.urlPath)
    // 数据库里持久化了同一个签名路径，后续请求复用
    const row = db.prepare("SELECT signed_path FROM media_cache WHERE md5 = ?").get(first.md5) as { signed_path: string }
    expect(row.signed_path).toBe(first.urlPath)
  })
})

describe("readMedia", () => {
  it("读取存储的图片字节", () => {
    const stored = storeDataUri(PNG_1, db)
    const media = readMedia(stored.md5, db)
    expect(media).not.toBeNull()
    expect(media!.mime).toBe("image/png")
    expect(media!.buffer.length).toBeGreaterThan(0)
  })

  it("未知 md5 返回 null", () => {
    expect(readMedia("0".repeat(32), db)).toBeNull()
  })
})

describe("cleanupMedia", () => {
  it("清理过期媒体", () => {
    storeDataUri(PNG_1, db)
    // 手动把 last_used_at 改到很久以前
    db.prepare("UPDATE media_cache SET last_used_at = '2020-01-01T00:00:00.000Z'").run()
    const result = cleanupMedia(db, new Date("2026-01-01T00:00:00.000Z"))
    expect(result.expiredRemoved).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM media_cache").get() as { n: number }).n).toBe(0)
    expect(existsSync(mediaPath("0"))).toBe(false)
  })

  it("超过容量上限时按最旧清理", () => {
    // 容量设 1.5MB（两个图片加起来超限），TTL 设很大避免过期清理干扰
    db.prepare("UPDATE system_settings SET value_json = '1048576' WHERE key = 'media_max_bytes'").run()
    db.prepare("UPDATE system_settings SET value_json = '8760' WHERE key = 'media_ttl_hours'").run()
    const a = storeDataUri("data:image/png;base64," + "A".repeat(800_000), db)
    const b = storeDataUri("data:image/png;base64," + "B".repeat(800_000), db)
    // 设 a 更旧（先被清）
    db.prepare("UPDATE media_cache SET last_used_at = '2026-01-01T00:00:00.000Z' WHERE md5 = ?").run(a.md5)
    const result = cleanupMedia(db, new Date("2026-06-01T00:00:00.000Z"))
    expect(result.overCapacityRemoved).toBe(1)
    // 更旧的 a 被清，b 保留
    expect(existsSync(mediaPath(a.md5))).toBe(false)
    expect(existsSync(mediaPath(b.md5))).toBe(true)
  })
})
