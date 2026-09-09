import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { AccountRepository, ApiKeyRepository, ProviderCredentialRepository } from "./repository"
import { GatewayService, type CredentialProvider } from "./gateway"
import { RoutingService } from "./routing"

const ownerUserId = "openai-schema-strict-owner"
const STRICT_TOOL = { type: "function", function: { name: "SendToUser", parameters: { type: "object", properties: { type: { type: "string" }, content: { type: "string" }, end_turn: { type: "boolean" } }, required: ["type"] } } }
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

function setupOpenAI() {
  db = createDatabase(":memory:")
  setGlobalDatabase(db)
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "schema-strict", "schema-strict", "Schema Strict", "USER", "hash", timestamp, timestamp)
  const account = new AccountRepository(ownerUserId, db).createProviderAccount({ name: "openai acct", poolType: "openai" })
  new ProviderCredentialRepository(ownerUserId, db).upsert({
    accountId: account.id,
    poolType: "openai",
    credentialData: { token: "at-test", chatgptAccountId: "acct-test", expiresAt: String(Math.floor(Date.now() / 1000) + 48 * 3600) },
  })
  const hasher = new ApiKeyHasher("test-pepper")
  const apiKey = new ApiKeyRepository(ownerUserId, db, hasher).create("test")
  const credentials: CredentialProvider = { async get() { throw new Error("legacy credentials should not be used for openai pool") } }
  new RoutingService(ownerUserId, db).setPreferred(account.id)
  return { apiKey: apiKey.key, credentials, hasher }
}

const request = (key: string, path: string, body: unknown) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => { vi.unstubAllGlobals(); setGlobalDatabase(undefined); db.close() })

describe("schema-strict gateway final upstream body", () => {
  it("responses 原生上行最终体收紧并记录补丁计数", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    let forwarded: Record<string, unknown> | undefined
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      forwarded = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "resp_strict", object: "response", model: "gpt-5.6-luna", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey, "/v1/responses", {
      model: "gpt-5.6-luna", input: "hi", stream: false, tools: [{ ...STRICT_TOOL }],
    }), "responses")
    expect(response.status).toBe(200)
    const tools = forwarded?.tools as Array<Record<string, unknown>>
    const parameters = tools[0].parameters as Record<string, unknown>
    expect(parameters.additionalProperties).toBeUndefined()
    expect((parameters.properties as Record<string, unknown>).additionalProperties).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = db.prepare("SELECT transform_summary FROM gateway_requests ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown>
    expect(String(row.transform_summary || "")).toContain("schema-strict:1")
  })

  it("chat→responses 转换后最终 tools 保留 properties 成员补丁", async () => {
    const { apiKey, credentials, hasher } = setupOpenAI()
    let forwarded: Record<string, unknown> | undefined
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      forwarded = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>
      return Response.json({ id: "resp_strict_chat", object: "response", model: "gpt-5.6-luna", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    })
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey, "/v1/chat/completions", {
      model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], stream: false, tools: [{ ...STRICT_TOOL }],
    }), "chat/completions")
    expect(response.status).toBe(200)
    const tools = forwarded?.tools as Array<Record<string, unknown>>
    const parameters = tools[0].parameters as Record<string, unknown>
    expect(parameters.additionalProperties).toBeUndefined()
    expect((parameters.properties as Record<string, unknown>).additionalProperties).toBe(false)
  })
})
