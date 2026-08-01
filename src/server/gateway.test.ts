import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase } from "./db"
import { ApiKeyHasher, SecretVault } from "./crypto"
import { AccountRepository, ApiKeyRepository } from "./repository"
import { classifyGoUsageLimit, GatewayService, type CredentialProvider } from "./gateway"
import { RoutingService } from "./routing"
import { getSystemSettings, initializeSystemSettings, updateSystemSettings } from "./settings"

const encryptionKey = Buffer.alloc(32, 8).toString("base64")
const ownerUserId = "user-1"
const usage = { FIVE_HOUR: { usagePercent: 1, resetInSeconds: 3600 }, WEEKLY: { usagePercent: 2, resetInSeconds: 86400 }, MONTHLY: { usagePercent: 3, resetInSeconds: 2592000 } }

function setup(poolType: "opencode-go" | "xai-grok" = "opencode-go", accountCount = 2) {
  const db = createDatabase(":memory:"); const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
  const accountIds = Array.from({ length: accountCount }, (_, index) => ["one", "two"][index] ?? `account-${index + 1}`).map((suffix) => poolType === "xai-grok"
    ? accounts.createProviderAccount({ name: `grok-${suffix}`, poolType })
    : accounts.upsertBrowserAccount({ workspaceId: `wrk_${suffix}`, authCookie: `cookie-${suffix}`, goApiKey: `sk-go-${suffix}`, goKeyId: `key_${suffix}`, subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage })).map((account) => account.id)
  const hasher = new ApiKeyHasher("test-pepper"); const apiKey = new ApiKeyRepository(ownerUserId, db, hasher).create("test")
  const credentials: CredentialProvider = { async get(ownerId, accountId) { expect(ownerId).toBe(ownerUserId); const value = accounts.getCredential(accountId)!; return { accountId, goApiKey: value.goApiKey, credentialVersion: value.credentialVersion } } }
  new RoutingService(ownerUserId, db).setPreferred(accountIds[0])
  return { db, apiKey: apiKey.key, credentials, hasher }
}
const request = (key: string) => new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.3-codex" }) })
const requestWithModel = (key: string, model: string, endpoint = "responses") => new Request(`http://localhost/v1/${endpoint}`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model }),
})

