import { requireSession } from "../_auth"
import { getModelPricingStatus, refreshModelPricing } from "@/server/model-pricing"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ pricing: getModelPricingStatus() })
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  try {
    const pricing = await refreshModelPricing()
    return Response.json({ pricing })
  } catch (cause) {
    return Response.json(
      { error: { type: "pricing_refresh_failed", message: cause instanceof Error ? cause.message : "刷新模型价格失败" } },
      { status: 502 },
    )
  }
}
