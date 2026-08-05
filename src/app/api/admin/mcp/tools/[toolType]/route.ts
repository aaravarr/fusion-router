import { z } from "zod"
import { getDatabase } from "@/server/db"
import { getMcpTool, updateMcpTool } from "@/server/mcp/mcp-tools"
import { requireAdministrator } from "../../../_auth"

export const runtime = "nodejs"

const configSchema = z.object({
  poolType: z.string().nullable().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  maxTokens: z.number().int().min(1).max(32768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEnabled: z.boolean().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
})

const updateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
})

export async function GET(request: Request, context: { params: Promise<{ toolType: string }> }) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const { toolType } = await context.params
  const tool = getMcpTool(toolType, getDatabase())
  return tool ? Response.json({ tool }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}

export async function PUT(request: Request, context: { params: Promise<{ toolType: string }> }) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }
  const { toolType } = await context.params
  try {
    const tool = updateMcpTool(toolType, parsed.data, getDatabase())
    return Response.json({ tool })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "更新失败"
    const status = message.includes("not found") ? 404 : 400
    return Response.json({ error: { type: "mcp_tool_update_failed", message } }, { status })
  }
}
