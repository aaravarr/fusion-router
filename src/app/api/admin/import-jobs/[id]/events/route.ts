import { requireSession } from "../../../_auth"
import { getImportJob } from "@/server/import-jobs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  if (!getImportJob(user.id, id)) return Response.json({ error: { type: "not_found", message: "导入任务不存在" } }, { status: 404 })

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let lastPayload = ""
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        const job = getImportJob(user.id, id)
        if (!job) { controller.close(); if (timer) clearInterval(timer); return }
        const payload = JSON.stringify(job)
        if (payload !== lastPayload) {
          lastPayload = payload
          controller.enqueue(encoder.encode(`event: progress\ndata: ${payload}\n\n`))
        } else {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        }
        if (job.status === "PAUSED" || job.status === "COMPLETED" || job.status === "FAILED") {
          if (timer) clearInterval(timer)
          controller.close()
        }
      }
      send()
      timer = setInterval(send, 750)
      request.signal.addEventListener("abort", () => { if (timer) clearInterval(timer) }, { once: true })
    },
    cancel() { if (timer) clearInterval(timer) },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } })
}
