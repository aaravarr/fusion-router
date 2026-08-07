import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CustomProviderRepository } from "@/server/custom-providers"
import { createDatabase, type AppDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { cleanSearchUrl, deepseekWebSearch, parseResponsesSearchResult } from "./deepseek-web-search"
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
  // 自定义 Provider：模拟 DeepSeek 官方（baseUrl 为根，/responses 拼在后面）
  const provider = new CustomProviderRepository(ownerUserId, db).create({
    name: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    interfaceType: "responses",
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

const RESPONSES_PAYLOAD = {
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "deepseek-v4-flash",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "bitcoin price" },
    },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Bitcoin is trading at approximately **$65,000 USD**.",
          annotations: [
            {
              type: "url_citation",
              title: "CoinMarketCap",
              url: "https://coinmarketcap.com/currencies/bitcoin/",
            },
            {
              type: "url_citation",
              title: "CNBC Quotes",
              url: "https://www.cnbc.com/quotes/BTC%3D-USS",
            },
          ],
        },
      ],
    },
  ],
}

describe("cleanSearchUrl", () => {
  it("去掉 DeepSeek open_page 的 ws_call_id 碎片", () => {
    expect(
      cleanSearchUrl("https://example.com/a#ws_call_id=call_01_abc"),
    ).toBe("https://example.com/a")
  })
})

describe("parseResponsesSearchResult", () => {
  it("提取 output_text 与 url_citation 来源", () => {
    const parsed = parseResponsesSearchResult(RESPONSES_PAYLOAD)
    expect(parsed.answer).toBe("Bitcoin is trading at approximately **$65,000 USD**.")
    expect(parsed.results).toEqual([
      { title: "CoinMarketCap", url: "https://coinmarketcap.com/currencies/bitcoin/" },
      { title: "CNBC Quotes", url: "https://www.cnbc.com/quotes/BTC%3D-USS" },
    ])
  })

  it("多轮 message 时取最后一条作为答案，并收集 open_page URL", () => {
    const parsed = parseResponsesSearchResult({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "我来帮你搜索。" }],
        },
        {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://news.example.com/deepseek#ws_call_id=call_01_x",
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "最终汇总：DeepSeek 发布了 V4-Flash。" }],
        },
      ],
    })
    expect(parsed.answer).toBe("最终汇总：DeepSeek 发布了 V4-Flash。")
    expect(parsed.results).toEqual([
      { title: "https://news.example.com/deepseek", url: "https://news.example.com/deepseek" },
    ])
  })
})

describe("deepseekWebSearch", () => {
  it("直连 Provider 的 Responses 端点并原样返回答案与搜索来源", async () => {
    const callGateway = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.deepseek.com/responses")
      expect(request.headers.get("authorization")).toBe("Bearer sk-deepseek")
      expect(request.headers.get("accept")).toBe("application/json")
      expect(request.headers.get("anthropic-version")).toBeNull()
      const body = JSON.parse(await request.text()) as {
        model: string
        max_output_tokens: number
        temperature: number
        instructions?: string
        input: string
        tools: Array<{ type: string }>
        tool_choice?: unknown
        max_tool_calls?: number
        reasoning?: { effort: string }
      }
      expect(body.model).toBe("deepseek-v4-flash")
      expect(body.max_output_tokens).toBe(1024)
      expect(body.temperature).toBe(0.3)
      expect(body.input).toBe("比特币当前价格是多少？")
      expect(body.tools).toEqual([{ type: "web_search" }])
      // 强制 tool_choice=web_search 在 DeepSeek 上会导致只有搜索调用、无最终 message
      expect(body.tool_choice).toBeUndefined()
      expect(typeof body.instructions).toBe("string")
      expect(body.instructions).toMatch(/web_search/)
      expect(body.max_tool_calls).toBe(5)
      expect(body.reasoning).toEqual({ effort: "high" })
      return new Response(JSON.stringify(RESPONSES_PAYLOAD), { status: 200 })
    })

    updateMcpTool("deepseek_web_search", {
      config: { reasoningEffort: "high", maxToolCalls: 5 },
    }, db)

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
    db.prepare("UPDATE accounts SET auth_state='AUTH_ERROR'").run()
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, vi.fn()),
    ).rejects.toThrow(/没有可用账号/)
  })

  it("上游非 200 时抛出上游错误信息", async () => {
    const callGateway = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })
    })
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, callGateway),
    ).rejects.toThrow(/invalid api key/)
  })

  it("响应既无文本也无搜索结果时报错", async () => {
    const callGateway = vi.fn(async () => {
      return new Response(JSON.stringify({ output: [{ type: "reasoning", summary: [] }] }), {
        status: 200,
      })
    })
    await expect(
      deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, callGateway),
    ).rejects.toThrow(/模型未返回内容/)
  })

  it("仅有 web_search_call 无 message 时，仍可通过 open_page URL 返回来源", async () => {
    const callGateway = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              action: {
                type: "open_page",
                url: "https://example.com/news#ws_call_id=call_00_x",
              },
            },
          ],
        }),
        { status: 200 },
      )
    })
    const result = await deepseekWebSearch({ content: "测试" }, db, { ownerUserId }, callGateway)
    expect(result.text).toContain("搜索结果来源：")
    expect(result.text).toContain("https://example.com/news")
    expect(result.text).not.toContain("ws_call_id")
  })
})
