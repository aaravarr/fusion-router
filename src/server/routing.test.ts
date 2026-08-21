import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase, type AppDatabase } from "./db"
import { SecretVault } from "./crypto"
import { AccountRepository, ModelRoutingRepository } from "./repository"
import { NoEligibleAccountError, QueueWaitAbortedError, QueueWaitTimeoutError, RoutingService } from "./routing"
import { setBuiltinProviderEnabled } from "./builtin-provider-state"
import { upsertLocalRollingUsage } from "./quota-usage"
import { CustomProviderRepository, invalidateCustomProviderCache } from "./custom-providers"

const encryptionKey = Buffer.alloc(32, 4).toString("base64")
const ownerUserId = "user-1"
const usage = {
  FIVE_HOUR: { usagePercent: 10, resetInSeconds: 3_600 },
  WEEKLY: { usagePercent: 20, resetInSeconds: 86_400 },
  MONTHLY: { usagePercent: 30, resetInSeconds: 2_592_000 },
}

function make() {
  const db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
  const routing = new RoutingService(ownerUserId, db)
  const add = (suffix: string, safe = true) => accounts.upsertBrowserAccount({
    workspaceId: `wrk_${suffix}`, authCookie: `cookie-${suffix}`, goApiKey: `sk-${suffix}`, goKeyId: `key_${suffix}`,
    subscriptionState: safe ? "ACTIVE" : "INACTIVE", billingGuard: safe ? "VERIFIED_GO_ONLY" : "UNVERIFIED",
    useBalance: safe ? false : null, usage,
  }).id
  return { db, accounts, routing, add }
}

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

