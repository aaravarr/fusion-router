import { getDatabase } from "@/server/db"
import { requireAdministrator } from "../../_auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const users = getDatabase()
    .prepare("SELECT id, username, display_name AS displayName FROM users ORDER BY created_at")
    .all() as { id: string; username: string; displayName: string }[]
  return Response.json({ users })
}
