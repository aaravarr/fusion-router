import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createDatabase } from "./db"
import { migrateLegacyMirrorAndUpstream } from "./migration"

const directories: string[] = []
afterEach(() => { delete process.env.DATA_DIR; for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe("database schema", () => {
  it("包含异步导入与真实额度字段", () => {
    const db = createDatabase(":memory:")
    const quotaColumns = (db.prepare("PRAGMA table_info(quota_windows)").all() as { name: string }[]).map((column) => column.name)
    expect(quotaColumns).toEqual(expect.arrayContaining(["limit_value", "remaining_value", "unit"]))
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_jobs'").get()).toEqual({ name: "import_jobs" })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_job_items'").get()).toEqual({ name: "import_job_items" })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_model_cache'").get()).toEqual({ name: "provider_model_cache" })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_providers'").get()).toEqual({ name: "custom_providers" })
    db.close()
  })

  it("包含共享池与镜像组新表，且删除用户级联清理共享明细", () => {
    const db = createDatabase(":memory:")
    const userCols = (db.prepare("PRAGMA table_info(users)").all() as { name: string; dflt_value: string | null }[]).map((column) => column.name)
    expect(userCols).toContain("share_admin_pool_enabled")
    const sharedCol = (db.prepare("PRAGMA table_info(users)").all() as { name: string; dflt_value: string | null }[]).find((column) => column.name === "share_admin_pool_enabled")
    expect(sharedCol?.dflt_value).toBe("0")
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_shared_pools'").get()).toEqual({ name: "user_shared_pools" })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_mirror_groups'").get()).toEqual({ name: "user_mirror_groups" })

    const now = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("u1", "u", "u", "U", "USER", "ACTIVE", "h", now, now)
    db.prepare("INSERT INTO user_shared_pools(user_id,pool_type,created_at,updated_at) VALUES(?,?,?,?)").run("u1", "xai-grok", now, now)
    db.prepare("DELETE FROM users WHERE id='u1'").run()
    expect(db.prepare("SELECT COUNT(*) AS c FROM user_shared_pools").get()).toEqual({ c: 0 })
    db.close()
  })

  it("迁移全局镜像组与上游地址到首个 ADMIN 并清理旧键", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-db-migrate-")); directories.push(directory)
    process.env.DATA_DIR = directory
    const filename = join(directory, "migrate.db")
    const seed = new Database(filename)
    seed.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL,username_normalized TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO users VALUES('admin-1','admin','admin','Admin','ADMIN','ACTIVE','hash','2024-01-01','2024-01-01');
      CREATE TABLE system_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,is_secret INTEGER NOT NULL DEFAULT 0,updated_by_user_id TEXT,updated_at TEXT NOT NULL);
      INSERT INTO system_settings VALUES('domain_mirror_groups','[{"id":"g1","name":"G1","enabled":true,"domains":["api.x.ai"],"accountIds":[],"mirrors":[{"id":"m1","name":"M1","url":"https://m.example.com/$host","enabled":true}],"rules":[]}]',0,NULL,'2024-01-01');
      INSERT INTO system_settings VALUES('domain_mirror_map','{"api.openai.com":"https://legacy.example.com/"}',0,NULL,'2024-01-01');
      INSERT INTO system_settings VALUES('opencode_upstream_base_url','"https://gateway.opencode.ai/api/"',0,NULL,'2024-01-01');
    `)
    seed.close()

    const db = createDatabase(filename)
    const rows = db.prepare("SELECT owner_user_id, id FROM user_mirror_groups ORDER BY id").all() as Array<{ owner_user_id: string; id: string }>
    expect(rows.every((row) => row.owner_user_id === "admin-1")).toBe(true)
    const ids = rows.map((row) => row.id)
    expect(ids).toContain("g1")
    expect(ids).toContain("legacy_group_api_openai_com")
    expect(ids).toContain("legacy_upstream_group")

    const upstream = db.prepare("SELECT mirrors_json FROM user_mirror_groups WHERE id='legacy_upstream_group'").get() as { mirrors_json: string }
    expect(JSON.parse(upstream.mirrors_json)[0].url).toBe("https://gateway.opencode.ai")

    expect(db.prepare("SELECT COUNT(*) AS c FROM system_settings WHERE key IN ('domain_mirror_groups','domain_mirror_map','opencode_upstream_base_url')").get()).toEqual({ c: 0 })

    // 幂等：再次迁移不重复
    migrateLegacyMirrorAndUpstream(db)
    expect((db.prepare("SELECT COUNT(*) AS c FROM user_mirror_groups").get() as { c: number }).c).toBe(rows.length)
    db.close()
  })

  it("检测到旧账号表时只清理账号域并保留用户、API key 和系统设置", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-db-")); directories.push(directory)
    const filename = join(directory, "legacy.db"); const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL,username_normalized TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO users VALUES('user-1','owner','owner','Owner','USER','ACTIVE','hash','now','now');
      CREATE TABLE api_keys(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,name TEXT NOT NULL,key_prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL,allowed_models_json TEXT,expires_at TEXT,last_used_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO api_keys VALUES('api-1','user-1','key','ocg_test','hash',1,NULL,NULL,NULL,'now','now');
      CREATE TABLE system_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,is_secret INTEGER NOT NULL,updated_by_user_id TEXT,updated_at TEXT NOT NULL);
      INSERT INTO system_settings VALUES('kept','true',0,NULL,'now');
      CREATE TABLE accounts(id TEXT PRIMARY KEY, owner_user_id TEXT, access_token_ciphertext TEXT);
      INSERT INTO accounts VALUES('legacy-account','user-1','ciphertext');
      CREATE TABLE quota_windows(account_id TEXT);
      INSERT INTO quota_windows VALUES('legacy-account');
      CREATE TABLE oauth_attempts(id TEXT);
      INSERT INTO oauth_attempts VALUES('attempt-1');
    `)
    legacy.close()

    const db = createDatabase(filename)
    expect((db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((column) => column.name)).toContain("auth_cookie_ciphertext")
    expect(db.prepare("SELECT COUNT(*) value FROM accounts").get()).toEqual({ value: 0 })
    expect(db.prepare("SELECT username FROM users WHERE id='user-1'").get()).toEqual({ username: "owner" })
    expect(db.prepare("SELECT id FROM api_keys WHERE id='api-1'").get()).toEqual({ id: "api-1" })
    expect(db.prepare("SELECT key FROM system_settings WHERE key='kept'").get()).toEqual({ key: "kept" })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_attempts'").get()).toBeUndefined()
    db.close()
  })
})
