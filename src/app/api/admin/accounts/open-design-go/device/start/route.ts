import { requireSession } from "../../../../_auth"
import { startOpenDesignGoDeviceSession } from "@/server/open-design-go-device"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  try {
    const session = await startOpenDesignGoDeviceSession(user.id)
    return Response.json(session)
  } catch (cause) {
    return Response.json(
      { error: { type: "open_design_go_device_error", message: cause instanceof Error ? cause.message : "创建设备码失败" } },
      { status: 502 },
    )
  }
}
