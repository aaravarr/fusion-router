import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import { clearBootstrapCacheForTests, ensureMasterKey } from "@/server/bootstrap"
import { ensureDefaultMcpTools } from "./mcp-tools"
import { describeImage } from "./describe-image"
import {
  checkMcpAccessToken,
  handleMcpRequest,
  isMcpAccessTokenConfigured,
  MCP_PROTOCOL_VERSION,
  parseBearerToken,
  setMcpAccessToken,
} from "./protocol"

vi.mock("./describe-image", () => ({
  describeImage: vi.fn(),
}))

const mockedDescribeImage = vi.mocked(describeImage)

let db: AppDatabase
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-mcp-protocol-"))
  process.env.DATA_DIR = directory
  clearBootstrapCacheForTests()
  ensureMasterKey()
  db = createDatabase(":memory:")
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at)
     VALUES ('admin-1', 'admin', 'admin', '管理员', 'ADMIN', 'ACTIVE', 'hash', ?, ?)`,
  ).run(now, now)
  ensureDefaultMcpTools(db)
})

afterEach(() => {
  vi.clearAllMocks()
  db.close()
  clearBootstrapCacheForTests()
  delete process.env.DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

describe("MCP protocol", () => {
  it("initialize 返回协议版本与工具能力", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, db)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.jsonrpc).toBe("2.0")
    expect(body.id).toBe(1)
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(body.result.capabilities).toEqual({ tools: {} })
    expect(body.result.serverInfo).toEqual({ name: "opencode-mcp", version: "0.1.0" })
    expect(body.result.instructions).toContain("describe_image")
  })

  it("ping 返回空结果", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" }, db)
    const body = await response.json()
    expect(body.result).toEqual({})
  })

  it("tools/list 返回启用的工具", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }, db)
    const body = await response.json()
    expect(body.result.tools).toHaveLength(1)
    expect(body.result.tools[0]).toMatchObject({
      name: "describe_image",
      inputSchema: { type: "object" },
    })
    expect(body.result.tools[0].inputSchema.required).toContain("image")
  })

  it("tools/call describe_image 成功返回内容", async () => {
    mockedDescribeImage.mockResolvedValue({ text: "图片描述", model: "grok-4", accountName: null })
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "describe_image", arguments: { image: "https://example.com/a.png" } },
      },
      db,
    )
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(body.result.content).toEqual([{ type: "text", text: "图片描述" }])
    expect(mockedDescribeImage).toHaveBeenCalledWith(
      { image: "https://example.com/a.png", prompt: undefined },
      db,
    )
  })

  it("tools/call 未知工具返回 -32602", async () => {
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      db,
    )
    const body = await response.json()
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toBe("Unknown tool")
    expect(mockedDescribeImage).not.toHaveBeenCalled()
  })

  it("tools/call 执行错误在成功信封内返回 isError", async () => {
    mockedDescribeImage.mockRejectedValue(new Error("余额不足"))
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "describe_image", arguments: { image: "data:image/png;base64,AAAA" } },
      },
      db,
    )
    const body = await response.json()
    expect(body.result.isError).toBe(true)
    expect(body.result.content).toEqual([{ type: "text", text: "余额不足" }])
  })

  it("notifications/initialized 返回 202", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, db)
    expect(response.status).toBe(202)
  })

  it("非 JSON-RPC 请求返回 400 Invalid Request", async () => {
    const response = await handleMcpRequest({ foo: "bar" }, db)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toBe("Invalid Request")
  })

  it("未知方法返回 -32601", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 7, method: "bogus" }, db)
    const body = await response.json()
    expect(body.error.code).toBe(-32601)
  })

  it("checkMcpAccessToken 未配置时返回 401", () => {
    const result = checkMcpAccessToken(
      new Request("http://internal/mcp", { method: "POST", headers: { authorization: "Bearer x" } }),
      db,
    )
    expect(result.ok).toBe(false)
    expect(result.error?.status).toBe(401)
  })

  it("checkMcpAccessToken 校验 Bearer token", () => {
    expect(isMcpAccessTokenConfigured(db)).toBe(false)
    setMcpAccessToken(db, "secret-token")
    expect(isMcpAccessTokenConfigured(db)).toBe(true)

    const bad = checkMcpAccessToken(
      new Request("http://internal/mcp", { method: "POST", headers: { authorization: "Bearer wrong" } }),
      db,
    )
    expect(bad.ok).toBe(false)
    expect(bad.error?.status).toBe(401)

    const good = checkMcpAccessToken(
      new Request("http://internal/mcp", { method: "POST", headers: { authorization: "Bearer secret-token" } }),
      db,
    )
    expect(good.ok).toBe(true)
    expect(good.token).toBe("secret-token")
  })

  it("parseBearerToken 解析 Authorization 头", () => {
    expect(parseBearerToken(new Request("http://internal/mcp", { method: "POST" }))).toBeNull()
    expect(
      parseBearerToken(
        new Request("http://internal/mcp", { method: "POST", headers: { authorization: "Bearer abc" } }),
      ),
    ).toBe("abc")
    expect(
      parseBearerToken(
        new Request("http://internal/mcp", { method: "POST", headers: { authorization: "bearer abc " } }),
      ),
    ).toBe("abc")
  })
})
