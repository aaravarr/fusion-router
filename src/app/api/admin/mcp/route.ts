import { randomBytes } from "node:crypto"
import { z } from "zod"
import { getDatabase } from "@/server/db"
import { ensureDefaultMcpTools, listMcpTools } from "@/server/mcp/mcp-tools"
import { isMcpAccessTokenConfigured, MCP_PROTOCOL_VERSION, setMcpAccessToken } from "@/server/mcp/protocol"
import { requireAdministrator } from "../_auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const db = getDatabase()
  ensureDefaultMcpTools(db)
  const tools = listMcpTools(db)
  return Response.json({
    server: {
      endpoint: "/mcp",
      protocolVersion: MCP_PROTOCOL_VERSION,
      toolsCount: tools.length,
      accessTokenConfigured: isMcpAccessTokenConfigured(db),
    },
    tools,
  })
}

const resetTokenSchema = z.object({ resetToken: z.boolean().optional() })

export async function POST(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const parsed = resetTokenSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", message: "请求参数无效" } }, { status: 400 })
  }
  const db = getDatabase()
  if (parsed.data.resetToken) {
    const token = randomBytes(24).toString("base64url")
    setMcpAccessToken(db, token)
    return Response.json({ token })
  }
  return Response.json({ ok: true })
}
