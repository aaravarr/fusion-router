import { z } from "zod"
import { requireSession } from "../../../../_auth"
import { pollOpenDesignGoDeviceSession } from "@/server/open-design-go-device"

export const runtime = "nodejs"

const bodySchema = z.object({
  sessionId: z.string().min(1),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  try {
    const result = await pollOpenDesignGoDeviceSession(user.id, parsed.data.sessionId)
    // 业务状态一律 200 返回，由前端根据 status 区分；仅参数错误或系统异常才用 4xx/5xx
    if (result.status === "pending") {
      return Response.json({ status: "pending", pollIntervalSeconds: result.pollIntervalSeconds })
    }
    if (result.status === "approved") {
      return Response.json({ status: "approved", account: result.account, workspaceId: result.workspaceId })
    }
    if (result.status === "denied") {
      return Response.json({ status: "denied", message: result.message || "授权被拒绝" }, { status: 400 })
    }
    if (result.status === "expired") {
      return Response.json({ status: "expired", message: result.message || "设备码已过期" }, { status: 400 })
    }
    if (result.status === "invalid_secret") {
      return Response.json({ status: "invalid_secret", message: result.message || "invalid_device_secret" }, { status: 400 })
    }
    return Response.json(result)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // 会话不存在/过期等归为 400，不用 401
    if (/不存在|过期|无权/.test(message)) {
      return Response.json({ error: { type: "validation_error", message } }, { status: 400 })
    }
    return Response.json(
      { error: { type: "open_design_go_device_error", message } },
      { status: 502 },
    )
  }
}

export async function DELETE(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error" } }, { status: 400 })
  }
  const { cancelOpenDesignGoDeviceSession } = await import("@/server/open-design-go-device")
  cancelOpenDesignGoDeviceSession(user.id, parsed.data.sessionId)
  return Response.json({ ok: true })
}
