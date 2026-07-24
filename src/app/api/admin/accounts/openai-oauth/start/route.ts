import { requireSession } from "../../../_auth"
import { startOpenAIOAuthSession } from "@/server/openai-oauth"

export const runtime = "nodejs"

export function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json(startOpenAIOAuthSession(user.id))
}
