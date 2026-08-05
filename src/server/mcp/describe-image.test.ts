import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import { describeImage, describeImageStream, normalizeImageInput } from "./describe-image"
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
  updateMcpTool("describe_image", { config: { model: "grok-4" } }, db)
})

afterEach(() => {
  db.close()
})

describe("normalizeImageInput", () => {
  it("接受 http/https 与 data URI", () => {
    expect(normalizeImageInput("  https://example.com/a.png  ")).toBe("https://example.com/a.png")
    expect(normalizeImageInput("http://example.com/a.png")).toBe("http://example.com/a.png")
    expect(normalizeImageInput("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
    expect(normalizeImageInput("DATA:IMAGE/JPEG;BASE64,AAAA")).toBe("DATA:IMAGE/JPEG;BASE64,AAAA")
  })

  it("拒绝非法输入", () => {
    expect(() => normalizeImageInput("/tmp/a.png")).toThrow(/http\(s\)|data:image/)
    expect(() => normalizeImageInput("ftp://example.com/a.png")).toThrow(/http\(s\)|data:image/)
    expect(() => normalizeImageInput("a.png")).toThrow(/http\(s\)|data:image/)
  })
})

describe("describeImage", () => {
  it("通过注入的 callGateway 返回模型内容", async () => {
    const callGateway = vi.fn(async (request: Request, endpoint: string) => {
      expect(endpoint).toBe("chat/completions")
      const body = JSON.parse(await request.text()) as {
        model: string
        stream: boolean
        max_tokens: number
        temperature: number
        messages: Array<{
          role: string
          content: Array<{ type: string; text?: string; image_url?: { url: string } }>
        }>
      }
      expect(body.model).toBe("grok-4")
      expect(body.stream).toBe(false)
      expect(body.max_tokens).toBe(1024)
      expect(body.temperature).toBe(0.3)
      expect(body.messages[0].content[0]).toEqual({ type: "text", text: "请描述这张图片的内容" })
      expect(body.messages[0].content[1]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/a.png" },
      })
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })

    const result = await describeImage(
      { images: ["https://example.com/a.png"], prompt: "请描述这张图片的内容" },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result).toEqual({ text: "画面中有一只橘猫", model: "grok-4", accountName: null })
  })

  it("开启思考并选择 low 时透传 reasoning_effort", async () => {
    updateMcpTool(
      "describe_image",
      { config: { reasoningEnabled: true, reasoningEffort: "low" } },
      db,
    )
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning_effort?: string }
      expect(body.reasoning_effort).toBe("low")
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })
    const result = await describeImage(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("画面中有一只橘猫")
  })

  it("未开启思考时对非 MiniMax 模型显式传 reasoning_effort=none", async () => {
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning_effort?: string; thinking?: { type: string } }
      expect(body.reasoning_effort).toBe("none")
      expect(body.thinking).toBeUndefined()
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })
    const result = await describeImage(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("画面中有一只橘猫")
  })

  it("未开启思考时对 MiniMax 模型显式传 thinking=disabled", async () => {
    updateMcpTool("describe_image", { config: { model: "minimax-m3" } }, db)
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning_effort?: string; thinking?: { type: string } }
      expect(body.thinking).toEqual({ type: "disabled" })
      expect(body.reasoning_effort).toBeUndefined()
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })
    const result = await describeImage(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("画面中有一只橘猫")
  })

  it("开启思考时对 MiniMax 模型传 thinking=adaptive", async () => {
    updateMcpTool(
      "describe_image",
      { config: { model: "minimax-m3", reasoningEnabled: true, reasoningEffort: "low" } },
      db,
    )
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning_effort?: string; thinking?: { type: string } }
      expect(body.thinking).toEqual({ type: "adaptive" })
      expect(body.reasoning_effort).toBeUndefined()
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })
    const result = await describeImage(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("画面中有一只橘猫")
  })

  it("开启思考但未指定等级时不透传 reasoning_effort", async () => {
    updateMcpTool("describe_image", { config: { reasoningEnabled: true, reasoningEffort: null } }, db)
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as { reasoning_effort?: string }
      expect(body.reasoning_effort).toBeUndefined()
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })
    const result = await describeImage(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("画面中有一只橘猫")
  })

  it("多图同时输入时生成多个 image_url part", async () => {
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as {
        messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
      }
      expect(body.messages[0].content).toHaveLength(3)
      expect(body.messages[0].content[0]).toEqual({ type: "text", text: "对比这两张图" })
      expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "https://example.com/a.png" } })
      expect(body.messages[0].content[2]).toEqual({ type: "image_url", image_url: { url: "https://example.com/b.png" } })
      return new Response(JSON.stringify({ choices: [{ message: { content: "图 A 是猫，图 B 是狗" } }] }), {
        status: 200,
      })
    })
    const result = await describeImage(
      { images: ["https://example.com/a.png", "https://example.com/b.png"], prompt: "对比这两张图" },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("图 A 是猫，图 B 是狗")
  })

  it("未配置模型时报错", async () => {
    updateMcpTool("describe_image", { config: { model: "" } }, db)
    await expect(
      describeImage({
      images: ["https://example.com/a.png"],
    }, db, { ownerUserId: "user-1" }, vi.fn()),
    ).rejects.toThrow("尚未配置识图模型")
  })

  it("不传 prompt 且未配置默认提示词时 content 只含 image_url", async () => {
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as {
        messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
      }
      expect(body.messages[0].content).toHaveLength(1)
      expect(body.messages[0].content[0]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/a.png" },
      })
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })

    const result = await describeImage(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("画面中有一只橘猫")
  })

  it("传 prompt 时有 text 与 image_url", async () => {
    const callGateway = vi.fn(async (request: Request) => {
      const body = JSON.parse(await request.text()) as {
        messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
      }
      expect(body.messages[0].content).toHaveLength(2)
      expect(body.messages[0].content[0]).toEqual({ type: "text", text: "这只猫在做什么？" })
      expect(body.messages[0].content[1]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/a.png" },
      })
      return new Response(JSON.stringify({ choices: [{ message: { content: "猫在睡觉" } }] }), {
        status: 200,
      })
    })

    const result = await describeImage(
      { images: ["https://example.com/a.png"], prompt: "这只猫在做什么？" },
      db,
      { ownerUserId: "user-1" },
      callGateway,
    )
    expect(result.text).toBe("猫在睡觉")
  })

  it("响应非 ok 时抛出上游错误", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "余额不足" } }), { status: 402 }),
    )
    await expect(
      describeImage({
      images: ["https://example.com/a.png"],
    }, db, { ownerUserId: "user-1" }, callGateway),
    ).rejects.toThrow("余额不足")
  })

  it("模型未返回内容时报错", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    )
    await expect(
      describeImage({
      images: ["https://example.com/a.png"],
    }, db, { ownerUserId: "user-1" }, callGateway),
    ).rejects.toThrow("模型未返回内容")
  })

  it("未指定调用用户时报错", async () => {
    await expect(
      describeImage({
      images: ["https://example.com/a.png"],
    }, db, { ownerUserId: "" }, vi.fn()),
    ).rejects.toThrow("未指定调用用户")
  })
})
describe("describeImageStream", () => {
  async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text()
  }

  it("上游 SSE 时转发 content_block 增量事件", async () => {
    const encoder = new TextEncoder()
    const sseBody = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}",
      "",
      "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"}}]}",
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

    const stream = await describeImageStream(
      { images: ["https://example.com/a.png"], prompt: "描述一下" },
      db,
      { ownerUserId: "user-1" },
      42,
      callGateway,
    )
    const text = await streamText(stream)
    expect(text).toContain('"content":[]')
    expect(text).toContain('"method":"notifications/content_block_start"')
    expect(text).toContain('"method":"notifications/content_block_delta"')
    expect(text).toContain('"text":"你好"')
    expect(text).toContain('"text":"世界"')
    expect(text).toContain('"method":"notifications/content_block_stop"')
    // 初始 result 带 JSON-RPC id
    expect(text).toContain('"id":42')
  })

  it("上游返回 JSON 全文时一次性发出 delta", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const stream = await describeImageStream(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      "req-1",
      callGateway,
    )
    const text = await streamText(stream)
    expect(text).toContain('"text":"画面中有一只橘猫"')
    expect(text).toContain('"method":"notifications/content_block_stop"')
  })

  it("上游响应非 ok 时在流内输出错误信息", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "余额不足" } }), { status: 402 }),
    )
    const stream = await describeImageStream(
      { images: ["https://example.com/a.png"] },
      db,
      { ownerUserId: "user-1" },
      1,
      callGateway,
    )
    const text = await streamText(stream)
    expect(text).toContain("余额不足")
    expect(text).toContain('"method":"notifications/content_block_stop"')
  })

  it("未配置模型时报错", async () => {
    updateMcpTool("describe_image", { config: { model: "" } }, db)
    await expect(
      describeImageStream({
      images: ["https://example.com/a.png"],
    }, db, { ownerUserId: "user-1" }, 1, vi.fn()),
    ).rejects.toThrow("尚未配置识图模型")
  })
})