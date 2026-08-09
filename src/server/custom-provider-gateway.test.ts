import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiKeyHasher } from "./crypto"
import { CustomProviderRepository } from "./custom-providers"
import { createDatabase, getDatabase, type AppDatabase } from "./db"
import { GatewayService, type CredentialProvider } from "./gateway"
import { AccountRepository, ApiKeyRepository, ProviderCredentialRepository } from "./repository"
import { syncProviderAccount } from "./provider-sync"
import { syncProviderModels } from "./provider-models"

const ownerUserId = "custom-owner"
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase; __opencodeApiAccountSchemaVersion?: number }).__opencodeApiDb = value
}

beforeEach(() => {
  db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "custom", "custom", "Custom", "USER", "hash", timestamp, timestamp)
  setGlobalDatabase(db)
  expect(getDatabase()).toBe(db)
})

afterEach(() => { vi.unstubAllGlobals(); setGlobalDatabase(undefined); db.close() })

function setup(interfaceTypes: Array<"chat" | "responses" | "messages">) {
  const provider = new CustomProviderRepository(ownerUserId, db).create({ name: `${interfaceTypes.join("+")} upstream`, baseUrl: "https://custom.example.com/v1", interfaceTypes, models: ["custom-model"] })
  const accounts = new AccountRepository(ownerUserId, db)
  const account = accounts.createProviderAccount({ name: "key one", poolType: provider.poolType })
  new ProviderCredentialRepository(ownerUserId, db).upsert({ accountId: account.id, poolType: provider.poolType, credentialData: { token: "sk-custom" } })
  expect(new ProviderCredentialRepository(ownerUserId).get(account.id)).toMatchObject({ token: "sk-custom" })
  const hasher = new ApiKeyHasher("custom-pepper")
  const apiKey = new ApiKeyRepository(ownerUserId, db, hasher).create("gateway").key
  const credentials: CredentialProvider = { async get() { throw new Error("legacy credentials should not be used") } }
  return { apiKey, hasher, credentials }
}

