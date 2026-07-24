import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../_auth"
import { createCustomProviderSchema } from "./_schema"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ providers: new CustomProviderRepository(user.id, getDatabase()).list() })
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = createCustomProviderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  try {
    const provider = new CustomProviderRepository(user.id, getDatabase()).create(parsed.data)
    return Response.json({ provider }, { status: 201 })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "创建 Provider 失败"
    return Response.json({ error: { type: "custom_provider_create_failed", message } }, { status: message.includes("UNIQUE") ? 409 : 400 })
  }
}
