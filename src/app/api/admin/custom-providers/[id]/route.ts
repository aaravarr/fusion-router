import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { requireSession } from "../../_auth"
import { updateCustomProviderSchema } from "../_schema"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const provider = new CustomProviderRepository(user.id, getDatabase()).get(id)
  return provider ? Response.json({ provider }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = updateCustomProviderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id } = await context.params
  try {
    const provider = new CustomProviderRepository(user.id, getDatabase()).update(id, parsed.data)
    return provider ? Response.json({ provider }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
  } catch (cause) {
    return Response.json({ error: { type: "custom_provider_update_failed", message: cause instanceof Error ? cause.message : "更新失败" } }, { status: 400 })
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  return new CustomProviderRepository(user.id, getDatabase()).delete(id)
    ? new Response(null, { status: 204 })
    : Response.json({ error: { type: "not_found" } }, { status: 404 })
}
