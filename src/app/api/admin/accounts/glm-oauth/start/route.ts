import { z } from "zod"
import { requireSession } from "../../../_auth"
import { startGlmOAuthSession } from "@/server/glm-coding"

export const runtime = "nodejs"

const bodySchema = z.object({
  region: z.enum(["cn", "global"]).optional(),
}).optional()

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  // 无 body 的 POST（curl -X POST 不带 -d）按默认 region 处理。
  const parsed = bodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  try {
    const session = await startGlmOAuthSession(user.id, parsed.data?.region ?? "cn")
    // authorize_url 的 redirect 指向 zcode.z.ai 自有回调，前端只需把链接展示给用户。
    return Response.json(session)
  } catch (cause) {
    return Response.json(
      { error: { type: "glm_oauth_error", message: cause instanceof Error ? cause.message : "启动 GLM OAuth 失败" } },
      { status: 502 },
    )
  }
}
