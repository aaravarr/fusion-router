import { afterEach, describe, expect, it, vi } from "vitest"
import { apiFetchWithMirrorContext, applyMirrorTarget, getProxyDispatcher, getSystemFallbackGroups, invalidateMirrorCacheForOwner, resolveMirrorPlanForContext, resolveMirrorUrlForContext, selectDomainMirror, selectDomainMirrorGroup, selectMirrorGroupTarget } from "./api-fetch"
import { createDatabase, type AppDatabase } from "./db"
import type { DomainMirrorConfig, DomainMirrorGroup } from "./settings"

const config: DomainMirrorConfig = {
  mirrors: [
    { id: "a", name: "A", url: "https://a.example.com", enabled: true },
    { id: "b", name: "B", url: "https://b.example.com", enabled: true },
    { id: "off", name: "Off", url: "https://off.example.com", enabled: false },
  ],
  accountAssignments: { assigned: "b", disabled: "off" },
  rules: [
    { id: "rule-a", pattern: "@example\\.com", mirrorId: "a", enabled: true },
    { id: "rule-b", pattern: "^prod-", mirrorId: "b", enabled: true },
  ],
}

describe("domain mirror selection", () => {
  it("uses explicit account assignment before regex rules", () => {
    expect(selectDomainMirror(config, { account: { id: "assigned", email: "user@example.com" } })?.id).toBe("b")
  })

  it("uses the first matching enabled regex rule", () => {
    expect(selectDomainMirror(config, { account: { id: "other", email: "user@example.com" } })?.id).toBe("a")
    expect(selectDomainMirror(config, { account: { id: "prod-key" } })?.id).toBe("b")
  })

  it("falls back to stable hash sharding and ignores disabled mirrors", () => {
    const first = selectDomainMirror(config, { account: { id: "stable-account" } })
    const second = selectDomainMirror(config, { account: { id: "stable-account" } })
    expect(second?.id).toBe(first?.id)
    expect(first?.id).not.toBe("off")
    expect(selectDomainMirror(config, { account: { id: "disabled" } })?.id).not.toBe("off")
  })

  it("applies group rules across multiple mirrors before hash sharding", () => {
    const group: DomainMirrorGroup = {
      id: "group-a", name: "Group A", enabled: true,
      domains: ["api.example.com"], accountIds: ["prod-account"],
      mirrors: config.mirrors, rules: config.rules,
    }
    expect(selectMirrorGroupTarget(group, { account: { id: "prod-account" } })?.id).toBe("b")
    const first = selectMirrorGroupTarget(group, { account: { id: "other" } })
    expect(selectMirrorGroupTarget(group, { account: { id: "other" } })?.id).toBe(first?.id)
  })

  it("selects an account-specific group before a domain-wide fallback", () => {
    const fallback: DomainMirrorGroup = { id: "fallback", name: "Fallback", enabled: true, domains: ["api.example.com"], accountIds: [], mirrors: config.mirrors, rules: [] }
    const selected: DomainMirrorGroup = { ...fallback, id: "selected", name: "Selected", accountIds: ["account-a"] }
    expect(selectDomainMirrorGroup([fallback, selected], "api.example.com", "account-a")?.id).toBe("selected")
    expect(selectDomainMirrorGroup([fallback, selected], "api.example.com", "other")?.id).toBe("fallback")
    expect(selectDomainMirrorGroup([selected], "api.example.com", "other")).toBeNull()
  })

  it("rewrites host and preserves the mirror path prefix, request path and query", () => {
    expect(applyMirrorTarget("https://api.example.com/v1/models?limit=10", { id: "m", name: "M", url: "https://mirror.example.com/proxy", enabled: true }))
      .toBe("https://mirror.example.com/proxy/v1/models?limit=10")
  })

  it("expands $host to the original host before appending the request path", () => {
    expect(applyMirrorTarget("https://api.x.ai/v1/models?limit=10", { id: "m", name: "M", url: "https://mirror.ahao1.tech/$host", enabled: true }))
      .toBe("https://mirror.ahao1.tech/api.x.ai/v1/models?limit=10")
  })

  it("只配代理的节点不做 URL 替换，原样返回原始地址", () => {
    expect(applyMirrorTarget("https://api.x.ai/v1/models?limit=10", { id: "m", name: "M", url: "", proxyUrl: "http://127.0.0.1:7890", enabled: true }))
      .toBe("https://api.x.ai/v1/models?limit=10")
  })
})

