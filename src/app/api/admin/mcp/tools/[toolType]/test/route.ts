import { z } from "zod"
import { getDatabase } from "@/server/db"
import { describeImage } from "@/server/mcp/describe-image"
import { webSearch } from "@/server/mcp/web-search"
import { requireAdministrator } from "../../../../_auth"

export const runtime = "nodejs"

const describeImageSchema = z.object({
  image: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  images: z.array(z.string().min(1)).min(1).optional(),
  prompt: z.string().optional(),
})

const webSearchSchema = z.object({
  query: z.string().min(1),
  prompt: z.string().optional(),
})

export async function POST(request: Request, context: { params: Promise<{ toolType: string }> }) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const { toolType } = await context.params

  if (toolType === "web_search") {
    const parsed = webSearchSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
    }
    try {
      const result = await webSearch(
        { query: parsed.data.query, prompt: parsed.data.prompt },
        getDatabase(),
        { ownerUserId: user.id },
      )
      return Response.json({ result: { text: result.text, model: result.model } })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "联网搜索调用失败"
      return Response.json({ error: { type: "mcp_call_failed", message } }, { status: 400 })
    }
  }

  // describe_image（默认）
  const parsed = describeImageSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }
  try {
    const images = parsed.data.images ?? (parsed.data.image ? (Array.isArray(parsed.data.image) ? parsed.data.image : [parsed.data.image]) : [])
    if (images.length === 0) {
      return Response.json({ error: { type: "validation_error", message: "请至少提供一张图片" } }, { status: 400 })
    }
    const result = await describeImage({ images, prompt: parsed.data.prompt }, getDatabase(), { ownerUserId: user.id })
    return Response.json({ result: { text: result.text, model: result.model } })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "识图调用失败"
    return Response.json({ error: { type: "mcp_call_failed", message } }, { status: 400 })
  }
}
