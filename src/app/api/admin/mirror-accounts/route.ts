import { getDatabase } from "@/server/db"
import { requireAdministrator } from "../_auth"

export const runtime = "nodejs"

export function GET(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const rows = getDatabase().prepare(`SELECT id,name,email,pool_type,workspace_id,external_id,owner_user_id
    FROM accounts ORDER BY owner_user_id,ordinal,created_at`).all() as Array<{
      id: string; name: string; email: string | null; pool_type: string; workspace_id: string; external_id: string | null; owner_user_id: string
    }>
  return Response.json({ accounts: rows.map((row) => ({
    id: row.id, name: row.name, email: row.email, poolType: row.pool_type, workspaceId: row.workspace_id,
    externalId: row.external_id, ownerUserId: row.owner_user_id,
  })) })
}
