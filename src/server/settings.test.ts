import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearBootstrapCacheForTests, ensureMasterKey } from "./bootstrap"
import { requireCronBearer } from "./opencode/route-auth"
import {
  getSystemSecret,
  getSystemSettings,
  initializeSystemSettings,
  rotateApiKeyPepper,
  rotateSystemSecret,
  SYSTEM_SECRET_KEYS,
  updateSystemSettings,
  normalizeDomainMirrorMap,
} from "./settings"

let directory: string
let db: Database.Database

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-settings-"))
  process.env.DATA_DIR = directory
  clearBootstrapCacheForTests()
  ensureMasterKey()
  db = new Database(":memory:")
  db.exec(`CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 0,
    updated_by_user_id TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`)
  initializeSystemSettings(db)
})

afterEach(() => {
  db.close()
  clearBootstrapCacheForTests()
  delete process.env.DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

describe("system settings", () => {
  it("migrates a legacy single mirror into a multi-mirror configuration", () => {
    expect(normalizeDomainMirrorMap({ "api.example.com": "https://mirror.example.com/" })).toEqual({
      "api.example.com": {
        mirrors: [{ id: "legacy", name: "默认镜像", url: "https://mirror.example.com", enabled: true }],
        accountAssignments: {},
        rules: [],
      },
    })
  })
  it("initializes safe defaults and validates administrator updates", () => {
    expect(getSystemSettings(db)).toMatchObject({
      upstreamBaseUrl: "https://opencode.ai/zen/go/v1",
      upstreamRequestTimeoutMs: 120_000,
    })

    const updated = updateSystemSettings({
      upstreamBaseUrl: "https://gateway.opencode.ai/api/",
      upstreamRequestTimeoutMs: 30_000,
    }, null, db)
    expect(updated.upstreamBaseUrl).toBe("https://gateway.opencode.ai/api")
    expect(updated.upstreamRequestTimeoutMs).toBe(30_000)
    expect(() => updateSystemSettings({ upstreamRequestTimeoutMs: 10 }, null, db)).toThrow(/between/)
    expect(() => updateSystemSettings({ upstreamBaseUrl: "https://user:secret@opencode.ai/v1" }, null, db)).toThrow(/embedded credentials/)
    expect(() => updateSystemSettings({ upstreamBaseUrl: "https://evil-opencode.ai/v1" }, null, db)).toThrow(/official HTTPS/)
  })

  it("stores account-scoped mirror groups with multiple targets and rules", () => {
    const group = {
      id: "xai-group", name: "XAI", enabled: true,
      domains: ["api.x.ai", "accounts.x.ai"], accountIds: ["account-a", "account-b"],
      mirrors: [
        { id: "primary", name: "Primary", url: "https://mirror.example.com/$host", enabled: true },
        { id: "backup", name: "Backup", url: "https://backup.example.com/$host", enabled: true },
      ],
      rules: [{ id: "prod", pattern: "^account-a$", mirrorId: "primary", enabled: true }],
    }
    expect(updateSystemSettings({ domainMirrorGroups: [group] }, null, db).domainMirrorGroups).toEqual([group])
    expect(() => updateSystemSettings({ domainMirrorGroups: [{ ...group, rules: [{ ...group.rules[0], mirrorId: "missing" }] }] }, null, db)).toThrow(/不存在的镜像/)
  })

  it("stores random secrets encrypted and supports explicit rotation", () => {
    const row = db
      .prepare("SELECT value_json FROM system_settings WHERE key = ?")
      .get(SYSTEM_SECRET_KEYS.cronSecret) as { value_json: string }
    const before = getSystemSecret(db, SYSTEM_SECRET_KEYS.cronSecret)
    expect(row.value_json).not.toContain(before)

    const rotated = rotateSystemSecret(db, SYSTEM_SECRET_KEYS.cronSecret)
    expect(rotated).not.toBe(before)
    expect(getSystemSecret(db, SYSTEM_SECRET_KEYS.cronSecret)).toBe(rotated)
  })

  it("rotates API key pepper and disables every active key in one operation", () => {
    db.prepare("INSERT INTO api_keys(id, enabled, updated_at) VALUES ('a', 1, 'before'), ('b', 1, 'before'), ('c', 0, 'before')").run()
    const before = getSystemSecret(db, SYSTEM_SECRET_KEYS.apiKeyPepper)

    const invalidated = rotateApiKeyPepper(null, db)

    expect(invalidated).toBe(2)
    expect(getSystemSecret(db, SYSTEM_SECRET_KEYS.apiKeyPepper)).not.toBe(before)
    expect(db.prepare("SELECT COUNT(*) value FROM api_keys WHERE enabled = 1").get()).toEqual({ value: 0 })
  })

  it("authenticates maintenance calls with the encrypted database secret", () => {
    const secret = getSystemSecret(db, SYSTEM_SECRET_KEYS.cronSecret)
    expect(
      requireCronBearer(new Request("http://localhost", { headers: { Authorization: `Bearer ${secret}` } }), db),
    ).toBeNull()
    expect(requireCronBearer(new Request("http://localhost"), db)?.status).toBe(401)
  })
})
