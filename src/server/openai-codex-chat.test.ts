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
    // 生产真实形状：completed.response.output=[]，文本只在 output_item.done（2026-09-08 抓包）。
    // 回归生产 bug（48dbedee/ec15d418）：该形状下 content 曾恒为 null。
    const fetcher = vi.fn().mockImplementation(async () => codexRealSseResponse())
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
    expect(choices[0].message.content).toBe("hi")
    expect(choices[0].finish_reason).toBe("stop")
    expect(payload.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 })
    expect(getDatabase()).toBe(db)
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as { transform_summary: string }
    expect(row.transform_summary).toContain("chat->responses")
    expect(row.transform_summary).toContain("sse-sniff:no-content-type")
    expect(row.transform_summary).toContain("aggregate:sse-to-chat-json")
  })

  // 2026-09-08 生产直连抓包（gpt-5.4-mini，chatgpt.com/backend-api/codex）真实形状：
  // 无 content-type 响应头 + 每事件 event: 行 + 单行 data:（obfuscation/sequence_number）；
  // 关键差异：completed.response.output 为空数组 []，文本只在 output_item.done 的 item 里。
  const codexRealEvents = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":1788832908,"status":"in_progress","model":"gpt-5.4-mini-2026-03-17","output":[]},"sequence_number":0}',
    'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_1","status":"in_progress"},"sequence_number":1}',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":2}',
    'event: response.content_part.added\ndata: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"hi","item_id":"msg_1","logprobs":[],"obfuscation":"sOOd49BSM8K","output_index":0,"sequence_number":4}',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","logprobs":[],"output_index":0,"sequence_number":5,"text":"hi"}',
    'event: response.content_part.done\ndata: {"type":"response.content_part.done","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"hi"},"sequence_number":6}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"hi"}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":7}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4-mini-2026-03-17","service_tier":"default","output":[],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":18}},"sequence_number":8}',
    'data: [DONE]',
    "",
  ].join("\n\n")
  const codexRealSseResponse = () => new Response(codexRealEvents, { status: 200 })

  it("stream=true 的 chat 请求：仍走 SSE 流（非流式聚合不干扰流式）", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => codexRealSseResponse())
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(chatRequest(apiKey, {
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }), "chat/completions")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain('"content":"hi"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('"prompt_tokens":12')
    expect(text).toContain("data: [DONE]")
  })
})
