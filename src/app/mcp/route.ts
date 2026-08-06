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

interface SseSession {
  ownerUserId: string
  apiKeyId: string | null
  controller: ReadableStreamDefaultController<Uint8Array>
}

/**
 * 活跃的 legacy HTTP+SSE 会话：GET 建立的流，POST 的响应通过它推送。
 * 以 apiKeyId 关联（一个 key 同一时刻一个活跃 SSE 连接）。
 * Next.js nodejs runtime 下模块级状态在进程内共享。
 */
const sseSessions = new Map<string, SseSession>()

function sessionKey(ownerUserId: string, apiKeyId: string | null): string {
  return `${ownerUserId}:${apiKeyId ?? ""}`
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: { type: "method_not_allowed", message: "MCP 端点仅支持 POST" } },
    { status: 405, headers: corsHeaders },
  )
}

/**
 * GET /mcp —— legacy HTTP+SSE transport：
 * 客户端先 GET 本端点（Accept: text/event-stream）建立 SSE 流，服务端返回
 * `endpoint` 事件告知后续 POST 地址并保持连接（心跳保活）。之后客户端
 * POST 的 JSON-RPC 请求由 POST handler 处理，响应通过本流以 message 事件推送。
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
  const key = sessionKey(auth.ownerUserId, auth.apiKeyId)

  let heartbeat: ReturnType<typeof setInterval> | null = null
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      // 同一 key 已有旧流（重复连接）时先关闭旧流
      const previous = sseSessions.get(key)
      if (previous && previous.controller !== controller) {
        try {
          previous.controller.close()
        } catch {
          // 已关闭
        }
      }
      sseSessions.set(key, { ownerUserId: auth.ownerUserId, apiKeyId: auth.apiKeyId, controller })
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
      // 仅当仍指向当前连接时移除会话，避免误删新连接
      const active = sseSessions.get(key)
      if (active && streamController && active.controller === streamController) {
        sseSessions.delete(key)
      }
    },
  })
  return new Response(stream, { status: 200, headers: STREAM_HEADERS })
}

/**
 * POST /mcp —— JSON-RPC 请求入口：
 * - 存在活跃 legacy SSE 会话（该 key 的 GET 流）时：处理请求，把响应以
 *   message 事件异步推送到会话流，POST 返回 202 Accepted；
 * - 否则（http 直连）：原样返回响应（JSON 或 Streamable HTTP SSE）。
 */
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
  const key = sessionKey(auth.ownerUserId, auth.apiKeyId)
  const session = sseSessions.get(key)
  // 仅当客户端本请求也声明接受 SSE 时，才走 legacy SSE 流转发；
  // 避免活跃 SSE 会话误劫持 http 直连（JSON）请求。
  const clientAcceptsSse = isEventStreamRequest(request)

  const response = await handleMcpRequest(
    body,
    db,
    { ownerUserId: auth.ownerUserId, apiKeyId: auth.apiKeyId },
    { acceptEventStream: isEventStreamRequest(request) },
  )

  // 无活跃 SSE 会话，或客户端本请求未声明接受 SSE：http 直连，原样返回响应
  if (!session || !clientAcceptsSse) {
    return response
  }

  // legacy SSE：响应异步转发到会话流，POST 返回 202
  const encoder = new TextEncoder()
  void (async () => {
    try {
      if (!response.body) return
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      const full = Buffer.concat(chunks).toString("utf8")
      if (!full) return
      const contentType = response.headers.get("content-type") ?? ""
      if (contentType.includes("text/event-stream")) {
        // 已是 SSE 格式（流式响应）：直接追加到会话流
        session.controller.enqueue(encoder.encode(full))
      } else {
        // JSON 响应：包装成 message 事件推送给客户端
        session.controller.enqueue(encoder.encode(`event: message\ndata: ${full}\n\n`))
      }
    } catch {
      // 会话已关闭：忽略
    }
  })()

  return new Response(null, { status: 202 })
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders })
}
