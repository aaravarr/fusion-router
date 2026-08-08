import { beforeEach, describe, expect, it } from "vitest"
import { SecretVault } from "./crypto"
import { createDatabase } from "./db"
import { AccountRepository, listDueUsageCandidates } from "./repository"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")
const usage = { FIVE_HOUR: { usagePercent: 1, resetInSeconds: 100 }, WEEKLY: { usagePercent: 2, resetInSeconds: 200 }, MONTHLY: { usagePercent: 3, resetInSeconds: 300 } }

describe("usage maintenance candidates", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("只检查最近十分钟实际承载过请求的账号，current/preferred 不会让闲置账号被轮询", () => {
    const db = createDatabase(":memory:"); const now = new Date("2026-07-21T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const add = (suffix: string) => repository.upsertBrowserAccount({ workspaceId: `wrk_${suffix}`, authCookie: `cookie-${suffix}`, goApiKey: `sk-${suffix}`, goKeyId: `key_${suffix}`, subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage }).id
    const recent = add("recent"); const idle = add("idle")
    db.prepare("UPDATE accounts SET next_usage_check_at=?,last_request_at=? WHERE id=?").run(new Date(now.getTime() - 1_000).toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), recent)
    db.prepare("UPDATE accounts SET next_usage_check_at=?,last_request_at=? WHERE id=?").run(new Date(now.getTime() - 1_000).toISOString(), new Date(now.getTime() - 60 * 60_000).toISOString(), idle)
    db.prepare("INSERT INTO routing_state(owner_user_id,preferred_account_id,current_account_id,updated_at) VALUES(?,?,?,?)").run("owner", idle, idle, now.toISOString())
    expect(listDueUsageCandidates(db, now)).toEqual([{ ownerUserId: "owner", accountId: recent, poolType: "opencode-go" }])
  })

  it("xAI 账号不进入自动额度探测队列", () => {
    const db = createDatabase(":memory:"); const now = new Date("2026-07-21T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const go = repository.upsertBrowserAccount({ workspaceId: "wrk_go", authCookie: "cookie-go", goApiKey: "sk-go", goKeyId: "key_go", subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage }).id
    const xai = repository.createProviderAccount({ name: "xai", poolType: "xai-grok", externalId: "xai-1" }).id
    db.prepare("UPDATE accounts SET next_usage_check_at=?,last_request_at=? WHERE id=?").run(new Date(now.getTime() - 1_000).toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), go)
    db.prepare("UPDATE accounts SET next_usage_check_at=?,last_request_at=? WHERE id=?").run(new Date(now.getTime() - 1_000).toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), xai)
    expect(listDueUsageCandidates(db, now)).toEqual([{ ownerUserId: "owner", accountId: go, poolType: "opencode-go" }])
  })

  it("重新导入不会恢复已被 xAI 永久封禁的账号", () => {
    const db = createDatabase(":memory:"); const now = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now, now)
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const account = repository.createProviderAccount({ name: "grok", poolType: "xai-grok", externalId: "same" })
    repository.updateState(account.id, { adminState: "DISABLED", authState: "AUTH_ERROR", disabledReason: "XAI_ACCOUNT_BANNED", disabledAt: now })
    const reimported = repository.createProviderAccount({ name: "grok updated", poolType: "xai-grok", externalId: "same" })
    expect(reimported).toMatchObject({ id: account.id, name: "grok updated", adminState: "DISABLED", authState: "AUTH_ERROR", disabledReason: "XAI_ACCOUNT_BANNED" })
  })
})

describe("account list pagination", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("supports pool/status filters, stats and paging", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T08:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const ready = repository.createProviderAccount({ name: "ready-xai", poolType: "xai-grok", externalId: "x1", email: "ready@example.com" })
    const over = repository.createProviderAccount({ name: "over-xai", poolType: "xai-grok", externalId: "x2", email: "over@example.com" })
    const banned = repository.createProviderAccount({ name: "banned-xai", poolType: "xai-grok", externalId: "x3", email: "banned@example.com" })
    const go = repository.upsertBrowserAccount({ workspaceId: "wrk_go", authCookie: "cookie", goApiKey: "sk", goKeyId: "key", subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage })

    repository.updateState(banned.id, { adminState: "DISABLED", disabledReason: "XAI_ACCOUNT_BANNED", disabledAt: now.toISOString() })
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,?,?,NULL,'LOCAL_USAGE',?,?,?)`).run("owner", over.id, "ROLLING_24H", 126.5, now.toISOString(), 1_000_000, -265_000)
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,?,?,NULL,'LOCAL_USAGE',?,?,?)`).run("owner", ready.id, "ROLLING_24H", 12.25, now.toISOString(), 1_000_000, 877_500)

    const all = repository.listPage({ page: 1, pageSize: 2, poolType: "xai-grok", sort: "usage" })
    expect(all.total).toBe(3)
    expect(all.items).toHaveLength(2)
    expect(all.items.map((item) => item.id)).toEqual([ready.id, over.id])
    expect(all.stats).toMatchObject({ total: 3, overQuota: 1, banned: 1, ready: 1 })
    expect(all.stats.avgUsagePercent).toBeCloseTo((126.5 + 12.25) / 2, 2)
    // Chip counts should still include non-selected pools.
    expect(all.stats.byPoolType["xai-grok"]?.total).toBe(3)
    expect(all.stats.byPoolType["opencode-go"]?.total).toBe(1)

    const blocked = repository.listPage({ page: 1, pageSize: 50, poolType: "xai-grok", status: "temp_blocked" })
    expect(blocked.total).toBe(1)
    expect(blocked.items.map((item) => item.id)).toEqual([over.id])

    const searched = repository.listPage({ page: 1, pageSize: 50, q: "ready@" })
    expect(searched.total).toBe(1)
    expect(searched.items[0].id).toBe(ready.id)
    expect(searched.stats.byPoolType["xai-grok"]?.total).toBe(1)
    expect(go.id).toBeTruthy()
  })

  it("excludePoolTypes 同时从列表和 stats 中排除（禁用内置 provider 场景）", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T08:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    repository.createProviderAccount({ name: "xai", poolType: "xai-grok", externalId: "x1" })
    repository.createProviderAccount({ name: "openai", poolType: "openai", externalId: "o1" })

    const filtered = repository.listPage({ page: 1, pageSize: 50, excludePoolTypes: ["xai-grok"] })
    expect(filtered.total).toBe(1)
    expect(filtered.items.map((item) => item.poolType)).toEqual(["openai"])
    expect(filtered.stats.total).toBe(1)
    expect(filtered.stats.byPoolType["xai-grok"]).toBeUndefined()
    expect(filtered.stats.byPoolType["openai"]?.total).toBe(1)
  })
})

