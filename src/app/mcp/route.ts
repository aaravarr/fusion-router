import { getDatabase } from "@/server/db"
import { checkMcpAccessToken, handleMcpRequest } from "@/server/mcp/protocol"

export const runtime = "nodejs"
export const maxDuration = 300

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
} as const

export async function GET() {
  return Response.json(
    { error: { type: "method_not_allowed", message: "MCP 端点仅支持 POST" } },
    { status: 405, headers: corsHeaders },
  )
}

export async function POST(request: Request) {
  const db = getDatabase()
  const auth = checkMcpAccessToken(request, db)
  if (!auth.ok) {
    return auth.error ?? Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "未授权" } },
      { status: 401, headers: corsHeaders },
    )
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
  return handleMcpRequest(body, db)
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders })
}