describe("routing", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("优先使用手选账号，额度耗尽后自动切到同一用户的下一账号", () => {
    const { routing, add } = make()
    const first = add("one"); const second = add("two")
    routing.setPreferred(first)
    const selected = routing.select("request-1", "responses", new Set())
    expect(selected.account.id).toBe(first)
    routing.releaseLease(selected.leaseId)
    routing.markQuota(first, "FIVE_HOUR", 3_600)
    expect(routing.select("request-2", "responses", new Set()).account.id).toBe(second)
  })

  it("拒绝无订阅、余额回退或未验证账号", () => {
    const { routing, add, accounts } = make()
    add("inactive", false)
    const balance = add("balance")
    accounts.updateState(balance, { billingGuard: "PAYG_FALLBACK_ENABLED", useBalance: true })
    expect(() => routing.select("request", "responses", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("全部账号耗尽时返回最近恢复时间", () => {
    const { routing, add } = make()
    const first = add("one"); const second = add("two")
    routing.markQuota(first, "WEEKLY", 600); routing.markQuota(second, "MONTHLY", 1200)
    try { routing.select("request", "responses", new Set()); throw new Error("expected failure") }
    catch (cause) {
      expect(cause).toBeInstanceOf(NoEligibleAccountError)
      expect((cause as NoEligibleAccountError).reason).toBe("EXHAUSTED")
      expect((cause as NoEligibleAccountError).retryAfterSeconds).toBeGreaterThanOrEqual(600)
    }
  })

  it("禁用内置 provider 后其账号退出调度，重新启用后恢复", () => {
    const { db, routing, add } = make()
    const first = add("one")
    const selected = routing.select("request-1", "responses", new Set())
    expect(selected.account.id).toBe(first)
    routing.releaseLease(selected.leaseId)

    setBuiltinProviderEnabled("opencode-go", false, db)
    expect(() => routing.select("request-2", "responses", new Set())).toThrowError(NoEligibleAccountError)

    // 账号数据保留，重新启用后立即恢复调度
    setBuiltinProviderEnabled("opencode-go", true, db)
    expect(routing.select("request-3", "responses", new Set()).account.id).toBe(first)
  })

  it("永远不路由其他用户的账号", () => {
    const { db, routing, add } = make()
    const own = add("mine")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("user-2", "other", "other", "Other", "USER", "hash", timestamp, timestamp)
    const otherRepo = new AccountRepository("user-2", db, new SecretVault(encryptionKey))
    const other = otherRepo.upsertBrowserAccount({ workspaceId: "wrk_theirs", authCookie: "c", goApiKey: "sk-t", goKeyId: "key_t", subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage })
    expect(routing.select("request", "responses", new Set()).account.id).toBe(own)
    expect(() => routing.select("request-2", "responses", new Set([own]))).toThrowError(NoEligibleAccountError)
    expect(otherRepo.get(other.id)?.ownerUserId).toBe("user-2")
  })

  it("并发上限为零时表示不限制", () => {
    const { routing, add, accounts } = make()
    const accountId = add("unlimited")
    accounts.updateState(accountId, { maxConcurrency: 0 })
    expect(routing.select("unlimited-1", "responses", new Set()).account.id).toBe(accountId)
    expect(routing.select("unlimited-2", "responses", new Set()).account.id).toBe(accountId)
    expect(routing.select("unlimited-3", "responses", new Set()).account.id).toBe(accountId)
  })

  it("请求级号池约束只在指定号池内调度", () => {
    const { accounts, routing, add } = make()
    add("go-seat")
    const xai = accounts.createProviderAccount({ name: "xAI constrained", poolType: "xai-grok", externalId: "xai-constrained" })
    routing.setModel("grok-4.5")
    routing.setRequestConstraint({ poolType: "xai-grok" })
    expect(routing.select("constrained-pool", "responses", new Set()).account.id).toBe(xai.id)
  })

  it("请求级账号约束仍遵守额度封锁", () => {
    const { routing, add } = make()
    const first = add("specific-one")
    add("specific-two")
    routing.setRequestConstraint({ accountId: first })
    expect(routing.select("specific-ready", "responses", new Set()).account.id).toBe(first)
    routing.markQuota(first, "WEEKLY", 600)
    expect(() => routing.select("specific-blocked", "responses", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("文本聊天不会把 xAI 图像模型标记为可路由", () => {
    const { accounts, routing } = make()
    accounts.createProviderAccount({ name: "xAI image seat", poolType: "xai-grok", externalId: "xai-image" })
    routing.setModel("grok-imagine-image")
    expect(() => routing.select("xai-image-on-responses", "responses", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("xAI 滚动号池每次按真实剩余额度重新选择，不被当前账号粘住", () => {
    const { db, accounts, routing } = make()
    const first = accounts.createProviderAccount({ name: "xAI first", poolType: "xai-grok", externalId: "xai-first" })
    const second = accounts.createProviderAccount({ name: "xAI second", poolType: "xai-grok", externalId: "xai-second" })
    const observedAt = new Date().toISOString()
    const writeUsage = db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,'ROLLING_24H',?,?,'UPSTREAM_HEADER',?,1000000,?)
      ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET usage_percent=excluded.usage_percent,
      last_observed_at=excluded.last_observed_at,remaining_value=excluded.remaining_value`)
    writeUsage.run(ownerUserId, first.id, 10, null, observedAt, 900_000)
    writeUsage.run(ownerUserId, second.id, 80, null, observedAt, 200_000)

    const initial = routing.select("xai-request-1", "responses", new Set())
    expect(initial.account.id).toBe(first.id)
    routing.releaseLease(initial.leaseId)

    const later = new Date(Date.now() + 1000).toISOString()
    writeUsage.run(ownerUserId, first.id, 95, null, later, 50_000)
    writeUsage.run(ownerUserId, second.id, 40, null, later, 600_000)
    const rebalanced = routing.select("xai-request-2", "responses", new Set())
    expect(rebalanced.account.id).toBe(second.id)
  })

  it("xAI 手动优先账号仍覆盖用量均衡", () => {
    const { db, accounts, routing } = make()
    const preferred = accounts.createProviderAccount({ name: "preferred", poolType: "xai-grok", externalId: "xai-preferred" })
    const lowerUsage = accounts.createProviderAccount({ name: "lower", poolType: "xai-grok", externalId: "xai-lower" })
    const observedAt = new Date().toISOString()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,'ROLLING_24H',90,NULL,'UPSTREAM_HEADER',?),(?,?,'ROLLING_24H',5,NULL,'UPSTREAM_HEADER',?)`)
      .run(ownerUserId, preferred.id, observedAt, ownerUserId, lowerUsage.id, observedAt)
    routing.setPreferred(preferred.id)
    expect(routing.select("xai-preferred-request", "responses", new Set()).account.id).toBe(preferred.id)
  })

  it("混合号池时在当前 xAI 号池内均衡，不被其他 Provider 的百分比干扰", () => {
    const { db, accounts, routing, add } = make()
    add("go-account")
    const highUsage = accounts.createProviderAccount({ name: "xAI high", poolType: "xai-grok", externalId: "xai-high" })
    const lowUsage = accounts.createProviderAccount({ name: "xAI low", poolType: "xai-grok", externalId: "xai-low" })
    const observedAt = new Date().toISOString()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,'ROLLING_24H',85,NULL,'UPSTREAM_HEADER',?),(?,?,'ROLLING_24H',15,NULL,'UPSTREAM_HEADER',?)`)
      .run(ownerUserId, highUsage.id, observedAt, ownerUserId, lowUsage.id, observedAt)
    // Route grok traffic to xAI so the go-account does not steal the selection.
    new ModelRoutingRepository(ownerUserId, db).create("grok-*", ["xai-grok"])
    routing.setModel("grok-4.5")
    routing.setPreferred(highUsage.id)
    routing.setPreferred(null)
    expect(routing.select("mixed-pool-request", "responses", new Set()).account.id).toBe(lowUsage.id)
  })

  it("模型路由规则是严格允许池，单一 xAI 池耗尽时不会回退到兼容 Go 池", () => {
    const { db, accounts, routing, add } = make()
    add("go-grok-outside-rule")
    const xai = accounts.createProviderAccount({ name: "xAI exhausted", poolType: "xai-grok", externalId: "xai-exhausted" })
    new ModelRoutingRepository(ownerUserId, db).create("grok-*", ["xai-grok"])
    routing.setModel("grok-4.5")
    routing.markQuota(xai.id, "ROLLING_24H", 3_600)

    expect(() => routing.select("grok-strict-pool", "responses", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("显式号池约束耗尽时不会回退到约束外账号", () => {
    const { accounts, routing, add } = make()
    add("go-outside-constraint")
    const xai = accounts.createProviderAccount({ name: "xAI constrained exhausted", poolType: "xai-grok", externalId: "xai-constrained-exhausted" })
    routing.setModel("grok-4.5")
    routing.setRequestConstraint({ poolType: "xai-grok" })
    routing.markQuota(xai.id, "ROLLING_24H", 3_600)

    expect(() => routing.select("constrained-exhausted", "responses", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("自动修复旧版本把临时 xAI 429 覆盖成 100% token 用量的记录", () => {
    const { db, accounts, routing } = make()
    const account = accounts.createProviderAccount({ name: "xAI legacy", poolType: "xai-grok", externalId: "xai-legacy-limit" })
    const observedAt = new Date().toISOString()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,'ROLLING_24H',100,?,'UPSTREAM_429',?,1000000,750000)`)
      .run(ownerUserId, account.id, new Date(Date.now() - 1_000).toISOString(), observedAt)

    expect(routing.select("legacy-rate-limit-repair", "responses", new Set()).account.id).toBe(account.id)
    expect(db.prepare("SELECT usage_percent,reset_at,source FROM quota_windows WHERE account_id=? AND kind='ROLLING_24H'").get(account.id))
      .toEqual({ usage_percent: 25, reset_at: null, source: "UPSTREAM_HEADER" })
    expect(db.prepare("SELECT usage_percent,source FROM quota_windows WHERE account_id=? AND kind='PROVIDER_RATE_LIMIT'").get(account.id))
      .toEqual({ usage_percent: 100, source: "UPSTREAM_429" })
  })

  it("glm 请求只路由到支持该模型的 provider，不会因为上一次 grok 粘在 xAI", () => {
    const { db, accounts, routing, add } = make()
    const go = add("go-for-glm")
    const xai = accounts.createProviderAccount({ name: "xAI sticky", poolType: "xai-grok", externalId: "xai-sticky" })
    // Simulate a previous grok request that left currentAccountId on xAI.
    db.prepare("UPDATE routing_state SET current_account_id=?, cursor_version=cursor_version+1, updated_at=? WHERE owner_user_id=?")
      .run(xai.id, new Date().toISOString(), ownerUserId)
    routing.setModel("glm-5.2")
    const selected = routing.select("glm-after-grok", "chat/completions", new Set())
    expect(selected.account.id).toBe(go)
    expect(selected.account.poolType).toBe("opencode-go")
  })

  it("k3-256k 只路由到 kimi-code，不会落到 OpenCode Go", () => {
    const { accounts, routing, add } = make()
    add("go-wrong-pool")
    const kimi = accounts.createProviderAccount({ name: "Kimi seat", poolType: "kimi-code", externalId: "kimi-k3" })
    accounts.createProviderAccount({ name: "xAI seat", poolType: "xai-grok", externalId: "xai-k3" })
    routing.setModel("k3-256k")
    const selected = routing.select("k3-to-kimi", "chat/completions", new Set())
    expect(selected.account.id).toBe(kimi.id)
    expect(selected.account.poolType).toBe("kimi-code")
  })

  it("模型路由规则只影响匹配模型，不把不支持的模型打到优先号池", () => {
    const { db, accounts, routing, add } = make()
    const go = add("go-glm")
    accounts.createProviderAccount({ name: "xAI only-grok", poolType: "xai-grok", externalId: "xai-only-grok" })
    // Even if someone misconfigures a broad priority that starts with xAI,
    // unsupported models must skip that pool.
    new ModelRoutingRepository(ownerUserId, db).create("glm-*", ["xai-grok", "opencode-go"])
    routing.setModel("glm-5.2")
    const selected = routing.select("glm-priority-skip-xai", "chat/completions", new Set())
    expect(selected.account.id).toBe(go)
    expect(selected.account.poolType).toBe("opencode-go")
  })

  it("本地已超 1M 且上游报错后，将 xAI 号标记为当天不可用", () => {
    const { db, accounts, routing } = make()
    const xai = accounts.createProviderAccount({ name: "xAI spent", poolType: "xai-grok", externalId: "xai-spent" })
    const other = accounts.createProviderAccount({ name: "xAI fresh", poolType: "xai-grok", externalId: "xai-fresh" })
    const now = new Date()
    // Simulate local 24h usage already past 1M tokens.
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES(?,?, 'chat/completions','grok-4.5',200,'SUCCESS',1,?,1,?,1200000)`)
      .run("req-local-usage", ownerUserId, new Date(now.getTime() - 60_000).toISOString(), xai.id)
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,'ROLLING_24H',120,NULL,'LOCAL_USAGE',?,1000000,-200000)`)
      .run(ownerUserId, xai.id, now.toISOString())

    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, now)

    const blocked = db.prepare("SELECT kind,usage_percent,reset_at,source FROM quota_windows WHERE account_id=? AND kind='ROLLING_24H'").get(xai.id) as {
      kind: string; usage_percent: number; reset_at: string | null; source: string
    }
    expect(blocked.kind).toBe("ROLLING_24H")
    expect(blocked.usage_percent).toBeGreaterThanOrEqual(100)
    expect(blocked.reset_at).toBeTruthy()
    expect(blocked.source).toBe("UPSTREAM_429")

    routing.setModel("grok-4.5")
    const selected = routing.select("after-day-block", "chat/completions", new Set())
    expect(selected.account.id).toBe(other.id)
  })

  it("xAI 连续三次限额失败后固定封锁 24 小时", () => {
    const { db, accounts, routing } = make()
    const xai = accounts.createProviderAccount({ name: "xAI unstable", poolType: "xai-grok", externalId: "xai-three-failures" })
    const now = new Date()

    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, now)
    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, new Date(now.getTime() + 61_000))
    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, new Date(now.getTime() + 122_000))

    const row = db.prepare("SELECT usage_percent,reset_at,source FROM quota_windows WHERE account_id=? AND kind='ROLLING_24H'").get(xai.id) as { usage_percent: number; reset_at: string; source: string }
    expect(row).toMatchObject({ usage_percent: 100, source: "UPSTREAM_429" })
    expect(Date.parse(row.reset_at) - new Date(now.getTime() + 122_000).getTime()).toBeGreaterThanOrEqual(24 * 60 * 60_000)
    const event = db.prepare("SELECT metadata_json FROM events WHERE account_id=? AND type='ACCOUNT_QUOTA_BLOCKED' ORDER BY rowid DESC LIMIT 1").get(xai.id) as { metadata_json: string }
    expect(JSON.parse(event.metadata_json)).toMatchObject({ consecutiveFailures: 3, blockReason: "consecutive_failures", dayUnavailable: true })
  })

  it("xAI 达到 90 万 token 后退出调度并在 24 小时后恢复", () => {
    const { db, accounts, routing } = make()
    const xai = accounts.createProviderAccount({ name: "xAI threshold", poolType: "xai-grok", externalId: "xai-900k" })
    const now = new Date()
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('xai-900k-request',?, 'chat/completions','grok-4.5',200,'SUCCESS',1,?,1,?,900000)`)
      .run(ownerUserId, new Date(now.getTime() - 60_000).toISOString(), xai.id)
    upsertLocalRollingUsage(ownerUserId, xai.id, db, now)
    routing.setModel("grok-4.5")

    expect(() => routing.select("blocked-at-900k", "chat/completions", new Set(), now)).toThrowError(NoEligibleAccountError)
    const recovered = routing.select("recovered-after-24h", "chat/completions", new Set(), new Date(now.getTime() + 24 * 60 * 60_000 + 2_000))
    expect(recovered.account.id).toBe(xai.id)
  })

  it("旧 LOCAL_USAGE 100% 且无 reset 的幽灵封锁会在选路前自愈", () => {
    const { db, accounts, routing } = make()
    const xai = accounts.createProviderAccount({ name: "xAI legacy local block", poolType: "xai-grok", externalId: "xai-legacy-local-block" })
    const now = new Date()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,'ROLLING_24H',100,NULL,'LOCAL_USAGE',?,1000000,0)`)
      .run(ownerUserId, xai.id, new Date(now.getTime() - 25 * 60 * 60_000).toISOString())
    routing.setModel("grok-4.5")

    const selected = routing.select("legacy-local-recovers", "responses", new Set(), now)

    expect(selected.account.id).toBe(xai.id)
    expect(db.prepare("SELECT usage_percent,remaining_value,reset_at,source FROM quota_windows WHERE account_id=? AND kind='ROLLING_24H'").get(xai.id))
      .toEqual({ usage_percent: 0, remaining_value: 1000000, reset_at: null, source: "LOCAL_USAGE" })
  })

  it("真实 provider cooldown 不会被本地用量自愈清除", () => {
    const { db, accounts, routing } = make()
    const xai = accounts.createProviderAccount({ name: "xAI provider cooldown", poolType: "xai-grok", externalId: "xai-provider-cooldown" })
    const now = new Date()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,'PROVIDER_RATE_LIMIT',100,?,'UPSTREAM_429',?)`)
      .run(ownerUserId, xai.id, new Date(now.getTime() + 600_000).toISOString(), new Date(now.getTime() - 25 * 60 * 60_000).toISOString())
    routing.setModel("grok-4.5")

    expect(() => routing.select("provider-cooldown-stays-blocked", "responses", new Set(), now)).toThrowError(NoEligibleAccountError)
    expect(db.prepare("SELECT COUNT(*) AS value FROM quota_windows WHERE account_id=? AND kind='PROVIDER_RATE_LIMIT'").get(xai.id)).toEqual({ value: 1 })
  })

  it("xAI 成功一次后连续失败计数重新开始", () => {
    const { db, accounts, routing } = make()
    const xai = accounts.createProviderAccount({ name: "xAI recovered", poolType: "xai-grok", externalId: "xai-failure-reset" })
    const now = new Date()
    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, now)
    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, new Date(now.getTime() + 61_000))
    routing.markSuccess(xai.id)
    const successAt = new Date(Date.now() + 1_000).toISOString()
    db.prepare("UPDATE accounts SET last_success_at=? WHERE id=?").run(successAt, xai.id)

    routing.markQuota(xai.id, "PROVIDER_RATE_LIMIT", 60, new Date(now.getTime() + 122_000))

    expect(db.prepare("SELECT COUNT(*) AS value FROM quota_windows WHERE account_id=? AND kind='ROLLING_24H'").get(xai.id)).toEqual({ value: 0 })
    const event = db.prepare("SELECT metadata_json FROM events WHERE account_id=? AND type='ACCOUNT_QUOTA_BLOCKED' ORDER BY rowid DESC LIMIT 1").get(xai.id) as { metadata_json: string }
    expect(JSON.parse(event.metadata_json)).toMatchObject({ consecutiveFailures: 1, dayUnavailable: false })
  })

  it("入口格式门控：chat 入口排除 messages-only 账号，messages 入口保留", () => {
    const { db, accounts, routing, add } = make()
    setGlobalDatabase(db)
    try {
      const goId = add("one")
      const provider = new CustomProviderRepository(ownerUserId, db).create({ name: "messages only", baseUrl: "https://anthropic.example.com/v1", interfaceTypes: ["messages"] })
      const customId = accounts.createProviderAccount({ name: "claude key", poolType: provider.poolType }).id

      // chat 入口：messages-only 账号无转换链可达，被排除
      routing.setInterfaceFormat("chat")
      expect(routing.select("gate-chat", "chat/completions", new Set()).account.id).toBe(goId)
      routing.releaseLease(routing.select("gate-chat-2", "chat/completions", new Set()).leaseId)

      // messages 入口：两个账号都原生支持
      routing.setInterfaceFormat("messages")
      expect(routing.select("gate-messages", "messages", new Set([goId])).account.id).toBe(customId)

      // chat 入口且只剩 messages-only 账号：fail closed
      routing.setInterfaceFormat("chat")
      expect(() => routing.select("gate-chat-none", "chat/completions", new Set([goId]))).toThrowError(NoEligibleAccountError)
    } finally {
      invalidateCustomProviderCache()
      setGlobalDatabase(undefined)
    }
  })

  it("raw 直通仅保留原生支持入口格式的账号", () => {
    const { routing, add } = make()
    add("one")
    // opencode-go 原生声明 chat+messages：raw responses 不可路由，raw messages 可以
    routing.setInterfaceFormat("responses", true)
    expect(() => routing.select("raw-responses", "responses", new Set())).toThrowError(NoEligibleAccountError)
    routing.setInterfaceFormat("messages", true)
    expect(routing.select("raw-messages", "messages", new Set()).account).toBeDefined()
    // 非 raw（可转换）：responses 经 chat 枢纽可达
    routing.setInterfaceFormat("responses")
    expect(routing.select("processed-responses", "responses", new Set()).account).toBeDefined()
  })
})

describe("open-design-go 并发排队等待", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })
  afterEach(() => { setGlobalDatabase(undefined) })

  function makeOpenDesign() {
    const { db, accounts, routing } = make()
    setGlobalDatabase(db)
    const account = accounts.createProviderAccount({ name: "OpenDesign Go", poolType: "open-design-go", externalId: "odg-queue", maxConcurrency: 1 })
    return { db, accounts, routing, account }
  }

  it("槽位已满时 select 抛出 CONCURRENCY_FULL 而非 NO_ELIGIBLE", () => {
    const { routing, account } = makeOpenDesign()
    const first = routing.select("req-1", "responses", new Set())
    expect(first.account.id).toBe(account.id)
    try {
      routing.select("req-2", "responses", new Set())
      throw new Error("expected failure")
    } catch (cause) {
      expect(cause).toBeInstanceOf(NoEligibleAccountError)
      expect((cause as NoEligibleAccountError).reason).toBe("CONCURRENCY_FULL")
    }
    routing.releaseLease(first.leaseId)
  })

  it("selectWithQueue 等待槽位释放后获得账号", async () => {
    const { routing, account } = makeOpenDesign()
    const first = routing.select("req-1", "responses", new Set())
    let released = false
    const sleep = async () => {
      if (!released) { released = true; routing.releaseLease(first.leaseId) }
    }
    const selected = await routing.selectWithQueue("req-2", "responses", new Set(), { sleep, pollIntervalMs: 1, queueWaitTimeoutMs: 1000 })
    expect(selected.account.id).toBe(account.id)
    routing.releaseLease(selected.leaseId)
  })

  it("selectWithQueue 超时后抛出 QueueWaitTimeoutError", async () => {
    const { routing } = makeOpenDesign()
    routing.select("req-1", "responses", new Set())
    await expect(
      routing.selectWithQueue("req-2", "responses", new Set(), { queueWaitTimeoutMs: 20, pollIntervalMs: 5 }),
    ).rejects.toBeInstanceOf(QueueWaitTimeoutError)
  })

  it("selectWithQueue 请求被取消时立即抛出 QueueWaitAbortedError", async () => {
    const { routing } = makeOpenDesign()
    routing.select("req-1", "responses", new Set())
    const controller = new AbortController()
    controller.abort()
    await expect(
      routing.selectWithQueue("req-2", "responses", new Set(), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(QueueWaitAbortedError)
  })

  it("非排队池（opencode-go）并发满时仍立即失败，不排队", async () => {
    const { routing, add, accounts } = make()
    const accountId = add("go-full")
    accounts.updateState(accountId, { maxConcurrency: 1 })
    routing.select("req-1", "responses", new Set())
    try {
      routing.select("req-2", "responses", new Set())
      throw new Error("expected failure")
    } catch (cause) {
      expect(cause).toBeInstanceOf(NoEligibleAccountError)
      expect((cause as NoEligibleAccountError).reason).toBe("NO_ELIGIBLE")
    }
    await expect(
      routing.selectWithQueue("req-3", "responses", new Set(), { queueWaitTimeoutMs: 20, pollIntervalMs: 5 }),
    ).rejects.toBeInstanceOf(NoEligibleAccountError)
  })
})

describe("共享管理员账号池", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  function makeShared(sharePools?: string[]) {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    const insertUser = (id: string, role: string) => db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(id, id, id, id, role, "hash", timestamp, timestamp)
    // 管理员 user-admin + 普通用户 ownerUserId（请求方）
    insertUser("user-admin", "ADMIN")
    insertUser(ownerUserId, "USER")
    const adminAccounts = new AccountRepository("user-admin", db, new SecretVault(encryptionKey))
    const adminAccount = adminAccounts.createProviderAccount({ name: "admin shared", poolType: "xai-grok", externalId: "admin-shared" })
    const userAccounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
    const enable = (poolTypes: string[]) => {
      db.prepare("UPDATE users SET share_admin_pool_enabled=1 WHERE id=?").run(ownerUserId)
      const ins = db.prepare("INSERT INTO user_shared_pools(user_id,pool_type,created_at,updated_at) VALUES(?,?,?,?)")
      for (const pt of poolTypes) ins.run(ownerUserId, pt, timestamp, timestamp)
    }
    // sharedEnabled 在 RoutingService 构造时读取一次，故必须先 enable 再构造。
    if (sharePools) enable(sharePools)
    const routing = new RoutingService(ownerUserId, db)
    return { db, adminAccounts, adminAccount, userAccounts, routing, enable }
  }

  it("开启共享后候选含管理员该池账号且 own 在前", () => {
    const { routing, userAccounts, adminAccount } = makeShared(["xai-grok"])
    const own = userAccounts.createProviderAccount({ name: "own xai", poolType: "xai-grok", externalId: "own-xai" })
    routing.setModel("grok-4.5")
    const selected = routing.select("shared-1", "chat/completions", new Set())
    expect(selected.account.id).toBe(own.id)
    routing.releaseLease(selected.leaseId)
    const next = routing.select("shared-2", "chat/completions", new Set([own.id]))
    expect(next.account.id).toBe(adminAccount.id)
  })

  it("未开启共享时候选不含管理员账号", () => {
    const { routing, userAccounts } = makeShared()
    userAccounts.createProviderAccount({ name: "own xai", poolType: "xai-grok", externalId: "own-xai" })
    routing.setModel("grok-4.5")
    const selected = routing.select("noswap-1", "chat/completions", new Set())
    expect(selected.account.ownerUserId).toBe(ownerUserId)
    expect(() => routing.select("noswap-2", "chat/completions", new Set([selected.account.id]))).toThrowError(NoEligibleAccountError)
  })

  it("custom:* 覆盖 custom:<id> 账号", () => {
    const { db, routing, adminAccounts } = makeShared(["custom:*"])
    setGlobalDatabase(db)
    try {
      const provider = new CustomProviderRepository("user-admin", db).create({ name: "admin custom provider", baseUrl: "https://x.example.com/v1", interfaceTypes: ["chat"] })
      const customAccount = adminAccounts.createProviderAccount({ name: "admin custom", poolType: provider.poolType })
      const selected = routing.select("custom-shared", "chat/completions", new Set())
      expect(selected.account.id).toBe(customAccount.id)
    } finally {
      invalidateCustomProviderCache()
      setGlobalDatabase(undefined)
    }
  })

  it("管理员账号阻断对共享者可见", () => {
    const { db, routing, adminAccount } = makeShared(["xai-grok"])
    db.prepare("INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at) VALUES(?,?,?,100,?,?,?)")
      .run("user-admin", adminAccount.id, "ROLLING_24H", null, "UPSTREAM_429", new Date().toISOString())
    routing.setModel("grok-4.5")
    expect(() => routing.select("blocked-shared", "chat/completions", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("markQuota 写回归属到账号 owner，不触碰请求用户 routing_state", () => {
    const { db, routing, adminAccount } = makeShared(["xai-grok"])
    routing.markQuota(adminAccount.id, "ROLLING_24H", 3600)
    const qw = db.prepare("SELECT owner_user_id FROM quota_windows WHERE account_id=?").get(adminAccount.id) as { owner_user_id: string }
    expect(qw.owner_user_id).toBe("user-admin")
    const state = db.prepare("SELECT current_account_id FROM routing_state WHERE owner_user_id=?").get(ownerUserId) as { current_account_id: string | null }
    expect(state.current_account_id).toBeNull()
  })

  it("markPermanentlyDisabled 对共享账号仅记录事件、不落库禁用", () => {
    const { db, routing, adminAccount } = makeShared(["xai-grok"])
    routing.markPermanentlyDisabled(adminAccount.id, "CREDENTIAL_INVALID", "bad")
    const acc = db.prepare("SELECT admin_state FROM accounts WHERE id=?").get(adminAccount.id) as { admin_state: string }
    expect(acc.admin_state).toBe("ENABLED")
    const evt = db.prepare("SELECT COUNT(*) AS c FROM events WHERE account_id=? AND type='ACCOUNT_CREDENTIAL_INVALID'").get(adminAccount.id) as { c: number }
    expect(evt.c).toBe(1)
  })

  it("setPoolPreference 拒绝共享账号", () => {
    const { routing, adminAccount } = makeShared(["xai-grok"])
    expect(() => routing.setPoolPreference("xai-grok", adminAccount.id)).toThrow(/Account not found/)
  })

  it("两个不同 owner 对同一共享账号各写 1 条活跃 lease → in-flight 计数=2", () => {
    const { db, routing, adminAccount } = makeShared(["xai-grok"])
    db.prepare("UPDATE accounts SET max_concurrency=1 WHERE id=?").run(adminAccount.id)
    const now = new Date()
    const mkLease = (owner: string, reqId: string) => db.prepare("INSERT INTO route_leases(id,owner_user_id,request_id,account_id,credential_version,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(owner + reqId, owner, reqId, adminAccount.id, 1, new Date(now.getTime() + 600_000).toISOString(), now.toISOString())
    mkLease("user-admin", "admin-req")
    mkLease(ownerUserId, "user-req")
    routing.setModel("grok-4.5")
    expect(() => routing.select("concurrency-shared", "chat/completions", new Set())).toThrowError(NoEligibleAccountError)
  })
})