describe("bulk account operations", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("updates and deletes only owned accounts while skipping banned account enablement", () => {
    const db = createDatabase(":memory:")
    const now = new Date().toISOString()
    for (const id of ["owner", "other"]) {
      db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
        .run(id, id, id, id, "USER", "hash", now, now)
    }
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const ready = repository.createProviderAccount({ name: "ready", poolType: "xai-grok", externalId: "ready" })
    const banned = repository.createProviderAccount({ name: "banned", poolType: "xai-grok", externalId: "banned" })
    const other = new AccountRepository("other", db, new SecretVault(encryptionKey))
      .createProviderAccount({ name: "other", poolType: "xai-grok", externalId: "other" })
    repository.updateState(banned.id, { adminState: "DISABLED", disabledReason: "XAI_ACCOUNT_BANNED" })

    expect(repository.bulkSetAdminState([ready.id, ready.id, banned.id, other.id, "missing"], "ENABLED"))
      .toEqual({ updated: 0, unchanged: 1, skippedBanned: 1, skippedCredentialInvalid: 0, skippedSpendingBlocked: 0, notFound: 2 })
    expect(db.prepare("SELECT COUNT(*) AS value FROM events WHERE owner_user_id=? AND account_id=?").get("owner", ready.id)).toEqual({ value: 0 })
    expect(repository.bulkSetAdminState([ready.id, banned.id], "DISABLED"))
      .toEqual({ updated: 2, unchanged: 0, skippedBanned: 0, skippedCredentialInvalid: 0, skippedSpendingBlocked: 0, notFound: 0 })
    expect(repository.get(ready.id)?.adminState).toBe("DISABLED")
    expect(repository.get(ready.id)?.disabledReason).toBe("ADMIN_DISABLED")
    expect(db.prepare("SELECT type,metadata_json FROM events WHERE owner_user_id=? AND account_id=? ORDER BY rowid DESC LIMIT 1").get("owner", ready.id))
      .toMatchObject({ type: "ACCOUNT_ADMIN_DISABLED" })
    expect(repository.bulkDelete([ready.id, other.id, "missing"])).toEqual({ deleted: 1, notFound: 2 })
    expect(repository.get(ready.id)).toBeNull()
    expect(new AccountRepository("other", db, new SecretVault(encryptionKey)).get(other.id)).not.toBeNull()
    expect(db.prepare("SELECT COUNT(*) AS value FROM events WHERE owner_user_id='owner' AND account_id=?").get(other.id)).toEqual({ value: 0 })
  })

  it("requires reauthentication for invalid credentials and explicit confirmation for spending blocks", () => {
    const db = createDatabase(":memory:")
    const now = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now, now)
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const credential = repository.createProviderAccount({ name: "credential", poolType: "xai-grok", externalId: "credential" })
    const spending = repository.createProviderAccount({ name: "spending", poolType: "xai-grok", externalId: "spending" })
    repository.updateState(credential.id, { adminState: "DISABLED", authState: "REAUTH_REQUIRED", disabledReason: "CREDENTIAL_INVALID" })
    repository.updateState(spending.id, { adminState: "DISABLED", disabledReason: "SPENDING_BLOCKED" })

    expect(repository.bulkSetAdminState([credential.id, spending.id], "ENABLED"))
      .toEqual({ updated: 0, unchanged: 0, skippedBanned: 0, skippedCredentialInvalid: 1, skippedSpendingBlocked: 1, notFound: 0 })
    expect(repository.bulkSetAdminState([spending.id], "ENABLED", { confirmSpendingBlocked: true, reason: "额度已恢复" }).updated).toBe(1)
    expect(repository.get(spending.id)).toMatchObject({ adminState: "ENABLED", disabledReason: null, disabledAt: null })
    const event = db.prepare("SELECT type,metadata_json FROM events WHERE owner_user_id=? AND account_id=? ORDER BY rowid DESC LIMIT 1").get("owner", spending.id) as { type: string; metadata_json: string }
    expect(event.type).toBe("ACCOUNT_ADMIN_ENABLED")
    expect(JSON.parse(event.metadata_json)).toMatchObject({ reason: "额度已恢复", previousDisabledReason: "SPENDING_BLOCKED" })
  })
})
