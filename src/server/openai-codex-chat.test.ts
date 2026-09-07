import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, getDatabase, type AppDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { AccountRepository, ApiKeyRepository, ProviderCredentialRepository } from "./repository"
import { GatewayService, type CredentialProvider } from "./gateway"
import { RoutingService } from "./routing"

const ownerUserId = "openai-codex-chat-test-owner"

let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

function setupOpenAI() {
  db = createDatabase(":memory:")
  setGlobalDatabase(db)
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "openai-chat-test", "openai-chat-test", "OpenAI Chat Test", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db)
  const account = accounts.createProviderAccount({ name: "openai acct", poolType: "openai" })
  new ProviderCredentialRepository(ownerUserId, db).upsert({
    accountId: account.id,
    poolType: "openai",
    credentialData: {
      token: "at-test",
      chatgptAccountId: "acct-test",
      expiresAt: String(Math.floor(Date.now() / 1000) + 48 * 3600),
    },
  })
  const hasher = new ApiKeyHasher("test-pepper")
  const apiKey = new ApiKeyRepository(ownerUserId, db, hasher).create("test")
  const credentials: CredentialProvider = {
    async get() { throw new Error("legacy credentials should not be used for openai pool") },
  }
  new RoutingService(ownerUserId, db).setPreferred(account.id)
  return { apiKey: apiKey.key, credentials, hasher }
}

const chatRequest = (key: string, body: unknown) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

const sseResponse = (events: string[]) => new Response(events.join(""), {
  status: 200,
  headers: { "content-type": "text/event-stream" },
})

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setGlobalDatabase(undefined)
  db.close()
})

describe("openai 池 chat→responses 转换层（Codex 参数约束）", () => {
  it("带 max_tokens 的 chat 请求：上游 body 无 max_output_tokens 且 store=false", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    let sentUrl = ""
    let sent: Record<string, unknown> = {}
    const fetcher = vi.fn().mockImplementation(async (url: unknown, init: { body?: unknown }) => {
      sentUrl = String(url)
      sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "resp_1", model: "gpt-5.4-mini", status: "completed", output: [] })
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(chatRequest(apiKey, {
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 64,
      store: true,
      stream_options: { include_usage: true },
    }), "chat/completions")

    expect(response.status).toBe(200)
    expect(sentUrl).toBe("https://chatgpt.com/backend-api/codex/responses")
    // 任务4：max_tokens 不得转为 max_output_tokens 透传（Codex 上游 400）
    expect(sent.max_output_tokens).toBeUndefined()
    expect(sent.max_tokens).toBeUndefined()
    // 任务1/2：store 强制 false；stream_options（含 include_usage）剥离
    expect(sent.store).toBe(false)
    expect(sent.stream_options).toBeUndefined()
    expect(sent.stream).toBe(true)
  })

  it("stream=false 的 chat 请求：聚合上游 SSE（response.completed）后返回完整 chat JSON", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_9","model":"gpt-5.4-mini"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hello "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_9","model":"gpt-5.4-mini","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello world"}]}],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n',
      "data: [DONE]\n\n",
    ]))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(chatRequest(apiKey, {
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }), "chat/completions")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const payload = await response.json() as Record<string, unknown>
    expect(payload.object).toBe("chat.completion")
    const choices = payload.choices as Array<{ message: { content: string }; finish_reason: string }>
    expect(choices[0].message.content).toBe("hello world")
    expect(choices[0].finish_reason).toBe("stop")
    expect(payload.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })
    expect(getDatabase()).toBe(db)
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as { transform_summary: string }
    expect(row.transform_summary).toContain("chat->responses")
    expect(row.transform_summary).toContain("aggregate:sse-to-chat-json")
  })

  it("stream=true 的 chat 请求：仍走 SSE 流（非流式聚合不干扰流式）", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4-mini"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ]))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(chatRequest(apiKey, {
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }), "chat/completions")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain('"content":"hi"')
    expect(text).toContain("data: [DONE]")
  })
})
