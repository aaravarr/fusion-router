import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import { webSearch, webSearchStream } from "./web-search"
import { ensureDefaultMcpTools, updateMcpTool } from "./mcp-tools"

let db: AppDatabase

beforeEach(() => {
  db = createDatabase(":memory:")
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at)
     VALUES ('admin-1', 'admin', 'admin', '管理员', 'ADMIN', 'ACTIVE', 'hash', ?, ?)`,
  ).run(now, now)
  ensureDefaultMcpTools(db)
  updateMcpTool("web_search", { config: { model: "deepseek-v4" } }, db)
})

afterEach(() => {
  db.close()
})

describe("webSearch", () => {
  it("通过注入的 callGateway 构造 responses body 并提取 output 文本", async () => {
    const callGateway = vi.fn(async (request: Request, endpoint: string) => {
      expect(endpoint).toBe("responses")
      const body = JSON.parse(await request.text()) as {
        model: string
        stream: boolean
        input: Array<{ role: string; content: Array<{ type: string; text: string }> }>
        tools: Array<{ type: string }>
        max_output_tokens: number
        temperature: number
        reasoning: { effort: string }
      }
      expect(body.model).toBe("deepseek-v4")
      expect(body.stream).toBe(false)
      expect(body.input).toEqual([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "请基于联网搜索结果回答用户的问题，并注明信息来源。\n\n用中文回答\n\n今天天气怎么样？",
            },
          ],
        },
      ])
      expect(body.tools).toEqual([{ type: "web_search" }])
      expect(body.max_output_tokens).toBe(2048)
      expect(body.temperature).toBe(0.3)
      expect(body.reasoning).toEqual({ effort: "none" })
      return new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          output: [
            { id: "reasoning_1", type: "reasoning", status: "completed", summary: [] },
            {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "今天天气", sources: [] },
            },
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "根据搜索结果，今天晴。" }],
            },
          ],
        }),
        { status: 200 },
      )
    })

    const result = await webSearch(
      { query: "今天天气怎么样？", prompt: "用中文回答" },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    // 只拼接 message item 的 text，跳过 reasoning / web_search_call
    expect(result).toEqual({ text: "根据搜索结果，今天晴。", model: "deepseek-v4", accountName: null })
  })

  it("开启思考且未指定 effort 时默认 medium，指定 low 时透传", async () => {
    updateMcpTool("web_search", { config: { reasoningEnabled: true } }, db)
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning: { effort: string } }
      expect(body.reasoning).toEqual({ effort: "medium" })
      return new Response(
        JSON.stringify({
          output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: "回答" }] }],
        }),
        { status: 200 },
      )
    })
    await webSearch({ query: "问题" }, db, { ownerUserId: "user-1" }, callGateway)

    updateMcpTool("web_search", { config: { reasoningEffort: "low" } }, db)
    const lowGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning: { effort: string } }
      expect(body.reasoning).toEqual({ effort: "low" })
      return new Response(
        JSON.stringify({
          output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: "回答" }] }],
        }),
        { status: 200 },
      )
    })
    await webSearch({ query: "问题" }, db, { ownerUserId: "user-1" }, lowGateway)
  })

  it("响应非 ok 时抛出上游错误", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "搜索额度不足" } }), { status: 402 }),
    )
    await expect(
      webSearch({ query: "问题" }, db, { ownerUserId: "user-1" }, callGateway),
    ).rejects.toThrow("搜索额度不足")
  })

  it("模型未返回内容时报错", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ output: [{ id: "msg_1", type: "message", content: [] }] }), { status: 200 }),
    )
    await expect(
      webSearch({ query: "问题" }, db, { ownerUserId: "user-1" }, callGateway),
    ).rejects.toThrow("模型未返回内容")
  })

  it("未配置模型时报错", async () => {
    updateMcpTool("web_search", { config: { model: "" } }, db)
    await expect(
      webSearch({ query: "问题" }, db, { ownerUserId: "user-1" }, vi.fn()),
    ).rejects.toThrow("尚未配置搜索模型")
  })

  it("未指定调用用户时报错", async () => {
    await expect(
      webSearch({ query: "问题" }, db, { ownerUserId: "" }, vi.fn()),
    ).rejects.toThrow("未指定调用用户")
  })
})

describe("webSearchStream", () => {
  async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text()
  }

  it("上游 SSE 时转发 output_text.delta 并忽略 reasoning_text.delta", async () => {
    const encoder = new TextEncoder()
    const sseBody = [
      'data: {"type":"response.reasoning_text.delta","item_id":"reasoning_1","output_index":0,"content_index":0,"delta":"思考中"}',
      "",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"你好"}',
      "",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"世界"}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n")
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { stream: boolean }
      expect(body.stream).toBe(true)
      return new Response(encoder.encode(sseBody), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    })

    const stream = await webSearchStream({ query: "问题", prompt: "补充" }, db, { ownerUserId: "user-1" }, 42, callGateway)
    const text = await streamText(stream)
    expect(text).toContain('"content":[]')
    expect(text).toContain('"method":"notifications/content_block_start"')
    expect(text).toContain('"method":"notifications/content_block_delta"')
    expect(text).toContain('"text":"你好"')
    expect(text).toContain('"text":"世界"')
    expect(text).not.toContain("思考中")
    expect(text).toContain('"method":"notifications/content_block_stop"')
    expect(text).toContain('"id":42')
  })

  it("上游返回 JSON 全文时一次性发出 delta", async () => {
    const callGateway = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: "根据搜索结果回答" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const stream = await webSearchStream({ query: "问题" }, db, { ownerUserId: "user-1" }, "req-1", callGateway)
    const text = await streamText(stream)
    expect(text).toContain('"text":"根据搜索结果回答"')
    expect(text).toContain('"method":"notifications/content_block_stop"')
  })

  it("上游响应非 ok 时在流内输出错误信息", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "搜索额度不足" } }), { status: 402 }),
    )
    const stream = await webSearchStream({ query: "问题" }, db, { ownerUserId: "user-1" }, 1, callGateway)
    const text = await streamText(stream)
    expect(text).toContain("搜索额度不足")
    expect(text).toContain('"method":"notifications/content_block_stop"')
  })
})
