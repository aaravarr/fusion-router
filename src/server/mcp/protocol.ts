import type { AppDatabase } from "@/server/db"
import { authenticateApiKey } from "@/server/repository"
import { describeImage, describeImageStream } from "./describe-image"
import { webSearch, webSearchStream } from "./web-search"
import { MCP_TOOL_DEFINITIONS } from "./mcp-tools"

export const MCP_PROTOCOL_VERSION = "2025-06-18"
export const MCP_SERVER_INFO = { name: "fusionrouter-mcp", version: "0.1.0" }

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

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
} as const

export function isEventStreamRequest(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream")
}

export async function handleMcpRequest(
  body: unknown,
  db: AppDatabase,
  ctx: { ownerUserId: string; apiKeyId?: string | null },
  options?: { acceptEventStream?: boolean },
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<Response> {
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
        instructions:
          "调用 describe_image 并传入 image（单图字符串或多图字符串数组，URL 或 data URI）与可选 prompt；使用调用者自己的 API Key 鉴权，识图消耗调用者账号池额度。prompt 不传时模型直接看图回答。\n" +
          "调用 web_search 并传入 query（搜索问题或关键词）与可选 prompt；服务端使用配置的 Provider+模型通过 responses API 执行实时联网搜索并返回模型回答，消耗调用者账号池额度。",
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
          // image 兼容单图字符串与多图数组；统一归一化为 images 数组。
          const images = Array.isArray(args.image)
            ? args.image.filter((item): item is string => typeof item === "string")
            : typeof args.image === "string"
              ? [args.image]
              : []
          if (images.length === 0) {
            return rpcResult(id, { content: [{ type: "text", text: "请至少提供一张图片" }], isError: true })
          }
          const prompt = typeof args.prompt === "string" ? args.prompt : undefined
          const wantStream = options?.acceptEventStream === true && args.stream !== false
          if (wantStream) {
            const stream = await describeImageStream(
              { images, prompt },
              db,
              { ownerUserId: ctx.ownerUserId },
              id,
              callGateway,
            )
            return new Response(stream, { status: 200, headers: STREAM_HEADERS })
          }
          const result = await describeImage({ images, prompt }, db, { ownerUserId: ctx.ownerUserId }, callGateway)
          return rpcResult(id, { content: [{ type: "text", text: result.text }] })
        }
        if (definition.toolType === "web_search") {
          const query = typeof args.query === "string" ? args.query.trim() : ""
          if (!query) {
            return rpcResult(id, { content: [{ type: "text", text: "请提供搜索问题" }], isError: true })
          }
          const prompt = typeof args.prompt === "string" ? args.prompt : undefined
          const wantStream = options?.acceptEventStream === true && args.stream !== false
          if (wantStream) {
            const stream = await webSearchStream(
              { query, prompt },
              db,
              { ownerUserId: ctx.ownerUserId },
              id,
              callGateway,
            )
            return new Response(stream, { status: 200, headers: STREAM_HEADERS })
          }
          const result = await webSearch({ query, prompt }, db, { ownerUserId: ctx.ownerUserId }, callGateway)
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

export function authenticateMcpRequest(
  request: Request,
  db: AppDatabase,
): { ok: true; ownerUserId: string; apiKeyId: string | null } | { ok: false; error: Response } {
  const plaintext = parseBearerToken(request) ?? request.headers.get("x-api-key") ?? ""
  const apiKey = authenticateApiKey(plaintext, db)
  if (!apiKey) return { ok: false, error: rpcError(null, -32001, "无效的 API Key", 401) }
  return { ok: true, ownerUserId: apiKey.ownerUserId, apiKeyId: apiKey.id }
}
