import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createDatabase } from "./db"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

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