describe("gateway", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("只识别精确的 GoUsageLimitError", () => {
    const body = JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "weekly" } })
    expect(classifyGoUsageLimit(new Response(body, { status: 429, headers: { "retry-after": "300" } }), body)).toEqual({ kind: "WEEKLY", retryAfterSeconds: 300 })
    expect(classifyGoUsageLimit(new Response("{}", { status: 429 }), "{}")).toBeNull()
  })

  it("额度错误内部切号，并且上游只收到 Go Bearer 密钥", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "5 hour" } }), { status: 429, headers: { "retry-after": "3600" } })).mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2)
    const headers = fetcher.mock.calls[0][1]?.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer sk-go-one")
    expect(headers.get("x-org-id")).toBeNull(); expect(headers.get("x-api-key")).toBeNull()
  })

  it("一次客户端请求的切号过程只写一条请求记录，并为每次尝试保留完整上游错误报文", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const errorBody = JSON.stringify({
      error: { type: "GoUsageLimitError", message: "quota exhausted", detail: "错".repeat(70_000) },
      metadata: { limitName: "5 hour" },
    })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(errorBody, { status: 429, headers: { "retry-after": "3600" } }))
      .mockResolvedValueOnce(Response.json({ id: "ok" }))

    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")

    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get()).toEqual({ value: 1 })
    const gatewayRequest = db.prepare("SELECT id,attempt_count,status FROM gateway_requests").get() as { id: string; attempt_count: number; status: number }
    expect(gatewayRequest.attempt_count).toBe(2)
    expect(gatewayRequest.status).toBe(200)
    const attempts = db.prepare("SELECT request_id,attempt_number,status,decision,response_body FROM gateway_attempts ORDER BY attempt_number").all() as Array<{
      request_id: string
      attempt_number: number
      status: number
      decision: string
      response_body: string | null
    }>
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ request_id: gatewayRequest.id, attempt_number: 1, status: 429, decision: "RETRY_NEXT_ACCOUNT" })
    expect(attempts[0].response_body).toBe(errorBody)
    expect(attempts[1]).toMatchObject({ request_id: gatewayRequest.id, attempt_number: 2, status: 200, decision: "SUCCESS", response_body: null })
  })

  it("控制台会话可使用内部身份调用并约束指定账号", async () => {
    const { db, credentials } = setup()
    const accounts = db.prepare("SELECT id FROM accounts WHERE owner_user_id=? ORDER BY ordinal").all(ownerUserId) as Array<{ id: string }>
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "ok" }))
    const dashboardRequest = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.3-codex" }),
    })
    const response = await new GatewayService(credentials, db, fetcher).handle(dashboardRequest, "responses", {
      principal: { ownerUserId, label: "chat" },
      routing: { accountId: accounts[1].id },
    })
    expect(response.status).toBe(200)
    expect(db.prepare("SELECT api_key_id,api_key_prefix,account_id FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get())
      .toEqual({ api_key_id: null, api_key_prefix: "chat", account_id: accounts[1].id })
  })

  it("messages 入口使用 Go x-api-key 且不发送 Bearer 或组织头", async () => {
    const { db, apiKey, credentials, hasher } = setup(); const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "messages")
    expect(response.status).toBe(200)
    const headers = fetcher.mock.calls[0][1]?.headers as Headers
    expect(headers.get("x-api-key")).toBe("sk-go-one"); expect(headers.get("authorization")).toBeNull(); expect(headers.get("x-org-id")).toBeNull()
  })

  it("其他错误直接返回且不切号", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "RateLimitError" } }), { status: 429 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("所有账号耗尽后才向外返回统一额度错误", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const limited = () => new Response(JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "weekly" } }), { status: 429, headers: { "retry-after": "600" } })
    const fetcher = vi.fn().mockImplementation(async () => limited())
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(429); expect((await response.json()).error.type).toBe("all_provider_accounts_limited"); expect(fetcher).toHaveBeenCalledTimes(2)
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get()).toEqual({ value: 1 })
    expect(db.prepare("SELECT attempt_count,status FROM gateway_requests").get()).toEqual({ attempt_count: 2, status: 429 })
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_attempts").get()).toEqual({ value: 2 })
  })

  it("达到可配置切号上限后收敛为一条请求记录并保留每次完整报文", async () => {
    const { db, apiKey, credentials, hasher } = setup("opencode-go", 5)
    initializeSystemSettings(db)
    updateSystemSettings({ maxFailoverAttempts: 3 }, null, db)
    expect(getSystemSettings(db).maxFailoverAttempts).toBe(3)
    const errorBodies = Array.from({ length: 3 }, (_, index) => JSON.stringify({
      error: { type: "GoUsageLimitError", message: `quota-${index + 1}`, detail: "完整报文".repeat(1_000) },
      metadata: { limitName: "weekly" },
    }))
    const fetcher = vi.fn()
    for (const body of errorBodies) {
      fetcher.mockResolvedValueOnce(new Response(body, { status: 429, headers: { "retry-after": "600" } }))
    }

    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    const payload = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("600")
    expect(payload.error).toMatchObject({
      type: "failover_attempt_limit_reached",
      attempts: 3,
      max_attempts: 3,
      retry_after: 600,
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get()).toEqual({ value: 1 })
    expect(db.prepare("SELECT status,outcome,attempt_count,ok FROM gateway_requests").get()).toEqual({
      status: 503,
      outcome: "failover_attempt_limit_reached",
      attempt_count: 3,
      ok: 0,
    })
    const attempts = db.prepare("SELECT attempt_number,status,decision,response_body FROM gateway_attempts ORDER BY attempt_number").all() as Array<{
      attempt_number: number
      status: number
      decision: string
      response_body: string
    }>
    expect(attempts).toHaveLength(3)
    expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2, 3])
    expect(attempts.every((attempt) => attempt.status === 429 && attempt.decision === "RETRY_NEXT_ACCOUNT")).toBe(true)
    expect(attempts.map((attempt) => attempt.response_body)).toEqual(errorBodies)
  })

  it("初次路由即失败的客户端重试不会写入零尝试请求日志", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const accountIds = (db.prepare("SELECT id FROM accounts WHERE owner_user_id=?").all(ownerUserId) as Array<{ id: string }>).map((row) => row.id)
    const routing = new RoutingService(ownerUserId, db)
    for (const accountId of accountIds) routing.markQuota(accountId, "WEEKLY", 600)
    const fetcher = vi.fn()

    const first = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    const retry = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")

    expect(first.status).toBe(429)
    expect(retry.status).toBe(429)
    expect(fetcher).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get()).toEqual({ value: 0 })
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_attempts").get()).toEqual({ value: 0 })
  })

  it("超过 64K 的首个 SSE 额度事件跨 chunk 时仍完整保存并内部切号", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const encoder = new TextEncoder()
    const event = `data: ${JSON.stringify({ error: { type: "GoUsageLimitError", detail: "x".repeat(70_000) }, metadata: { limitName: "weekly" } })}\n\n`
    const parts = [event.slice(0, 32_000), event.slice(32_000, 68_000), event.slice(68_000)]
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close() } })
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream", "retry-after": "120" } })).mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2)
    const attempt = db.prepare("SELECT response_body FROM gateway_attempts WHERE attempt_number=1").get() as { response_body: string }
    expect(attempt.response_body).toBe(parts.join(""))
  })

  it("SSE 切号达到上限时返回最短 Retry-After 并保留单主记录和完整事件", async () => {
    const { db, apiKey, credentials, hasher } = setup("opencode-go", 5)
    initializeSystemSettings(db)
    updateSystemSettings({ maxFailoverAttempts: 3 }, null, db)
    const encoder = new TextEncoder()
    const retryAfterValues = [300, 120, 240]
    const events = retryAfterValues.map((_, index) => `data: ${JSON.stringify({
      error: { type: "GoUsageLimitError", message: `sse-quota-${index + 1}`, detail: "SSE完整报文".repeat(500) },
      metadata: { limitName: "weekly" },
    })}\n\n`)
    const fetcher = vi.fn()
    events.forEach((event, index) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(event)); controller.close() } })
      fetcher.mockResolvedValueOnce(new Response(stream, {
        headers: { "content-type": "text/event-stream", "retry-after": String(retryAfterValues[index]) },
      }))
    })

    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    const payload = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("120")
    expect(payload.error).toMatchObject({
      type: "failover_attempt_limit_reached",
      attempts: 3,
      max_attempts: 3,
      retry_after: 120,
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get()).toEqual({ value: 1 })
    expect(db.prepare("SELECT status,outcome,attempt_count FROM gateway_requests").get()).toEqual({
      status: 503,
      outcome: "failover_attempt_limit_reached",
      attempt_count: 3,
    })
    const attempts = db.prepare("SELECT attempt_number,status,decision,response_body FROM gateway_attempts ORDER BY attempt_number").all() as Array<{
      attempt_number: number
      status: number
      decision: string
      response_body: string
    }>
    expect(attempts).toHaveLength(3)
    expect(attempts.every((attempt) => attempt.status === 429 && attempt.decision === "RETRY_NEXT_ACCOUNT")).toBe(true)
    expect(attempts.map((attempt) => attempt.response_body)).toEqual(events)
  })

  it("xAI 正常 SSE 首事件不会被误判成 429", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n'))
      controller.close()
    } })
    const fetcher = vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(requestWithModel(apiKey, "grok-4.5"), "responses")
    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(db.prepare("SELECT COUNT(*) AS value FROM quota_windows WHERE kind='PROVIDER_RATE_LIMIT'").get()).toEqual({ value: 0 })
  })

  it("xAI SSE 中的结构化限频错误才触发冷却并切号", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    const limitedStream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}\n\n'))
      controller.close()
    } })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(limitedStream, { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(requestWithModel(apiKey, "grok-4.5"), "responses")
    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(db.prepare("SELECT COUNT(*) AS value FROM quota_windows WHERE kind='PROVIDER_RATE_LIMIT'").get()).toEqual({ value: 1 })
  })

  it("成功响应携带 provider 配额头时落库且保持成功状态", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "ok" }, { headers: {
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "750000",
      "x-ratelimit-reset-tokens": String(Math.floor(Date.now() / 1000) + 3600),
    } }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(requestWithModel(apiKey, "grok-4.5", "chat/completions"), "chat/completions")
    expect(response.status).toBe(200)
    const quota = db.prepare("SELECT kind,usage_percent,source FROM quota_windows WHERE kind='ROLLING_24H'").get() as { kind: string; usage_percent: number; source: string }
    expect(quota).toEqual({ kind: "ROLLING_24H", usage_percent: 25, source: "UPSTREAM_HEADER" })
  })

  it("xAI 通用 429 只创建短时冷却，不覆盖真实滚动 token 用量", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    const preferred = db.prepare("SELECT preferred_account_id AS id FROM routing_state WHERE owner_user_id=?").get(ownerUserId) as { id: string }
    const observedAt = new Date().toISOString()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,'ROLLING_24H',25,NULL,'UPSTREAM_HEADER',?,1000000,750000)`).run(ownerUserId, preferred.id, observedAt)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(requestWithModel(apiKey, "grok-4.5"), "responses")
    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(db.prepare("SELECT usage_percent,limit_value,remaining_value,source FROM quota_windows WHERE account_id=? AND kind='ROLLING_24H'").get(preferred.id))
      .toEqual({ usage_percent: 25, limit_value: 1000000, remaining_value: 750000, source: "UPSTREAM_HEADER" })
    expect(db.prepare("SELECT usage_percent,source FROM quota_windows WHERE account_id=? AND kind='PROVIDER_RATE_LIMIT'").get(preferred.id))
      .toEqual({ usage_percent: 100, source: "UPSTREAM_429" })
  })

  it("xAI 明确封禁响应会永久停用账号并切换", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    const denied = JSON.stringify({ code: "permission-denied", error: "Access to the chat endpoint is denied. Please ensure you're using the correct credentials." })
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(denied, { status: 403 })).mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(requestWithModel(apiKey, "grok-4.5", "chat/completions"), "chat/completions")
    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const disabled = db.prepare("SELECT admin_state,auth_state,disabled_reason FROM accounts WHERE disabled_reason='XAI_ACCOUNT_BANNED'").get()
    expect(disabled).toEqual({ admin_state: "DISABLED", auth_state: "AUTH_ERROR", disabled_reason: "XAI_ACCOUNT_BANNED" })
  })

  it("用户停用后其统一 API key 立即失效", async () => {
    const { db, apiKey, credentials, hasher } = setup(); db.prepare("UPDATE users SET status='DISABLED' WHERE id=?").run(ownerUserId)
    const fetcher = vi.fn(); const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(401); expect(fetcher).not.toHaveBeenCalled()
  })

  it("超大请求体在转发前拒绝", async () => {
    const { db, apiKey, credentials, hasher } = setup(); const fetcher = vi.fn()
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-length": String(10 * 1024 * 1024 + 1) }, body: "{}" }), "responses")
    expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled()
  })

  it("NETWORK 失败会把 cause 链与 code 记入请求日志", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const root = Object.assign(new Error("socket hang up"), { code: "ECONNRESET", syscall: "read" })
    const wrapped = new Error("fetch failed", { cause: root })
    const fetcher = vi.fn().mockRejectedValue(wrapped)
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(502)
    const body = await response.json() as { error?: { type?: string; message?: string } }
    expect(body.error?.type).toBe("upstream_transport_error")
    expect(body.error?.message).toContain("fetch failed")
    expect(body.error?.message).toContain("ECONNRESET")
    expect(body.error?.message).toContain("socket hang up")

    const row = db.prepare("SELECT outcome,error FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as { outcome: string; error: string | null }
    expect(row.outcome).toBe("NETWORK")
    expect(row.error).toContain("fetch failed")
    expect(row.error).toContain("code=ECONNRESET")
    expect(row.error).toContain("syscall=read")
    expect(row.error).toContain("socket hang up")

    const attempt = db.prepare("SELECT error_type,error_message FROM gateway_attempts ORDER BY started_at DESC LIMIT 1").get() as { error_type: string; error_message: string | null }
    expect(attempt.error_type).toBe("NETWORK")
    expect(attempt.error_message).toContain("ECONNRESET")
  })
})

describe("gateway logging", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  async function drain(response: Response): Promise<void> {
    await response.text()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it("非流式成功请求写入 token 用量与账号快照", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "ok", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    await drain(response)
    const row = db.prepare("SELECT ok,status,account_id,account_name,prompt_tokens,completion_tokens,total_tokens,latency_ms FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as { ok: number; status: number; account_id: string; account_name: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number | null }
    expect(row.ok).toBe(1)
    expect(row.status).toBe(200)
    expect(row.account_id).not.toBeNull()
    expect(row.account_name).not.toBeNull()
    expect(row.prompt_tokens).toBe(10)
    expect(row.completion_tokens).toBe(5)
    expect(row.total_tokens).toBe(15)
    expect(row.latency_ms).not.toBeNull()
  })

  it("失败响应在 logBodiesOnError 开启时落盘请求与响应体", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "RateLimitError", message: "too many" } }), { status: 429 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    await drain(response)
    const body = db.prepare("SELECT has_request,has_response,response_body_json FROM request_bodies ORDER BY created_at DESC LIMIT 1").get() as { has_request: number; has_response: number; response_body_json: string }
    expect(body.has_request).toBe(1)
    expect(body.has_response).toBe(1)
    expect(body.response_body_json).toContain("RateLimitError")
    const req = db.prepare("SELECT ok,error FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as { ok: number; error: string | null }
    expect(req.ok).toBe(0)
    expect(req.error).toContain("too many")
  })

  it("loggingEnabled 关闭时不写 request_bodies", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    db.prepare("INSERT INTO system_settings(key,value_json,is_secret,updated_at) VALUES ('logging_enabled','false',0,?)").run(new Date().toISOString())
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "RateLimitError" } }), { status: 429 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    await drain(response)
    expect((db.prepare("SELECT COUNT(*) value FROM request_bodies").get() as { value: number }).value).toBe(0)
  })

  it("流式响应解析 SSE usage 并写入 token", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const encoder = new TextEncoder()
    const sse = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n`
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse)); controller.close() } })
    const fetcher = vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    await drain(response)
    const row = db.prepare("SELECT ok,stream,prompt_tokens,completion_tokens,total_tokens FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as { ok: number; stream: number; prompt_tokens: number; completion_tokens: number; total_tokens: number }
    expect(row.ok).toBe(1)
    expect(row.stream).toBe(0)
    expect(row.prompt_tokens).toBe(12)
    expect(row.completion_tokens).toBe(8)
    expect(row.total_tokens).toBe(20)
  })
  it("processed free xAI responses do not inject server tools", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    let sent: Record<string, unknown> = {}
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "ok", output: [], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } })
    })
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(req, "responses")
    expect(response.status).toBe(200)
    expect(sent.tools).toBeUndefined()
    const row = db.prepare("SELECT inbound_endpoint,upstream_endpoint,process_mode,route_mode,converted,transform_summary,prompt_tokens,completion_tokens,total_tokens FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.inbound_endpoint).toBe("v1/responses")
    expect(row.upstream_endpoint).toBe("responses")
    expect(row.process_mode).toBe("processed")
    expect(row.route_mode).toBe("responses")
    expect(row.converted).toBe(0)
    expect(String(row.transform_summary || "")).toContain("responses-native")
    expect(String(row.transform_summary || "")).not.toContain("inject:web_search+x_search")
    expect(row.prompt_tokens).toBe(11)
    expect(row.completion_tokens).toBe(7)
    expect(row.total_tokens).toBe(18)
  })

  it("raw responses does not inject default server tools", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    let sent: Record<string, unknown> = {}
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "ok", output: [] })
    })
    const req = new Request("http://localhost/raw/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(req, "responses", { raw: true })
    expect(response.status).toBe(200)
    expect(sent.tools).toBeUndefined()
    const row = db.prepare("SELECT inbound_endpoint,upstream_endpoint,process_mode,route_mode,converted,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.inbound_endpoint).toBe("raw/v1/responses")
    expect(row.upstream_endpoint).toBe("responses")
    expect(row.process_mode).toBe("raw")
    expect(row.converted).toBe(0)
    expect(String(row.transform_summary || "")).toContain("raw")
  })
  it("raw chat completions keeps original body and skips normalization", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    let sentUrl = ""
    let sent: Record<string, unknown> = {}
    const fetcher = vi.fn().mockImplementation(async (url, init) => {
      sentUrl = String(url)
      sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>
      return Response.json({
        id: "chatcmpl_raw",
        object: "chat.completion",
        model: "gpt-5.3-codex",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      })
    })
    const body = { model: "gpt-5.3-codex", messages: [{ role: "user", content: "hello" }], custom_flag: true }
    const req = new Request("http://localhost/raw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(req, "chat/completions", { raw: true })
    expect(response.status).toBe(200)
    expect(sentUrl).toContain("/chat/completions")
    expect(sent).toEqual(body)
    const row = db.prepare("SELECT inbound_endpoint,upstream_endpoint,process_mode,route_mode,converted,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.inbound_endpoint).toBe("raw/v1/chat/completions")
    expect(row.upstream_endpoint).toBe("chat/completions")
    expect(row.process_mode).toBe("raw")
    expect(row.route_mode).toBe("chat")
    expect(row.converted).toBe(0)
    expect(String(row.transform_summary || "")).toContain("raw")
    expect(String(row.transform_summary || "")).not.toContain("chat-normalize")
  })

  it("opencode-go strips responses server search tools before forwarding", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    let sent: Record<string, unknown> = {}
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "ok", output: [] })
    })
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        input: "hello",
        tools: [
          { type: "function", name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
          { type: "web_search" },
          { type: "x_search" },
        ],
      }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(req, "responses")
    expect(response.status).toBe(200)
    const tools = sent.tools as Array<{ type?: string; name?: string }>
    expect(tools.map((t) => t.type)).toEqual(["function"])
    expect(tools[0].name).toBe("read_file")
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(String(row.transform_summary || "")).toContain("strip:web_search+x_search")
  })

  it("xai-grok keeps client-declared server search tools", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    let sent: Record<string, unknown> = {}
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "ok", output: [] })
    })
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        input: "hello",
        tools: [{ type: "web_search" }],
      }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(req, "responses")
    expect(response.status).toBe(200)
    expect((sent.tools as Array<{ type?: string }>).map((t) => t.type)).toEqual(["web_search"])
  })


  it("free Grok without client server tools may chat-fallback on foreign previous_response_id", async () => {
    const { db, apiKey, credentials, hasher } = setup("xai-grok")
    let sentUrl = ""
    const fetcher = vi.fn().mockImplementation(async (url) => {
      sentUrl = String(url)
      return Response.json({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "grok-4.5",
        choices: [{ index: 0, message: { role: "assistant", content: "fallback-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })
    })
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        previous_response_id: "resp_unknown_xyz",
        input: "continue please",
      }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(req, "responses")
    expect(response.status).toBe(200)
    expect(sentUrl).toContain("/chat/completions")
    expect(response.headers.get("x-responses-route")).toBe("chat")
    expect(response.headers.get("x-grok-fallback")).toBe("chat_completions")
  })
})
