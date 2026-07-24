import { z } from "zod"
import { requireSession } from "../../../_auth"
import { cancelOpenAIOAuthSession } from "@/server/openai-oauth"

export const runtime = "nodejs"

const bodySchema = z.object({ sessionId: z.string().min(1) })

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error" } }, { status: 400 })
  cancelOpenAIOAuthSession(user.id, parsed.data.sessionId)
  return Response.json({ ok: true })
}
