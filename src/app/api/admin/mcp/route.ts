import { getDatabase } from "@/server/db"
import { ensureDefaultMcpTools, listMcpTools } from "@/server/mcp/mcp-tools"
import { MCP_PROTOCOL_VERSION } from "@/server/mcp/protocol"
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
      authMode: "api-key",
    },
    tools,
  })
}