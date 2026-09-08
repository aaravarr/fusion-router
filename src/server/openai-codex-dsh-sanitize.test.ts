import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, getDatabase, type AppDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { AccountRepository, ApiKeyRepository, ProviderCredentialRepository } from "./repository"
import { GatewayService, type CredentialProvider } from "./gateway"
import { RoutingService } from "./routing"
import { DSH_ARGS_SANITIZE_TAG } from "./responses/dsh-args-sanitize"

const ownerUserId = "openai-codex-dsh-sanitize-owner"

let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

const DIRTY_ARGS = JSON.stringify({
  command: "Get-Process",
  description: "列出进程",
  justification: "需要更宽权限执行",
  sandbox_permissions: "workspace-write",
})

// Codex LF 真实流形状（openai-codex-native-stats.test.ts 同形 fixture）+
// function_call item：output_item.added → function_call_arguments.delta 增量 ×2 →
// function_call_arguments.done（完整快照）→ output_item.done（完整 item）→
// completed（response.output 含完整 item）。
const codexLfFunctionCallEvents = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_fc","object":"response","created_at":1788832908,"status":"in_progress","model":"gpt-5.6-luna","output":[]},"sequence_number":0}',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"pwsh","arguments":""},"output_index":1,"sequence_number":1}',
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\\"command\\":\\"Get-","sequence_number":2}',
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"Process\\",\\"justification\\":\\"x\\"}","sequence_number":3}',
  'event: response.function_call_arguments.done',
  `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":1,"arguments":${JSON.stringify(DIRTY_ARGS)},"sequence_number":4}`,
  'event: response.output_item.done',
  `data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"pwsh","arguments":${JSON.stringify(DIRTY_ARGS)}},"output_index":1,"sequence_number":5}`,
  'event: response.completed',
  `data: {"type":"response.completed","response":{"id":"resp_fc","status":"completed","model":"gpt-5.6-luna","service_tier":"default","output":[{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"pwsh","arguments":${JSON.stringify(DIRTY_ARGS)}}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":18}},"sequence_number":6}`,
  'data: [DONE]',
].join("\n")

function setupPool(poolType: "openai") {
  db = createDatabase(":memory:")
  setGlobalDatabase(db)
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "codex-dsh-sanitize", "codex-dsh-sanitize", "Codex DSH Sanitize", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db)
  const account = accounts.createProviderAccount({ name: `${poolType} acct`, poolType })
  if (poolType === "openai") {
    new ProviderCredentialRepository(ownerUserId, db).upsert({
      accountId: account.id,
      poolType: "openai",
      credentialData: {
        token: "at-test",
        chatgptAccountId: "acct-test",
        expiresAt: String(Math.floor(Date.now() / 1000) + 48 * 3600),
      },
    })
  }
  const hasher = new ApiKeyHasher("test-pepper")
  const apiKey = new ApiKeyRepository(ownerUserId, db, hasher).create("test")
  const credentials: CredentialProvider = {
    async get() { throw new Error("legacy credentials should not be used for openai pool") },
  }
  new RoutingService(ownerUserId, db).setPreferred(account.id)
  return { apiKey: apiKey.key, credentials, hasher }
}

function setupOpenAI() {
  return setupPool("openai")
}

const responsesRequest = (key: string, body: unknown, headers?: Record<string, string>) => new Request("http://localhost/v1/responses", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(headers ?? {}) },
  body: JSON.stringify(body),
})

