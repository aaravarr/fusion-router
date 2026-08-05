import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import { describeImage, normalizeImageInput } from "./describe-image"
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
      expect(body.messages[0].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("请仔细描述这张图片的内容") })
      expect(body.messages[0].content[1]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/a.png" },
      })
      return new Response(JSON.stringify({ choices: [{ message: { content: "画面中有一只橘猫" } }] }), {
        status: 200,
      })
    })

    const result = await describeImage({ image: "https://example.com/a.png" }, db, callGateway)
    expect(result).toEqual({ text: "画面中有一只橘猫", model: "grok-4", accountName: null })
  })

  it("未配置模型时报错", async () => {
    updateMcpTool("describe_image", { config: { model: "" } }, db)
    await expect(describeImage({ image: "https://example.com/a.png" }, db, vi.fn())).rejects.toThrow(
      "尚未配置识图模型",
    )
  })

  it("响应非 ok 时抛出上游错误", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "余额不足" } }), { status: 402 }),
    )
    await expect(describeImage({ image: "https://example.com/a.png" }, db, callGateway)).rejects.toThrow(
      "余额不足",
    )
  })

  it("模型未返回内容时报错", async () => {
    const callGateway = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    )
    await expect(describeImage({ image: "https://example.com/a.png" }, db, callGateway)).rejects.toThrow(
      "模型未返回内容",
    )
  })

  it("未找到可用账号时（无管理员）报错", async () => {
    db.prepare("DELETE FROM users").run()
    await expect(describeImage({ image: "https://example.com/a.png" }, db, vi.fn())).rejects.toThrow(
      "未找到可用账号池",
    )
  })
})