describe("mirror node proxyUrl", () => {
  function setGlobalDatabase(value: AppDatabase | undefined) {
    (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
  }
  afterEach(() => { setGlobalDatabase(undefined); vi.unstubAllGlobals() })

  function makeProxyDb(mirrors: unknown[]) {
    const db = createDatabase(":memory:")
    const now = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("user-p", "p", "p", "P", "USER", "ACTIVE", "h", now, now)
    db.prepare("INSERT INTO user_mirror_groups(id,owner_user_id,name,enabled,domains_json,account_ids_json,mirrors_json,rules_json,request_rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("g-p", "user-p", "g-p", 1, JSON.stringify(["api.example.com"]), JSON.stringify([]), JSON.stringify(mirrors), JSON.stringify([]), null, now, now)
    return db
  }

  // 镜像组按 owner 有 10s TTL 缓存：换库后必须失效，否则读到上一个用例的组
  function useProxyDb(mirrors: unknown[]) {
    setGlobalDatabase(makeProxyDb(mirrors))
    invalidateMirrorCacheForOwner("user-p")
  }

  it("选中带代理节点时 plan 携带 proxyUrl，URL 仍按镜像地址重写", () => {
    useProxyDb([{ id: "m", name: "M", url: "https://mirror.example.com/$host", proxyUrl: "http://127.0.0.1:7890", enabled: true }])
    expect(resolveMirrorPlanForContext("https://api.example.com/v1/models", { ownerUserId: "user-p" }))
      .toEqual({ url: "https://mirror.example.com/api.example.com/v1/models", proxyUrl: "http://127.0.0.1:7890" })
  })

  it("只配代理的节点：plan 保留原始 URL 并携带 proxyUrl", () => {
    useProxyDb([{ id: "m", name: "M", url: "", proxyUrl: "socks5://127.0.0.1:1080", enabled: true }])
    expect(resolveMirrorPlanForContext("https://api.example.com/v1/models?x=1", { ownerUserId: "user-p" }))
      .toEqual({ url: "https://api.example.com/v1/models?x=1", proxyUrl: "socks5://127.0.0.1:1080" })
  })

  it("未配置代理的节点：plan 不含 proxyUrl", () => {
    useProxyDb([{ id: "m", name: "M", url: "https://mirror.example.com", enabled: true }])
    expect(resolveMirrorPlanForContext("https://api.example.com/x", { ownerUserId: "user-p" }))
      .toEqual({ url: "https://mirror.example.com/x" })
  })

  it("getProxyDispatcher 按 proxyUrl 缓存复用同一实例", () => {
    const a = getProxyDispatcher("http://127.0.0.1:7890")
    expect(getProxyDispatcher("http://127.0.0.1:7890")).toBe(a)
    expect(getProxyDispatcher("http://127.0.0.1:7891")).not.toBe(a)
  })

  it("apiFetchWithMirrorContext 命中代理节点时 fetch 收到重写 URL 与共享 dispatcher", async () => {
    useProxyDb([{ id: "m", name: "M", url: "https://mirror.example.com/$host", proxyUrl: "http://127.0.0.1:7890", enabled: true }])
    const spy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", spy)
    await apiFetchWithMirrorContext("https://api.example.com/v1/models", { method: "GET" }, { ownerUserId: "user-p" })
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }]
    expect(url).toBe("https://mirror.example.com/api.example.com/v1/models")
    expect(init.dispatcher).toBe(getProxyDispatcher("http://127.0.0.1:7890"))
  })

  it("apiFetchWithMirrorContext 命中只配代理的节点时 fetch 收到原始 URL 与 dispatcher", async () => {
    useProxyDb([{ id: "m", name: "M", url: "", proxyUrl: "socks5://127.0.0.1:1080", enabled: true }])
    const spy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", spy)
    await apiFetchWithMirrorContext("https://api.example.com/v1/models", { method: "GET" }, { ownerUserId: "user-p" })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }]
    expect(url).toBe("https://api.example.com/v1/models")
    expect(init.dispatcher).toBe(getProxyDispatcher("socks5://127.0.0.1:1080"))
  })

  it("apiFetchWithMirrorContext 无代理节点时不传 dispatcher", async () => {
    useProxyDb([{ id: "m", name: "M", url: "https://mirror.example.com", enabled: true }])
    const spy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", spy)
    await apiFetchWithMirrorContext("https://api.example.com/v1/models", { method: "GET" }, { ownerUserId: "user-p" })
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }]
    expect(init.dispatcher).toBeUndefined()
  })
})
describe("request mirror rules (body/header)", () => {
  const withRules: DomainMirrorGroup = {
    id: "req-group", name: "Req Group", enabled: true,
    domains: ["api.example.com"], accountIds: [],
    mirrors: [
      { id: "a", name: "A", url: "https://a.example.com", enabled: true },
      { id: "b", name: "B", url: "https://b.example.com", enabled: true },
    ],
    rules: [],
    requestRules: [
      {
        id: "gpt-group", enabled: true, mirrorId: "a", condition: "or",
        rules: [
          { id: "r1", enabled: true, source: "body", field: "model", operator: "contains", value: "gpt" },
          { id: "r2", enabled: true, source: "body", field: "model", operator: "contains", value: "grok" },
        ],
      },
      {
        id: "auth-group", enabled: true, mirrorId: "b", condition: "and",
        rules: [
          { id: "r3", enabled: true, source: "header", field: "authorization", operator: "startsWith", value: "Bearer sk-" },
          { id: "r4", enabled: true, source: "body", field: "stream", operator: "equals", value: "true" },
        ],
      },
    ],
  }

  it("routes by body model contains gpt/grok before account rules", () => {
    const ctx = { account: { id: "prod-account" }, body: { model: "gpt-5.6-luna", stream: false }, headers: new Headers() }
    expect(selectMirrorGroupTarget(withRules, ctx)?.id).toBe("a")
    const grok = { account: { id: "prod-account" }, body: { model: "grok-4.5" }, headers: new Headers() }
    expect(selectMirrorGroupTarget(withRules, grok)?.id).toBe("a")
  })

  it("routes by header+body and-condition to a different mirror", () => {
    const ctx = { account: { id: "x" }, body: { model: "deepseek-v4-flash", stream: true }, headers: new Headers({ authorization: "Bearer sk-test" }) }
    expect(selectMirrorGroupTarget(withRules, ctx)?.id).toBe("b")
  })

  it("falls back to account regex / hash when no request rule matches", () => {
    const ctx = { account: { id: "x" }, body: { model: "deepseek-v4-flash", stream: false }, headers: new Headers() }
    const selected = selectMirrorGroupTarget(withRules, ctx)
    expect(selected?.id).toBeDefined()
    // 未命中请求规则时行为应与无请求规则配置一致（回退账号规则/hash）
    const noReq: DomainMirrorGroup = { ...withRules, requestRules: [] }
    expect(selected?.id).toBe(selectMirrorGroupTarget(noReq, ctx)?.id)
  })

  it("request rules take precedence over explicit account assignment", () => {
    const cfg: DomainMirrorConfig = { mirrors: withRules.mirrors, accountAssignments: { assigned: "b" }, rules: [], requestRules: withRules.requestRules }
    const ctx = { account: { id: "assigned" }, body: { model: "gpt-5.6-luna" }, headers: new Headers() }
    expect(selectDomainMirror(cfg, ctx)?.id).toBe("a")
  })

  it("missing requestRules keeps legacy behavior", () => {
    const ctx = { account: { id: "assigned" }, body: { model: "gpt-5.6-luna" }, headers: new Headers() }
    expect(selectDomainMirror(config, ctx)?.id).toBe("b")
  })
})