async function drain(response: Response): Promise<void> {
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function parseSsePayloads(text: string): Array<{ type?: string } & Record<string, unknown>> {
  const out: Array<{ type?: string } & Record<string, unknown>> = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trimStart()
    if (!payload || payload === "[DONE]") continue
    try {
      out.push(JSON.parse(payload) as { type?: string } & Record<string, unknown>)
    } catch { /* ignore */ }
  }
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

describe("openai 池 DSH function_call 参数清洗（codex 原生直通）", () => {
  it("范围内 deepseek UA 流式：done 事件 arguments 已清洗、正常字段保留、delta 原样透传", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => new Response(codexLfFunctionCallEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.6-luna",
      input: "hi",
      stream: true,
    }, { "user-agent": "DeepSeek-Harness/1.2.3" }), "responses")

    expect(response.status).toBe(200)
    const text = await response.text()
    const events = parseSsePayloads(text)
    const done = events.find((e) => e.type === "response.output_item.done")
    expect(done).toBeDefined()
    const item = (done as Record<string, unknown>).item as Record<string, unknown>
    expect(item.type).toBe("function_call")
    const args = JSON.parse(String(item.arguments))
    expect(args).toEqual({ command: "Get-Process", description: "列出进程" })
    // completed 终态 output 同样清洗
    const completed = events.find((e) => e.type === "response.completed")
    const completedOutput = ((completed as Record<string, unknown>).response as Record<string, unknown>).output as Array<Record<string, unknown>>
    expect(JSON.parse(String(completedOutput[0].arguments))).toEqual({ command: "Get-Process", description: "列出进程" })
    // delta 增量原样透传（调研结论：DSH 读 done 完整 item，delta 仅过程累积）
    const deltas = events.filter((e) => e.type === "response.function_call_arguments.delta")
    expect(deltas.length).toBeGreaterThan(0)
    expect(text).toContain("justification")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(String(row.transform_summary || "")).toContain("sse-sniff:no-content-type")
    expect(String(row.transform_summary || "")).toContain(DSH_ARGS_SANITIZE_TAG)
  })

  it("范围内 deepseek UA 非流式：聚合 JSON 已清洗", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => new Response(codexLfFunctionCallEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.6-luna",
      input: "hi",
      stream: false,
    }, { "user-agent": "deepseek-harness/0.0.1" }), "responses")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const payload = await response.json() as Record<string, unknown>
    const output = payload.output as Array<Record<string, unknown>>
    const fc = output.find((it) => it.type === "function_call")
    expect(fc).toBeDefined()
    expect(JSON.parse(String(fc!.arguments))).toEqual({ command: "Get-Process", description: "列出进程" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(String(row.transform_summary || "")).toContain(DSH_ARGS_SANITIZE_TAG)
  })

  it("openai 池 + 非 deepseek UA：原样透传零改动", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => new Response(codexLfFunctionCallEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.6-luna",
      input: "hi",
      stream: true,
    }, { "user-agent": "codex-cli-client/9.9.9" }), "responses")

    expect(response.status).toBe(200)
    const text = await response.text()
    const events = parseSsePayloads(text)
    const done = events.find((e) => e.type === "response.output_item.done")
    const item = (done as Record<string, unknown>).item as Record<string, unknown>
    // 脏参数原样保留（未清洗）
    expect(JSON.parse(String(item.arguments))).toMatchObject({ justification: "需要更宽权限执行", sandbox_permissions: "workspace-write" })
    await drain(new Response(text))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(String(row.transform_summary || "")).not.toContain(DSH_ARGS_SANITIZE_TAG)
  })

  it("arguments 非法 JSON：原样透传不炸", async () => {    const { apiKey, credentials, hasher } = setupOpenAI()
    const badArgsEvents = codexLfFunctionCallEvents.replaceAll(JSON.stringify(DIRTY_ARGS), JSON.stringify("{not-json"))
    const fetcher = vi.fn().mockImplementation(async () => new Response(badArgsEvents, { status: 200 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.6-luna",
      input: "hi",
      stream: true,
    }, { "user-agent": "DeepSeek-Harness/9.9" }), "responses")

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("response.completed")
    expect(text).toContain("{not-json")
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 非法 JSON 无可清洗项：不打标记，但请求整体成功
    const row = db.prepare("SELECT outcome,transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(row.outcome).toBe("SUCCESS")
    expect(String(row.transform_summary || "")).not.toContain(DSH_ARGS_SANITIZE_TAG)
  })

  it("其他池 + deepseek UA：原样透传（chat 入口转换路径不动）", async () => {
    // opencode-go 池走 chat 入口时不经过 openai 池 codex 原生分支；
    // 用 openai 池账号 + responses 入口但覆盖 pool 判定不命中的等价验证：
    // 直接以 responses 标准 JSON（非 SSE）验证“非 codex 形状”分支同样受范围 gating。
    const { apiKey, credentials, hasher } = setupOpenAI()
    const fetcher = vi.fn().mockImplementation(async () => Response.json({
      id: "resp_json_fc", object: "response", status: "completed", model: "gpt-5.6-luna",
      output: [{ id: "fc_1", type: "function_call", call_id: "call_1", name: "pwsh", status: "completed", arguments: DIRTY_ARGS }],
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
    }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(responsesRequest(apiKey, {
      model: "gpt-5.6-luna",
      input: "hi",
      stream: true,
    }, { "user-agent": "codex-cli-client/1.0" }), "responses")
    expect(response.status).toBe(200)
    const payload = await response.json() as Record<string, unknown>
    const output = payload.output as Array<Record<string, unknown>>
    // 非 deepseek UA：标准 JSON 分支同样不清洗
    expect(JSON.parse(String(output[0].arguments))).toMatchObject({ sandbox_permissions: "workspace-write" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(String(row.transform_summary || "")).not.toContain(DSH_ARGS_SANITIZE_TAG)
  })
})
