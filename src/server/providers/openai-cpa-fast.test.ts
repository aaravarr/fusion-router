import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, getDatabase, type AppDatabase } from "../db"
import { invalidatePoolModelConfigCache, PoolModelConfigRepository } from "../pool-model-config"
import { normalizeCodexResponsesBody, OpenAICPAProvider } from "./openai-cpa"
import type { AccountRecord } from "../types"

// fast 开关注入链路：pool_model_config（10s TTL 缓存）→ normalizeCodexResponsesBody
// 按 owner+model 注入 service_tier:"priority"（buildForwardTarget 覆盖 responses/chat 两入口）。

const ownerUserId = "pool-model-config-test-owner"
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>
const decode = (body: Uint8Array<ArrayBuffer> | null) => JSON.parse(new TextDecoder().decode(body!)) as Record<string, unknown>

beforeEach(() => {
  db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, ownerUserId, ownerUserId, "Pool Model Config Test", "USER", "hash", timestamp, timestamp)
  setGlobalDatabase(db)
  expect(getDatabase()).toBe(db)
})

afterEach(() => {
  invalidatePoolModelConfigCache()
  vi.useRealTimers()
  setGlobalDatabase(undefined)
  db.close()
})

describe("PoolModelConfigRepository（pool_model_config 表）", () => {
  it("set 未有配置时 INSERT，已有配置时 UPDATE（UPSERT 幂等）", () => {
    const repo = new PoolModelConfigRepository(ownerUserId, db)
    const first = repo.set("openai", "gpt-5.6-sol", true)
    expect(first.fastEnabled).toBe(true)
    expect(first.poolType).toBe("openai")
    expect(first.model).toBe("gpt-5.6-sol")

    const second = repo.set("openai", "gpt-5.6-sol", false)
    expect(second.id).toBe(first.id)
    expect(second.fastEnabled).toBe(false)
    expect(second.updatedAt >= first.createdAt).toBe(true)
    expect(repo.list("openai")).toHaveLength(1)
    expect(repo.get("openai", "gpt-5.6-sol")?.fastEnabled).toBe(false)
  })

  it("唯一键隔离：同 owner 不同 pool_type / 不同 model 互不影响", () => {
    const repo = new PoolModelConfigRepository(ownerUserId, db)
    repo.set("openai", "gpt-5.6-sol", true)
    repo.set("openai", "gpt-5.6-luna", true)
    repo.set("kimi-code", "kimi-k2", true)
    expect(repo.list("openai").map((item) => item.model).sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"])
    expect(repo.list("kimi-code")).toHaveLength(1)
    expect(repo.get("openai", "gpt-5.6-luna")?.fastEnabled).toBe(true)
  })

  it("owner 隔离：A 用户开启不影响 B 用户", () => {
    const otherOwner = "pool-model-config-other-owner"
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(otherOwner, otherOwner, otherOwner, "Other", "USER", "hash", timestamp, timestamp)
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", true)
    new PoolModelConfigRepository(otherOwner, db).set("openai", "gpt-5.6-sol", false)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(true)
    expect(isFast(otherOwner, "gpt-5.6-sol")).toBe(false)
    invalidatePoolModelConfigCache(otherOwner)
  })
})

function isFast(owner: string, model: string): boolean {
  return normalizeFastProbe(owner, model)
}

function normalizeFastProbe(owner: string, model: string): boolean {
  const out = decode(normalizeCodexResponsesBody(encode({ model, input: [] }), owner, model))
  return out.service_tier === "priority"
}

describe("normalizeCodexResponsesBody fast 注入三态", () => {
  it("开关开：注入 service_tier:\"priority\"", () => {
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", true)
    invalidatePoolModelConfigCache(ownerUserId)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(true)
  })

  it("开关关：删除客户端 service_tier，不注入", () => {
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", false)
    invalidatePoolModelConfigCache(ownerUserId)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(false)
    // 无配置模型同样不注入
    expect(isFast(ownerUserId, "gpt-5.6-luna")).toBe(false)
  })

  it("客户端显式传 service_tier:\"priority\"：始终尊重客户端（开关关/无配置都不删除）", () => {
    const out = decode(normalizeCodexResponsesBody(
      encode({ model: "gpt-5.6-sol", input: [], service_tier: "priority" }),
      ownerUserId,
      "gpt-5.6-sol",
    ))
    expect(out.service_tier).toBe("priority")
    // 开关未开 + 客户端 priority → 仍保留（客户端显式意图优先）
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(false)
    const kept = decode(normalizeCodexResponsesBody(
      encode({ model: "gpt-5.6-sol", input: [], service_tier: "priority" }),
    ))
    expect(kept.service_tier).toBe("priority")
  })

  it("客户端传 service_tier:\"default\"：开关开时被网关注入覆盖为 priority，开关关时仅删除", () => {
    const out = decode(normalizeCodexResponsesBody(
      encode({ model: "gpt-5.6-sol", input: [], service_tier: "default" }),
      ownerUserId,
      "gpt-5.6-sol",
    ))
    expect(out.service_tier).toBeUndefined()
  })

  it("10s TTL 缓存：TTL 内写库不生效（零额外打库），TTL 过期后读到新值；失效后立即生效", () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T00:00:00Z") })
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(false)

    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", true)
    // TTL 内：仍读缓存旧值（证明请求路径没有每请求打库）
    vi.advanceTimersByTime(5_000)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(false)
    // TTL 过期：重新查库读到新值
    vi.advanceTimersByTime(5_100)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(true)

    // 写后主动失效：立即生效（API PUT 的行为）
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", false)
    invalidatePoolModelConfigCache(ownerUserId)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(false)
  })

  it("TTL 缓存按 owner 隔离：A 的失效/读取不影响 B", () => {
    const otherOwner = "pool-model-config-ttl-other"
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(otherOwner, otherOwner, otherOwner, "Other TTL", "USER", "hash", timestamp, timestamp)
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", true)
    invalidatePoolModelConfigCache(ownerUserId)
    expect(isFast(ownerUserId, "gpt-5.6-sol")).toBe(true)
    expect(isFast(otherOwner, "gpt-5.6-sol")).toBe(false)
    invalidatePoolModelConfigCache()
  })

  it("未知 owner / 未知模型 → 不注入；非 JSON body 原样透传", () => {
    expect(isFast("", "gpt-5.6-sol")).toBe(false)
    const raw = new TextEncoder().encode("not-json") as Uint8Array<ArrayBuffer>
    expect(normalizeCodexResponsesBody(raw, ownerUserId, "gpt-5.6-sol")).toBe(raw)
    expect(normalizeCodexResponsesBody(null, ownerUserId, "gpt-5.6-sol")).toBeNull()
  })
})