describe("per-user 镜像组解析", () => {
  function setGlobalDatabase(value: AppDatabase | undefined) {
    (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
  }
  afterEach(() => setGlobalDatabase(undefined))

  function makeDb() {
    const db = createDatabase(":memory:")
    const now = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("admin-1", "admin", "admin", "Admin", "ADMIN", "ACTIVE", "h", now, now)
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("user-b", "b", "b", "B", "USER", "ACTIVE", "h", now, now)
    const insertGroup = (owner: string, id: string, domains: string[], url: string) => db.prepare("INSERT INTO user_mirror_groups(id,owner_user_id,name,enabled,domains_json,account_ids_json,mirrors_json,rules_json,request_rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, owner, id, 1, JSON.stringify(domains), JSON.stringify([]), JSON.stringify([{ id: "m", name: "M", url, enabled: true }]), JSON.stringify([]), null, now, now)
    insertGroup("user-b", "g-b", ["api.example.com"], "https://mirror-b.example.com")
    insertGroup("admin-1", "g-admin", ["api.example.com"], "https://mirror-admin.example.com")
    return db
  }

  it("命中该用户自己的镜像组", () => {
    setGlobalDatabase(makeDb())
    expect(resolveMirrorUrlForContext("https://api.example.com/v1/models", { ownerUserId: "user-b" }))
      .toBe("https://mirror-b.example.com/v1/models")
  })

  it("第 2 级回退：account.ownerUserId 命中 account.owner 的组", () => {
    setGlobalDatabase(makeDb())
    expect(resolveMirrorUrlForContext("https://api.example.com/v1/models", { account: { id: "a", ownerUserId: "user-b" } }))
      .toBe("https://mirror-b.example.com/v1/models")
  })

  it("第 3 级无主回退：命中首个 ADMIN 的组", () => {
    setGlobalDatabase(makeDb())
    expect(resolveMirrorUrlForContext("https://api.example.com/v1/models"))
      .toBe("https://mirror-admin.example.com/v1/models")
    expect(getSystemFallbackGroups().map((g) => g.id)).toContain("g-admin")
  })

  it("invalidateMirrorCacheForOwner 后立即生效", () => {
    const db = makeDb()
    setGlobalDatabase(db)
    expect(resolveMirrorUrlForContext("https://api.example.com/x", { ownerUserId: "user-b" })).toContain("mirror-b")
    // 更新该用户的组 URL
    const now = new Date().toISOString()
    db.prepare("UPDATE user_mirror_groups SET mirrors_json=? WHERE id='g-b'").run(JSON.stringify([{ id: "m", name: "M", url: "https://mirror-b2.example.com", enabled: true }]))
    invalidateMirrorCacheForOwner("user-b")
    expect(resolveMirrorUrlForContext("https://api.example.com/x", { ownerUserId: "user-b" })).toContain("mirror-b2")
  })
})
