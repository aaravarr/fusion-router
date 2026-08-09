import { z } from "zod"
import { getDatabase } from "@/server/db"
import { webSearch } from "@/server/mcp/web-search"
import { describeImage } from "@/server/mcp/describe-image"
import { requireAdministrator } from "../../../../_auth"

export const runtime = "nodejs"

const testSchema = z.object({
  image: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  images: z.array(z.string().min(1)).min(1).optional(),
  prompt: z.string().optional(),
  content: z.string().optional(),
})

export async function POST(request: Request, context: { params: Promise<{ toolType: string }> }) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const parsed = testSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }
  const { toolType } = await context.params
  try {
    if (toolType === "web_search") {
      const content = (parsed.data.content ?? "").trim()
      if (!content) {
        return Response.json({ error: { type: "validation_error", message: "请提供要搜索的内容" } }, { status: 400 })
      }
      const result = await webSearch({ content }, getDatabase(), { ownerUserId: user.id })
      return Response.json({ result: { text: result.text, model: result.model } })
    }
    if (toolType === "describe_image") {
      const images = parsed.data.images ?? (parsed.data.image ? (Array.isArray(parsed.data.image) ? parsed.data.image : [parsed.data.image]) : [])
      if (images.length === 0) {
        return Response.json({ error: { type: "validation_error", message: "请至少提供一张图片" } }, { status: 400 })
      }
      const result = await describeImage({ images, prompt: parsed.data.prompt }, getDatabase(), { ownerUserId: user.id })
      return Response.json({ result: { text: result.text, model: result.model } })
    }
    return Response.json({ error: { type: "not_found", message: `未知工具: ${toolType}` } }, { status: 404 })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "工具调用失败"
    return Response.json({ error: { type: "mcp_call_failed", message } }, { status: 400 })
  }
}
