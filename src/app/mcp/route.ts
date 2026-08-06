import { getDatabase } from "@/server/db"
import { authenticateMcpRequest, handleMcpRequest, isEventStreamRequest, STREAM_HEADERS } from "@/server/mcp/protocol"

export const runtime = "nodejs"
export const maxDuration = 300

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
} as const

// legacy HTTP+SSE transport 的心跳间隔：防止代理/负载均衡关闭空闲 SSE 连接
const SSE_KEEPALIVE_MS = 15_000

function methodNotAllowed(): Response {
  return Response.json(
    { error: { type: "method_not_allowed", message: "MCP 端点仅支持 POST" } },
    { status: 405, headers: corsHeaders },
  )
}

/**
 * GET /mcp
 *
 * 支持 legacy HTTP+SSE transport（如部分客户端的 "SSE" 连接方式）：
 * 客户端先 GET 本端点（Accept: text/event-stream）建立 SSE 流，服务端返回
 * endpoint 事件告知后续 POST 地址，并保持连接（心跳保活）。之后客户端
 * POST 的 JSON-RPC 请求仍走 POST handler（非流式返回完整 JSON result，
 * 流式返回标准 Streamable HTTP SSE）。
 *
 * 客户端未显式请求 SSE 时保持 405（符合 Streamable HTTP 规范）。
 */
export async function GET(request: Request) {
  if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
    return methodNotAllowed()
  }
  const db = getDatabase()
  const auth = authenticateMcpRequest(request, db)
  if (!auth.ok) {
    return auth.error
  }

  const url = new URL(request.url)
  // 用客户端实际请求的 Host（及转发头）拼 endpoint，避免拿到服务端内部 host（如 0.0.0.0）
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1)
  const endpoint = `${proto}://${host}/mcp`
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      // legacy transport：先通知客户端 POST 端点
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`))
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          if (heartbeat) clearInterval(heartbeat)
        }
      }, SSE_KEEPALIVE_MS)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
    },
  })
  return new Response(stream, { status: 200, headers: STREAM_HEADERS })
}

export async function POST(request: Request) {
  const db = getDatabase()
  const auth = authenticateMcpRequest(request, db)
  if (!auth.ok) {
    return auth.error
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: corsHeaders },
    )
  }
  return handleMcpRequest(
    body,
    db,
    { ownerUserId: auth.ownerUserId, apiKeyId: auth.apiKeyId },
    { acceptEventStream: isEventStreamRequest(request) },
  )
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders })
}
