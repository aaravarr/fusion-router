import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, getDatabase, type AppDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { AccountRepository, ApiKeyRepository, ProviderCredentialRepository } from "./repository"
import { GatewayService, type CredentialProvider } from "./gateway"
import { RoutingService } from "./routing"

const ownerUserId = "openai-codex-native-stats-owner"

let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

// 生产实测的 Codex 真实 SSE 形状（openai-codex-chat.test.ts 692cbca fixture，
// 症状记录 id 5946662e 的同形流）：无 content-type 响应头 + LF 分行（无 \n\n
// 空行分帧）+ 10 事件序列 created→…→output_text.delta→…→completed，
// completed 带 usage（input 12 / output 6 / total 18，cached 0，reasoning 0）。
// 注意：LF 形态下 `data: {...completed}` 与 `data: [DONE]` 相邻（无空行分隔），
// iterSseDataPayloads 必须把 [DONE] 独立成帧，否则 completed 载荷被污染。
const codexLfEvents = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":1788832908,"status":"in_progress","model":"gpt-5.4-mini-2026-03-17","output":[]},"sequence_number":0}',
  'event: response.in_progress',
  'data: {"type":"response.in_progress","response":{"id":"resp_1","status":"in_progress"},"sequence_number":1}',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":2}',
  'event: response.content_part.added',
  'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","content_index":0,"delta":"hi","item_id":"msg_1","logprobs":[],"obfuscation":"sOOd49BSM8K","output_index":0,"sequence_number":4}',
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","logprobs":[],"output_index":0,"sequence_number":5,"text":"hi"}',
  'event: response.content_part.done',
  'data: {"type":"response.content_part.done","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"hi"},"sequence_number":6}',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"hi"}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":7}',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4-mini-2026-03-17","service_tier":"default","output":[],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":18}},"sequence_number":8}',
  'data: [DONE]',
].join("\n")

function setupOpenAI() {
  db = createDatabase(":memory:")
  setGlobalDatabase(db)
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "codex-native-stats", "codex-native-stats", "Codex Native Stats", "USER", "hash", timestamp, timestamp)
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

const responsesRequest = (key: string, body: unknown) => new Request("http://localhost/v1/responses", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

async function drain(response: Response): Promise<void> {
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setGlobalDatabase(undefined)
  db.close()
})

