import { z } from "zod"
import { getDatabase } from "@/server/db"
import { describeImage } from "@/server/mcp/describe-image"
import { requireAdministrator } from "../../../../_auth"

export const runtime = "nodejs"

const testSchema = z.object({
  image: z.string().min(1),
  prompt: z.string().optional(),
})

export async function POST(request: Request, context: { params: Promise<{ toolType: string }> }) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const parsed = testSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }
  try {
    const result = await describeImage(parsed.data, getDatabase())
    return Response.json({ result: { text: result.text, model: result.model } })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "识图调用失败"
    return Response.json({ error: { type: "mcp_call_failed", message } }, { status: 400 })
  }
}
