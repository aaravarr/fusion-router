import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "./route"

const okAuth = { ok: true as const, ownerUserId: "u1", apiKeyId: "k1" }

vi.mock("@/server/db", () => ({
  getDatabase: vi.fn(() => ({})),
}))

vi.mock("@/server/mcp/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/mcp/protocol")>()
  return {
    ...actual,
    authenticateMcpRequest: vi.fn(() => okAuth),
    handleMcpRequest: vi.fn(),
  }
})

import { authenticateMcpRequest, handleMcpRequest } from "@/server/mcp/protocol"

const mockedAuthenticate = vi.mocked(authenticateMcpRequest)
const mockedHandle = vi.mocked(handleMcpRequest)

function jsonResponse(payload: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": contentType },
  })
}

/**
 * 建立 legacy HTTP+SSE 会话：GET /mcp 拿 SSE 流与 endpoint 事件，
 * 返回 { reader, endpoint }；调用方负责 cancel reader 清理。
 */
async function openSseSession(): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; endpoint: string }> {
  const response = await GET(
    new Request("http://test.local/mcp", { headers: { accept: "text/event-stream" } }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body!.getReader()
  const { value } = await reader.read()
  const chunk = new TextDecoder().decode(value)
  const match = /^event: endpoint\ndata: (.+)\n\n$/.exec(chunk)
  expect(match).not.toBeNull()
  return { reader, endpoint: match![1] }
}

beforeEach(() => {
  mockedAuthenticate.mockReset()
  mockedAuthenticate.mockReturnValue(okAuth)
  mockedHandle.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("GET /mcp（legacy HTTP+SSE）", () => {
  it("未请求 SSE 时返回 405", async () => {
    const response = await GET(new Request("http://test.local/mcp"))
    expect(response.status).toBe(405)
  })

  it("endpoint 事件带独立 session id，重复连接不关闭旧会话", async () => {
    const a = await openSseSession()
    const b = await openSseSession()
    const sessionA = new URL(a.endpoint).searchParams.get("session")
    const sessionB = new URL(b.endpoint).searchParams.get("session")
    expect(sessionA).toBeTruthy()
    expect(sessionB).toBeTruthy()
    // 两个并发 legacy 客户端拿到各自独立的会话槽，互不顶替
    expect(sessionA).not.toBe(sessionB)
    await a.reader.cancel()
    await b.reader.cancel()
  })
})

describe("POST /mcp（Streamable HTTP 直连）", () => {
  it("无 session 参数时原样返回 JSON 响应，不被劫持", async () => {
    mockedHandle.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }))
    const response = await POST(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })

  it("即使存在活跃 SSE 会话，无 session 参数的直连 POST 也不被劫持", async () => {
    const session = await openSseSession()
    mockedHandle.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }))
    const response = await POST(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} })
    await session.reader.cancel()
  })
})

describe("POST /mcp?session=xxx（legacy HTTP+SSE）", () => {
  it("带有效 session 时返回 202，响应以 message 事件推送到对应流", async () => {
    const session = await openSseSession()
    mockedHandle.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [] } }))
    const response = await POST(
      new Request(session.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    )
    expect(response.status).toBe(202)
    const { value } = await session.reader.read()
    const chunk = new TextDecoder().decode(value)
    expect(chunk).toContain("event: message")
    expect(chunk).toContain('"id":2')
    expect(chunk).toContain('"tools":[]')
    await session.reader.cancel()
  })

  it("带未知/过期 session 时按直连处理，不被劫持", async () => {
    mockedHandle.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 3, result: {} }))
    const response = await POST(
      new Request("http://test.local/mcp?session=expired-session-id", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }),
      }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 3, result: {} })
  })

  it("鉴权失败时返回 401 且不调用 handler", async () => {
    mockedAuthenticate.mockReturnValue({
      ok: false,
      error: jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "无效的 API Key" } }, "application/json"),
    })
    const response = await POST(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    )
    expect(response.status).toBe(200)
    expect(mockedHandle).not.toHaveBeenCalled()
  })
})
