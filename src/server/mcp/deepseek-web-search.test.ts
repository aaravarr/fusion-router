import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CustomProviderRepository } from "@/server/custom-providers"
import { createDatabase, type AppDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { deepseekWebSearch } from "./deepseek-web-search"
import { ensureDefaultMcpTools, updateMcpTool } from "./mcp-tools"

const ownerUserId = "custom-owner"
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase; __opencodeApiAccountSchemaVersion?: number }).__opencodeApiDb = value
}

beforeEach(() => {
  db = createDatabase(":memory:")
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'USER', 'ACTIVE', 'hash', ?, ?)`,
  ).run(ownerUserId, "custom", "custom", "Custom", now, now)
  setGlobalDatabase(db)
  // 自定义 Provider：模拟 DeepSeek 官方（baseUrl 为根，/anthropic/v1/messages 拼在后面）
  const provider = new CustomProviderRepository(ownerUserId, db).create({
    name: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    interfaceType: "chat",
    models: ["deepseek-v4-flash"],
  })
  const account = new AccountRepository(ownerUserId, db).createProviderAccount({
    name: "deepseek key",
    poolType: provider.poolType,
  })
  new ProviderCredentialRepository(ownerUserId, db).upsert({
    accountId: account.id,
    poolType: provider.poolType,
    credentialData: { token: "sk-deepseek" },
  })
  ensureDefaultMcpTools(db)
  updateMcpTool("deepseek_web_search", {
    config: { provider: provider.poolType, model: "deepseek-v4-flash" },
  }, db)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setGlobalDatabase(undefined)
  db.close()
})

const ANTHROPIC_RESPONSE = {
  id: "msg-1",
  type: "message",
  role: "assistant",
  model: "deepseek-v4-flash",
  content: [
    { type: "thinking", thinking: "searching", signature: "s1" },
    { type: "server_tool_use", id: "call_1", name: "web_search", input: { query: "bitcoin price" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "call_1",
      content: [
        { type: "web_search_result", title: "CoinMarketCap", url: "https://coinmarketcap.com/currencies/bitcoin/" },
        { type: "web_search_result", title: "CNBC Quotes", url: "https://www.cnbc.com/quotes/BTC%3D-USS" },
      ],
    },
    { type: "text", text: "Bitcoin is trading at approximately **$65,000 USD**." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20 },
}

describe("deepseekWebSearch", () => {
  it("直连 Provider 的 Anthropic messages 端点并原样返回答案与搜索来源", async () => {
    const callGateway = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.deepseek.com/anthropic/v1/messages")
      expect(request.headers.get("x-api-key")).toBe("sk-deepseek")
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
      expect(request.headers.get("accept")).toBe("application/json")
      const body = JSON.parse(await request.text()) as {
        model: string
        max_tokens: number
        temperature: number
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
        tools: Array<{ type: string; name: string; max_uses: number }>
      }
      expect(body.model).toBe("deepseek-v4-flash")
      expect(body.max_tokens).toBe(1024)
      expect(body.temperature).toBe(0.3)
      expect(body.messages[0].content[0]).toEqual({ type: "text", text: "比特币当前价格是多少？" })
      expect(body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 3 }])
      return new Response(JSON.stringify(ANTHROPIC_RESPONSE), { status: 200 })
    })

    const result = await deepseekWebSearch(
      { content: "比特币当前价格是多少？" },
      db,
      { ownerUserId },
      callGateway,
    )
    expect(result.text).toContain("Bitcoin is trading at approximately **$65,000 USD**.")
    expect(result.text).toContain("搜索结果来源：")
    expect(result.text).toContain("1. CoinMarketCap — https://coinmarketcap.com/currencies/bitcoin/")
    expect(result.text).toContain("2. CNBC Quotes — https://www.cnbc.com/quotes/BTC%3D-USS")
    expect(result.model).toBe("deepseek-v4-flash")
    expect(result.accountName).toBe("deepseek key")
  })

  it("未配置 Provider 时报错（不按模型自动路由）", async () => {
    updateMcpTool("deepseek_web_search", { config: { provider: null } }, db)
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, vi.fn()),
    ).rejects.toThrow(/Provider/)
  })

  it("未配置模型时报错", async () => {
    updateMcpTool("deepseek_web_search", { config: { model: "" } }, db)
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, vi.fn()),
    ).rejects.toThrow(/模型/)
  })

  it("内容为空时报错", async () => {
    await expect(deepseekWebSearch({ content: "   " }, db, { ownerUserId }, vi.fn())).rejects.toThrow(/搜索/)
  })

  it("Provider 没有可用账号时报错", async () => {
    // 把所有账号置为无效
    db.prepare("UPDATE accounts SET auth_state='AUTH_ERROR'").run()
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, vi.fn()),
    ).rejects.toThrow(/没有可用账号/)
  })

  it("上游非 200 时抛出上游错误信息", async () => {
    const callGateway = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })
    })
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, callGateway),
    ).rejects.toThrow(/invalid x-api-key/)
  })

  it("响应既无文本也无搜索结果时报错", async () => {
    const callGateway = vi.fn(async () => {
      return new Response(JSON.stringify({ type: "message", content: [{ type: "thinking", thinking: "..." }] }), {
        status: 200,
      })
    })
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, callGateway),
    ).rejects.toThrow(/模型未返回内容/)
  })
})
