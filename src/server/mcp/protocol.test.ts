import { mkdtempSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import { clearBootstrapCacheForTests, ensureMasterKey } from "@/server/bootstrap"
import { ApiKeyHasher } from "@/server/crypto"
import { getSystemSecret, initializeSystemSettings } from "@/server/settings"
import { ensureDefaultMcpTools } from "./mcp-tools"
import { describeImage, describeImageStream } from "./describe-image"
import {
  authenticateMcpRequest,
  handleMcpRequest,
  MCP_PROTOCOL_VERSION,
  parseBearerToken,
} from "./protocol"

vi.mock("./describe-image", () => ({
  describeImage: vi.fn(),
  describeImageStream: vi.fn(),
}))

const mockedDescribeImage = vi.mocked(describeImage)
const mockedDescribeImageStream = vi.mocked(describeImageStream)

let db: AppDatabase
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-mcp-protocol-"))
  process.env.DATA_DIR = directory
  clearBootstrapCacheForTests()
  ensureMasterKey()
  db = createDatabase(":memory:")
  initializeSystemSettings(db)
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

function seedApiKey(plaintext: string, ownerUserId = "admin-1"): void {
  const hasher = new ApiKeyHasher(getSystemSecret(db, "api_key_pepper"))
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO api_keys(id, owner_user_id, name, key_prefix, key_hash, enabled, allowed_models_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
  ).run(randomUUID(), ownerUserId, "mcp-test-key", plaintext.slice(0, 12), hasher.hash(plaintext), now, now)
}

describe("MCP protocol", () => {
  it("initialize 返回协议版本与工具能力", async () => {
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      db,
      { ownerUserId: "user-1" },
    )
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
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" }, db, {
      ownerUserId: "user-1",
    })
    const body = await response.json()
    expect(body.result).toEqual({})
  })

  it("tools/list 返回启用的工具", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }, db, {
      ownerUserId: "user-1",
    })
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
      { ownerUserId: "user-1" },
    )
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(body.result.content).toEqual([{ type: "text", text: "图片描述" }])
    expect(mockedDescribeImage).toHaveBeenCalledWith(
      { images: ["https://example.com/a.png"], prompt: undefined },
      db,
      { ownerUserId: "user-1" },
      undefined,
    )
  })

  it("acceptEventStream 时 tools/call 返回 SSE 流", async () => {
    const encoder = new TextEncoder()
    mockedDescribeImageStream.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: message\ndata: x\n\n"))
          controller.close()
        },
      }),
    )
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "describe_image", arguments: { image: "https://example.com/a.png" } },
      },
      db,
      { ownerUserId: "user-1" },
      { acceptEventStream: true },
    )
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(mockedDescribeImage).not.toHaveBeenCalled()
    expect(mockedDescribeImageStream).toHaveBeenCalledWith(
      { images: ["https://example.com/a.png"], prompt: undefined },
      db,
      { ownerUserId: "user-1" },
      4,
      undefined,
    )
  })

  it("acceptEventStream 但 args.stream=false 时仍返回 JSON", async () => {
    mockedDescribeImage.mockResolvedValue({ text: "图片描述", model: "grok-4", accountName: null })
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "describe_image",
          arguments: { image: "https://example.com/a.png", stream: false },
        },
      },
      db,
      { ownerUserId: "user-1" },
      { acceptEventStream: true },
    )
    expect(response.headers.get("content-type")).toContain("application/json")
    const body = await response.json()
    expect(body.result.content).toEqual([{ type: "text", text: "图片描述" }])
    expect(mockedDescribeImageStream).not.toHaveBeenCalled()
  })

  it("tools/call 未知工具返回 -32602", async () => {
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      db,
      { ownerUserId: "user-1" },
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
      { ownerUserId: "user-1" },
    )
    const body = await response.json()
    expect(body.result.isError).toBe(true)
    expect(body.result.content).toEqual([{ type: "text", text: "余额不足" }])
  })

  it("notifications/initialized 返回 202", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, db, {
      ownerUserId: "user-1",
    })
    expect(response.status).toBe(202)
  })

  it("非 JSON-RPC 请求返回 400 Invalid Request", async () => {
    const response = await handleMcpRequest({ foo: "bar" }, db, { ownerUserId: "user-1" })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toBe("Invalid Request")
  })

  it("未知方法返回 -32601", async () => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 7, method: "bogus" }, db, {
      ownerUserId: "user-1",
    })
    const body = await response.json()
    expect(body.error.code).toBe(-32601)
  })

  it("authenticateMcpRequest 通过 Authorization Bearer 识别归属用户", () => {
    seedApiKey("ocg_test_bearer_key_123")
    const result = authenticateMcpRequest(
      new Request("http://internal/mcp", { method: "POST", headers: { authorization: "Bearer ocg_test_bearer_key_123" } }),
      db,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ownerUserId).toBe("admin-1")
      expect(result.apiKeyId).toBeTruthy()
    }
  })

  it("authenticateMcpRequest 兼容 x-api-key 头", () => {
    seedApiKey("ocg_test_xapikey_456")
    const result = authenticateMcpRequest(
      new Request("http://internal/mcp", { method: "POST", headers: { "x-api-key": "ocg_test_xapikey_456" } }),
      db,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ownerUserId).toBe("admin-1")
    }
  })

  it("authenticateMcpRequest 无效 key 返回 401", () => {
    const result = authenticateMcpRequest(
      new Request("http://internal/mcp", { method: "POST", headers: { authorization: "Bearer wrong-key" } }),
      db,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.status).toBe(401)
    }
  })

  it("authenticateMcpRequest 未携带凭据返回 401", () => {
    const result = authenticateMcpRequest(new Request("http://internal/mcp", { method: "POST" }), db)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.status).toBe(401)
    }
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