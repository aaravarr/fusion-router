import { z } from "zod"
import { requireSession } from "../../_auth"
import { AccountRepository } from "@/server/repository"

export const runtime = "nodejs"

const bodySchema = z.object({
  action: z.enum(["enable", "disable", "delete"]),
  accountIds: z.array(z.string().min(1)).min(1).max(500).transform((ids) => [...new Set(ids)]),
  reason: z.string().trim().min(1).max(200).optional(),
  confirmSpendingBlocked: z.boolean().optional(),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  const repository = new AccountRepository(user.id)
  const { action, accountIds, reason, confirmSpendingBlocked } = parsed.data
  if (action === "delete") {
    const result = repository.bulkDelete(accountIds)
    return Response.json({ action, ...result })
  }
  const result = repository.bulkSetAdminState(accountIds, action === "enable" ? "ENABLED" : "DISABLED", {
    reason,
    confirmSpendingBlocked,
  })
  return Response.json({ action, ...result })
}
