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
 * 活跃的 legacy HTTP+SSE 会话，以 GET 时下发的 session id 关联。
 * 每个客户端独立一个会话槽：多客户端/多会话窗口共享同一 API Key 也不会
 * 互抢，且与 sessionless 的 Streamable HTTP 直接 POST 在同一端点共存。
 * Next.js nodejs runtime 下模块级状态在进程内共享。
 */
const sseSessions = new Map<string, SseSession>()

function methodNotAllowed(): Response {
  return Response.json(
    { error: { type: "method_not_allowed", message: "MCP 端点仅支持 POST" } },
    { status: 405, headers: corsHeaders },
  )
}

/**
 * GET /mcp —— legacy HTTP+SSE transport：
 * 客户端先 GET 本端点（Accept: text/event-stream）建立 SSE 流，服务端返回
 * 带 session id 的 `endpoint` 事件告知后续 POST 地址（带 ?session=xxx）并保持
 * 连接（心跳保活）。之后客户端 POST 的 JSON-RPC 请求由 POST handler 处理，
 * 响应通过本流以 message 事件推送。
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
  // 每个连接独立会话 id：POST 携带它才能把响应推回本流，不干扰其它客户端
  const sessionId = crypto.randomUUID()
  const endpoint = `${proto}://${host}/mcp?session=${sessionId}`

  let heartbeat: ReturnType<typeof setInterval> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseSessions.set(sessionId, { ownerUserId: auth.ownerUserId, apiKeyId: auth.apiKeyId, controller })
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
      sseSessions.delete(sessionId)
    },
  })
  return new Response(stream, { status: 200, headers: STREAM_HEADERS })
}

/**
 * POST /mcp —— JSON-RPC 请求入口：
 * - 携带 GET 阶段下发的 ?session=xxx（legacy HTTP+SSE）时：处理请求，把响应以
 *   message 事件异步推送到对应会话流，POST 返回 202 Accepted；
 * - 否则（Streamable HTTP 直连，sessionless）：原样返回响应（JSON 或 SSE）。
 * 两种 transport 通过 session 查询参数区分：直连 POST 永远不会被劫持。
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
  // 仅当 POST 携带本连接 GET 阶段下发的 session id 时走 legacy 流推送；
  // 会话不存在或不属于同一 API Key（过期/他人）时按直连处理，不误劫持。
  const sessionId = new URL(request.url).searchParams.get("session")
  const session = sessionId ? sseSessions.get(sessionId) : undefined
  const isLegacy = session !== undefined && session.apiKeyId === auth.apiKeyId

  const response = await handleMcpRequest(
    body,
    db,
    { ownerUserId: auth.ownerUserId, apiKeyId: auth.apiKeyId },
    { acceptEventStream: isEventStreamRequest(request) },
  )

  if (!isLegacy) {
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