describe("buildForwardTarget 传递 fast 上下文（responses/chat 两入口统一）", () => {
  const provider = new OpenAICPAProvider()
  const account = {
    id: "acct-fast",
    ownerUserId,
    poolType: "openai",
  } as AccountRecord

  it("开关开：经 buildForwardTarget 后 body 携带 service_tier:\"priority\"，并带请求 model", () => {
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", true)
    invalidatePoolModelConfigCache(ownerUserId)
    const target = provider.buildForwardTarget({
      method: "POST",
      endpoint: "responses",
      model: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol",
      body: encode({ model: "gpt-5.6-sol", input: [] }),
      headers: new Headers(),
      signal: AbortSignal.timeout(1_000),
    }, { token: "at-x", credentialVersion: 1 }, account)
    expect(decode(target.body).service_tier).toBe("priority")
  })

  it("开关开但客户端显式 priority：不重复注入，保持一个字段", () => {
    new PoolModelConfigRepository(ownerUserId, db).set("openai", "gpt-5.6-sol", true)
    invalidatePoolModelConfigCache(ownerUserId)
    const target = provider.buildForwardTarget({
      method: "POST",
      endpoint: "responses",
      model: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol",
      body: encode({ model: "gpt-5.6-sol", input: [], service_tier: "priority" }),
      headers: new Headers(),
      signal: AbortSignal.timeout(1_000),
    }, { token: "at-x", credentialVersion: 1 }, account)
    expect(decode(target.body).service_tier).toBe("priority")
  })

  it("开关关：经 buildForwardTarget 后 body 不含 service_tier（既有行为不变）", () => {
    const target = provider.buildForwardTarget({
      method: "POST",
      endpoint: "responses",
      model: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol",
      body: encode({ model: "gpt-5.6-sol", input: [] }),
      headers: new Headers(),
      signal: AbortSignal.timeout(1_000),
    }, { token: "at-x", credentialVersion: 1 }, account)
    expect(decode(target.body).service_tier).toBeUndefined()
  })
})