describe("custom provider gateway protocol", () => {
  it("discovers models from /models when no fixed list is configured", async () => {
    const provider = new CustomProviderRepository(ownerUserId, db).create({ name: "discover upstream", baseUrl: "https://discover.example.com/v1", interfaceTypes: ["responses"] })
    const accounts = new AccountRepository(ownerUserId, db)
    const account = accounts.createProviderAccount({ name: "discovery key", poolType: provider.poolType })
    new ProviderCredentialRepository(ownerUserId, db).upsert({ accountId: account.id, poolType: provider.poolType, credentialData: { token: "model-key" } })
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] }))
    vi.stubGlobal("fetch", fetcher)
    const catalog = await syncProviderModels({ poolType: provider.poolType, ownerUserId, accountId: account.id, db })
    expect(catalog.models).toEqual(["model-a", "model-b"])
    expect(fetcher.mock.calls[0][0]).toBe("https://discover.example.com/v1/models")
  })

  it("stores permanent, 5h, weekly, monthly and custom-period balance windows for scheduling", async () => {
    const provider = new CustomProviderRepository(ownerUserId, db).create({
      name: "multi balance", baseUrl: "https://quota.example.com/v1", interfaceTypes: ["responses"], models: ["custom-model"],
      balanceConfig: { request: { url: "{{baseUrl}}/balance" }, extractor: `function(response) { return { isValid: true, windows: [
        { type: "permanent", remaining: response.balance, unit: "USD" },
        { type: "5h", remaining: 4, total: 5, resetAt: "2030-01-01T00:00:00.000Z" },
        { type: "weekly", remaining: 6, total: 10 },
        { type: "monthly", remaining: 20, total: 100 },
        { type: "period", remaining: 2, total: 3, periodSeconds: 3600 }
      ] }; }` },
    })
    const accounts = new AccountRepository(ownerUserId, db)
    const account = accounts.createProviderAccount({ name: "quota key", poolType: provider.poolType })
    new ProviderCredentialRepository(ownerUserId, db).upsert({ accountId: account.id, poolType: provider.poolType, credentialData: { token: "quota-key" } })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ balance: 42.5 })))
    await syncProviderAccount(ownerUserId, account.id, db)
    const rows = db.prepare("SELECT kind,remaining_value,unit FROM quota_windows WHERE account_id=? ORDER BY kind").all(account.id) as Array<{ kind: string; remaining_value: number; unit: string | null }>
    expect(rows.map((row) => row.kind)).toEqual(["CUSTOM_PERIOD", "FIVE_HOUR", "MONTHLY", "PERMANENT", "WEEKLY"])
    expect(rows.find((row) => row.kind === "PERMANENT")).toMatchObject({ remaining_value: 42.5, unit: "USD" })
  })

  it("removes a key from scheduling when the balance extractor marks it invalid", async () => {
    const provider = new CustomProviderRepository(ownerUserId, db).create({
      name: "balance upstream", baseUrl: "https://balance.example.com/v1", interfaceTypes: ["responses"], models: ["custom-model"],
      balanceConfig: { request: { url: "{{baseUrl}}/balance", headers: { Authorization: "Bearer {{apiKey}}" } }, extractor: "function(response) { return { isValid: response.active, remaining: response.balance, type: 'permanent' }; }" },
    })
    const accounts = new AccountRepository(ownerUserId, db)
    const account = accounts.createProviderAccount({ name: "invalid key", poolType: provider.poolType })
    new ProviderCredentialRepository(ownerUserId, db).upsert({ accountId: account.id, poolType: provider.poolType, credentialData: { token: "bad-key" } })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ active: false, balance: 0 })))
    await expect(syncProviderAccount(ownerUserId, account.id, db)).rejects.toThrow(/凭据无效/)
    expect(accounts.get(account.id)).toMatchObject({ authState: "REAUTH_REQUIRED" })
  })

  it("serves an inbound Responses request through a chat-only provider", async () => {
    const { apiKey, hasher, credentials } = setup(["chat"])
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "chat_1", object: "chat.completion", model: "custom-model", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }))
    const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "custom-model", input: "hi" }) })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request, "responses")
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetcher.mock.calls[0][0]).toBe("https://custom.example.com/v1/chat/completions")
    const body = JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)) as { messages?: unknown[] }
    expect(body.messages?.length).toBeGreaterThan(0)
    expect(await response.json()).toMatchObject({ object: "response", output: expect.any(Array) })
  })

  it("serves an inbound Chat request through a responses-only provider", async () => {
    const { apiKey, hasher, credentials } = setup(["responses"])
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "resp_1", model: "custom-model", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }))
    const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "custom-model", messages: [{ role: "user", content: "hi" }] }) })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request, "chat/completions")
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetcher.mock.calls[0][0]).toBe("https://custom.example.com/v1/responses")
    const body = JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)) as { input?: unknown[] }
    expect(body.input).toEqual([{ role: "user", content: "hi" }])
    expect(await response.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "hello" } }] })
  })

  it("serves an inbound Messages request through a chat-only provider", async () => {
    const { apiKey, hasher, credentials } = setup(["chat"])
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "chatcmpl-1", object: "chat.completion", model: "custom-model", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-model", max_tokens: 64, system: "be nice", messages: [{ role: "user", content: "hi" }] }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request, "messages")
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetcher.mock.calls[0][0]).toBe("https://custom.example.com/v1/chat/completions")
    const body = JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)) as { messages?: unknown[] }
    expect(body.messages).toEqual([{ role: "system", content: "be nice" }, { role: "user", content: "hi" }])
    expect(await response.json()).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 2, output_tokens: 1 } })
  })

  it("serves an inbound Messages request through a responses-only provider via the chat relay", async () => {
    const { apiKey, hasher, credentials } = setup(["responses"])
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "resp_1", model: "custom-model", output: [{ type: "message", content: [{ type: "output_text", text: "hi there" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }))
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-model", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request, "messages")
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetcher.mock.calls[0][0]).toBe("https://custom.example.com/v1/responses")
    const body = JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)) as { input?: unknown[] }
    expect(body.input).toEqual([{ role: "user", content: "hi" }])
    expect(await response.json()).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "hi there" }] })
  })

  it("passes an inbound Messages request through natively when the provider declares messages", async () => {
    const { apiKey, hasher, credentials } = setup(["messages", "chat"])
    const anthropic = { id: "msg_1", type: "message", role: "assistant", model: "custom-model", content: [{ type: "text", text: "native" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
    const fetcher = vi.fn().mockResolvedValue(Response.json(anthropic))
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-model", max_tokens: 64, system: "be nice", messages: [{ role: "user", content: "hi" }] }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request, "messages")
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetcher.mock.calls[0][0]).toBe("https://custom.example.com/v1/messages")
    // 原生直通：请求体未转成 chat（system 字段原样保留）
    const body = JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)) as { system?: string; messages?: unknown[] }
    expect(body.system).toBe("be nice")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    expect(await response.json()).toMatchObject({ id: "msg_1", type: "message", content: [{ type: "text", text: "native" }] })
  })

  it("converts an upstream chat SSE stream into an Anthropic Messages event stream", async () => {
    const { apiKey, hasher, credentials } = setup(["chat"])
    const chunks = [
      'data: {"id":"c1","model":"custom-model","choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]
    const fetcher = vi.fn().mockResolvedValue(new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } }))
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-model", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request, "messages")
    expect(response.status, await response.clone().text()).toBe(200)
    // 转换后的 chat 请求注入 stream_options 以便拿到 usage
    const sent = JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)) as { stream_options?: unknown }
    expect(sent.stream_options).toEqual({ include_usage: true })
    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain('"type":"text_delta"')
    expect(text).toContain("event: message_delta")
    expect(text).toContain("event: message_stop")
  })
})
