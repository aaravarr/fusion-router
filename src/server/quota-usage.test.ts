import { describe, expect, it } from "vitest"
import { createDatabase } from "./db"
import { computeAdaptiveRateLimitSeconds, computeLocalRollingUsage, resolveXaiBlockSeconds, secondsUntilUsageBelowLimit, upsertLocalRollingUsage, XAI_FIXED_BLOCK_SECONDS, XAI_RATE_LIMIT_FALLBACK_SECONDS, XAI_RATE_LIMIT_REPEAT_SECONDS } from "./quota-usage"

describe("quota-usage", () => {
  it("从最近 24h 成功请求汇总 xAI 滚动用量", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-a1','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())

    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r1','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',250000)`).run(new Date(now.getTime() - 60_000).toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r2','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',100000)`).run(new Date(now.getTime() - 2 * 60_000).toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r3','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',900000)`).run(new Date(now.getTime() - 30 * 60 * 60_000).toISOString())

    const computed = computeLocalRollingUsage("a1", db, now)
    expect(computed.usedTokens).toBe(350000)
    expect(computed.usagePercent).toBe(35)
    expect(computed.remainingTokens).toBe(650000)

    const upserted = upsertLocalRollingUsage("u1", "a1", db, now)
    expect(upserted.usagePercent).toBe(35)
    expect(db.prepare("SELECT usage_percent, remaining_value, source FROM quota_windows WHERE account_id='a1' AND kind='ROLLING_24H'").get())
      .toEqual({ usage_percent: 35, remaining_value: 650000, source: "LOCAL_USAGE" })
  })

  it("不会被更低的本地值覆盖已有更高用量", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-a1','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES('u1','a1','ROLLING_24H',80,NULL,'LOCAL_USAGE',?,1000000,200000)`).run(now.toISOString())
    const upserted = upsertLocalRollingUsage("u1", "a1", db, now)
    expect(upserted.usagePercent).toBe(80)
    expect(db.prepare("SELECT usage_percent, remaining_value FROM quota_windows WHERE account_id='a1'").get())
      .toEqual({ usage_percent: 80, remaining_value: 200000 })
  })

  it("百分比保留两位小数", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-a2','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r1','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',602547)`).run(new Date(now.getTime() - 60_000).toISOString())

    const computed = computeLocalRollingUsage("a1", db, now)
    expect(computed.usagePercent).toBe(60.25)
    const upserted = upsertLocalRollingUsage("u1", "a1", db, now)
    expect(upserted.usagePercent).toBe(60.25)
  })

  it("允许超过 100 万 token 并展示真实超限百分比", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-a3','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r1','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',1476236)`).run(new Date(now.getTime() - 60_000).toISOString())

    const computed = computeLocalRollingUsage("a1", db, now)
    expect(computed.usedTokens).toBe(1476236)
    expect(computed.usagePercent).toBe(147.62)
    expect(computed.remainingTokens).toBe(-476236)

    const upserted = upsertLocalRollingUsage("u1", "a1", db, now)
    expect(upserted.usagePercent).toBe(147.62)
    expect(upserted.remainingValue).toBe(-476200)
  })

  it("达到 90 万 token 后按超限固定封锁 24 小时", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-hard-block','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r1','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',900000)`).run(new Date(now.getTime() - 60_000).toISOString())

    expect(upsertLocalRollingUsage("u1", "a1", db, now)).toMatchObject({ usagePercent: 100, remainingValue: 0 })
    const row = db.prepare("SELECT usage_percent,remaining_value,reset_at,source FROM quota_windows WHERE account_id='a1' AND kind='ROLLING_24H'").get() as { usage_percent: number; remaining_value: number; reset_at: string; source: string }
    expect(row).toMatchObject({ usage_percent: 100, remaining_value: 0, source: "LOCAL_USAGE" })
    expect(Date.parse(row.reset_at) - now.getTime()).toBe(XAI_FIXED_BLOCK_SECONDS * 1000)
  })

  it("只等到用量降回 1M 以下，而不是死等最早请求滚出", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-a4','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())

    // oldest 200k at T-20h, then 900k recent => total 1.1M
    // waiting only for oldest request would be 4h; under-limit relief is same here,
    // but if oldest is tiny and later overage is small, under-limit returns sooner.
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('old','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',200000)`).run(new Date(now.getTime() - 20 * 60 * 60_000).toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('new','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',900000)`).run(new Date(now.getTime() - 30 * 60_000).toISOString())

    const seconds = secondsUntilUsageBelowLimit("a1", db, now)
    // after oldest ages out: remaining 900k < 1M, so relief is ~4h
    expect(seconds).toBeGreaterThan(3 * 60 * 60)
    expect(seconds).toBeLessThanOrEqual(4 * 60 * 60 + 5)
  })

  it("header 优先，且本地未超限时 429 会自适应加长", () => {
    const now = new Date("2026-07-24T12:00:00.000Z")
    expect(computeAdaptiveRateLimitSeconds({ suggestedSeconds: null, now })).toBe(XAI_RATE_LIMIT_FALLBACK_SECONDS)
    expect(computeAdaptiveRateLimitSeconds({ suggestedSeconds: 30, now })).toBe(30)
    expect(computeAdaptiveRateLimitSeconds({
      suggestedSeconds: 30,
      previousLimitedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      previousResetAt: new Date(now.getTime() - 60_000).toISOString(),
      now,
    })).toBe(XAI_RATE_LIMIT_REPEAT_SECONDS)

    const db = createDatabase(":memory:")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("u1", "u1", "u1", "U1", "USER", "hash", now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at)
      VALUES('a1','u1','xai','xai-grok','ws-a5','go','PROVIDER_IMPORT',?,?,?,'ACTIVE','VERIFIED_GO_ONLY',?,0,?,?)`)
      .run(now.toISOString(), "cipher-cookie", "cipher-key", now.toISOString(), now.toISOString(), now.toISOString())
    db.prepare(`INSERT INTO gateway_requests(id,owner_user_id,endpoint,model,status,outcome,attempt_count,started_at,ok,account_id,total_tokens)
      VALUES('r1','u1','chat/completions','grok-4.5',200,'SUCCESS',1,?,1,'a1',1200000)`).run(new Date(now.getTime() - 60_000).toISOString())

    const over = resolveXaiBlockSeconds({ accountId: "a1", suggestedSeconds: 120, now, db })
    expect(over.dayUnavailable).toBe(true)
    expect(over.reason).toBe("local_threshold")
    expect(over.seconds).toBe(XAI_FIXED_BLOCK_SECONDS)
  })
})
