import { requireSession } from "../../../_auth"
import { startKimiOAuthSession } from "@/server/kimi-oauth"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  try {
    const session = await startKimiOAuthSession(user.id)
    return Response.json(session)
  } catch (cause) {
    return Response.json(
      { error: { type: "kimi_oauth_error", message: cause instanceof Error ? cause.message : "启动 Kimi OAuth 失败" } },
      { status: 502 },
    )
  }
}
