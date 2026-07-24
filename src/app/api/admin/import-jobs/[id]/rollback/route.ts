import { requireSession } from "../../../_auth"
import { rollbackImportJob } from "@/server/import-jobs"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  try {
    return Response.json(rollbackImportJob(user.id, id))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "撤销导入失败"
    const status = message === "导入任务不存在" ? 404 : 409
    return Response.json({ error: { type: status === 404 ? "not_found" : "rollback_failed", message } }, { status })
  }
}
