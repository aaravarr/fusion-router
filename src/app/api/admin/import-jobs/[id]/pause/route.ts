import { requireSession } from "../../../_auth"
import { pauseImportJob } from "@/server/import-jobs"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  try {
    return Response.json({ job: pauseImportJob(user.id, id) })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "暂停导入任务失败"
    return Response.json({ error: { type: message === "导入任务不存在" ? "not_found" : "pause_failed", message } }, { status: message === "导入任务不存在" ? 404 : 409 })
  }
}