describe("openai 池原生直通流日志指标（Codex 无头 SSE 缺口回归）", () => {
  it("流式 responses 原生直通 + 无 content-type LF 流：usage/firstToken 落库，客户端仍收完整流", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    // 关键：无 content-type 响应头（还原生产 Codex 上游形态），且 LF 无空行分帧。
    const fetcher = vi.fn().mockImplementation(async () => new Response(codexLfEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.4-mini",
      input: "hi",
      stream: true,
    }), "responses")

    expect(response.status).toBe(200)
    // 无头直通分支透传上游头（Codex 上游本就没有 content-type，网关不伪造；
    // 标准 SSE 分支才有 text/event-stream）。客户端照单收完整 SSE 文本。
    const text = await response.text()
    // 客户端完整流：remap 后 responses 事件 + 文本内容可达
    expect(text).toContain("response.completed")
    expect(text).toContain("hi")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getDatabase()).toBe(db)
    const row = db.prepare("SELECT status,outcome,ok,prompt_tokens,completion_tokens,total_tokens,cached_tokens,reasoning_tokens,first_token_ms,transform_summary,route_reason,upstream_endpoint FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.status).toBe(200)
    expect(row.outcome).toBe("SUCCESS")
    expect(row.ok).toBe(1)
    expect(row.prompt_tokens).toBe(12)
    expect(row.completion_tokens).toBe(6)
    expect(row.total_tokens).toBe(18)
    expect(row.cached_tokens).toBe(0)
    expect(row.reasoning_tokens).toBe(0)
    // 首个 output_text.delta 到达即打点（缓冲重放下为首包时间，非 null）
    expect(row.first_token_ms).not.toBeNull()
    expect(String(row.transform_summary || "")).toContain("responses-native")
    expect(String(row.transform_summary || "")).toContain("sse-sniff:no-content-type")
  })

  it("无头 SSE 在上游未结束前就增量透传早期 chunk", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const splitAt = codexLfEvents.indexOf('event: response.output_text.done')
    const early = codexLfEvents.slice(0, splitAt)
    const rest = codexLfEvents.slice(splitAt)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const encoder = new TextEncoder()
    const fetcher = vi.fn().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(early))
        void gate.then(() => {
          controller.enqueue(encoder.encode(rest))
          controller.close()
        })
      },
    }), { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.4-mini",
      input: "hi",
      stream: true,
    }), "responses")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    const first = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ])
    expect(first).not.toBeNull()
    expect((first as ReadableStreamReadResult<Uint8Array>).done).toBe(false)
    expect(new TextDecoder().decode((first as ReadableStreamReadResult<Uint8Array>).value)).toContain("response.output_text.delta")

    release()
    const chunks: Uint8Array[] = [(first as ReadableStreamReadResult<Uint8Array>).value!]
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    const text = new TextDecoder().decode(concat(chunks))
    expect(text).toContain("response.completed")
    const row = db.prepare("SELECT completion_tokens,total_tokens,first_token_ms,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.completion_tokens).toBe(6)
    expect(row.total_tokens).toBe(18)
    expect(row.first_token_ms).not.toBeNull()
    expect(String(row.transform_summary || "")).toContain("sse-sniff:no-content-type")
  })

  it("标准 JSON 直通（非 SSE）零回归：仍走 captureJsonResponse，usage 照常", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => Response.json({
      id: "resp_json_1", object: "response", status: "completed", model: "gpt-5.4-mini",
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
    }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.4-mini",
      input: "hi",
      stream: true,
    }), "responses")
    expect(response.status).toBe(200)
    await drain(response)
    const row = db.prepare("SELECT prompt_tokens,completion_tokens,total_tokens,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.prompt_tokens).toBe(12)
    expect(row.completion_tokens).toBe(6)
    expect(row.total_tokens).toBe(18)
    // 非 SSE 不打无头嗅探标签
    expect(String(row.transform_summary || "")).not.toContain("sse-sniff")
  })

  it("非流式 responses 原生直通 + 无头 SSE：聚合 completed 返回 JSON，usage 照常", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => new Response(codexLfEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.4-mini",
      input: "hi",
      stream: false,
    }), "responses")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const payload = await response.json() as Record<string, unknown>
    // responsesSseToJson 取 completed.response 原样（生产 Codex completed 的
    // response 无 object 字段，仅 id/status/model/output/usage），不断言 object。
    expect(payload).toMatchObject({ id: "resp_1", status: "completed" })
    expect(payload.usage).toMatchObject({ input_tokens: 12, output_tokens: 6, total_tokens: 18 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT prompt_tokens,completion_tokens,total_tokens,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.prompt_tokens).toBe(12)
    expect(row.completion_tokens).toBe(6)
    expect(row.total_tokens).toBe(18)
    expect(String(row.transform_summary || "")).toContain("sse-sniff:no-content-type")
    expect(String(row.transform_summary || "")).toContain("aggregate:sse-to-json")
  })

  it("标准 SSE 流（muse/glm 带 content-type 形态）零回归：仍走标准流分支", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_std","model":"gpt-5.4-mini"}}',
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      'data: {"type":"response.completed","response":{"id":"resp_std","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
      "data: [DONE]",
    ].join("\n\n")
    const fetcher = vi.fn().mockImplementation(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.4-mini",
      input: "hi",
      stream: true,
    }), "responses")
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("response.completed")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT prompt_tokens,completion_tokens,total_tokens,first_token_ms,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.prompt_tokens).toBe(3)
    expect(row.completion_tokens).toBe(2)
    expect(row.total_tokens).toBe(5)
    expect(row.first_token_ms).not.toBeNull()
    // 标准分支不打无头嗅探标签
    expect(String(row.transform_summary || "")).not.toContain("sse-sniff")
  })

  it("成功流式响应的响应体按既有策略处理：默认仅错误落盘（logBodies=false 全局设计）", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => new Response(codexLfEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.4-mini",
      input: "hi",
      stream: true,
    }), "responses")
    expect(response.status).toBe(200)
    await drain(response)
    // 默认 logBodies=false + logBodiesOnError=true：成功请求不写 request_bodies
    //（has_response 缺席 = 全局设计，非 codex 缺口；见 finalizeRequest/writeBodies）。
    const count = (db.prepare("SELECT COUNT(*) value FROM request_bodies").get() as { value: number }).value
    expect(count).toBe(0)
  })
})
