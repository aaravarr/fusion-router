import { timingSafeEqual } from "node:crypto"
import type { AppDatabase } from "@/server/db"
import { SecretVault } from "@/server/crypto"
import { getSystemSecret, SYSTEM_SECRET_KEYS } from "@/server/settings"
import { describeImage } from "./describe-image"
import { MCP_TOOL_DEFINITIONS } from "./mcp-tools"

export const MCP_PROTOCOL_VERSION = "2025-06-18"
export const MCP_SERVER_INFO = { name: "opencode-mcp", version: "0.1.0" }

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
} as const

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS })
}

function rpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, result })
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function handleMcpRequest(body: unknown, db: AppDatabase): Promise<Response> {
  const record = asRecord(body)
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string") {
    return rpcError(null, -32600, "Invalid Request", 400)
  }
  const id = record.id
  const method = record.method
  const params = record.params

  if (method === "notifications/initialized") {
    return Response.json(null, { status: 202, headers: CORS_HEADERS })
  }

  if (id === undefined) {
    // JSON-RPC 通知不需要响应。
    return Response.json(null, { status: 202, headers: CORS_HEADERS })
  }

  switch (method) {
    case "initialize": {
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: "识图工具：调用 describe_image 并传入 image（URL 或 data URI）",
      })
    }
    case "ping":
      return rpcResult(id, {})
    case "tools/list": {
      const rows = db
        .prepare("SELECT tool_type, name, description FROM mcp_tools WHERE enabled = 1 ORDER BY created_at")
        .all() as { tool_type: string; name: string; description: string }[]
      const tools = rows.flatMap((row) => {
        const definition = MCP_TOOL_DEFINITIONS.find((item) => item.toolType === row.tool_type)
        return definition
          ? [{ name: row.name, description: row.description, inputSchema: definition.inputSchema }]
          : []
      })
      return rpcResult(id, { tools })
    }
    case "tools/call": {
      const paramsRecord = asRecord(params)
      const name = typeof paramsRecord.name === "string" ? paramsRecord.name : ""
      const definition = MCP_TOOL_DEFINITIONS.find((item) => item.name === name)
      if (!definition) return rpcError(id, -32602, "Unknown tool")
      const args = asRecord(paramsRecord.arguments)
      try {
        if (definition.toolType === "describe_image") {
          const image = typeof args.image === "string" ? args.image : ""
          const prompt = typeof args.prompt === "string" ? args.prompt : undefined
          const result = await describeImage({ image, prompt }, db)
          return rpcResult(id, { content: [{ type: "text", text: result.text }] })
        }
        return rpcError(id, -32601, "Method not found")
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        return rpcResult(id, { content: [{ type: "text", text: message }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, "Method not found")
  }
}

export function parseBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")
  if (!authorization) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match ? match[1].trim() : null
}

function readConfiguredMcpAccessToken(db: AppDatabase): string | null {
  try {
    return getSystemSecret(db, SYSTEM_SECRET_KEYS.mcpAccessToken)
  } catch {
    return null
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8")
  const rightBuffer = Buffer.from(right, "utf8")
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

export function checkMcpAccessToken(
  request: Request,
  db: AppDatabase,
): { ok: boolean; token: string | null; error?: Response } {
  const configured = readConfiguredMcpAccessToken(db)
  const bearer = parseBearerToken(request)
  if (configured === null) {
    return {
      ok: false,
      token: null,
      error: rpcError(null, -32001, "请先在管理后台配置 MCP 访问令牌", 401),
    }
  }
  if (!bearer || !constantTimeEqual(bearer, configured)) {
    return { ok: false, token: null, error: rpcError(null, -32001, "未授权", 401) }
  }
  return { ok: true, token: bearer }
}

export function isMcpAccessTokenConfigured(db: AppDatabase): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM system_settings WHERE key = ? AND is_secret = 1")
    .get(SYSTEM_SECRET_KEYS.mcpAccessToken)
  return row !== undefined
}

export function setMcpAccessToken(db: AppDatabase, token: string): void {
  const encrypted = JSON.stringify(new SecretVault().encrypt(token))
  const now = new Date().toISOString()
  const result = db
    .prepare("UPDATE system_settings SET value_json = ?, updated_at = ? WHERE key = ? AND is_secret = 1")
    .run(encrypted, now, SYSTEM_SECRET_KEYS.mcpAccessToken)
  if (result.changes !== 1) {
    db.prepare("INSERT INTO system_settings(key, value_json, is_secret, updated_at) VALUES (?, ?, 1, ?)")
      .run(SYSTEM_SECRET_KEYS.mcpAccessToken, encrypted, now)
  }
}
