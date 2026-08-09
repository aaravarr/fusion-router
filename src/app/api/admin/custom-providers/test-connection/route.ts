import { z } from "zod"
import { requireSession } from "../../_auth"
import { balanceConfigSchema } from "../_schema"
import { probeCustomProvider } from "@/server/providers/custom"
import { CustomProviderRepository } from "@/server/custom-providers"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"

export const runtime = "nodejs"

const debugSchema = z.object({
  baseUrl: z.string().url().max(2000),
  interfaceTypes: z.array(z.enum(["chat", "responses", "messages"])).min(1).optional(),
  apiKey: z.string().max(20_000).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  balanceConfig: balanceConfigSchema.nullable().optional(),
  providerId: z.string().optional(),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = debugSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })

  let apiKey = parsed.data.apiKey
  if (!apiKey && parsed.data.providerId) {
    const db = getDatabase()
    const provider = new CustomProviderRepository(user.id, db).get(parsed.data.providerId)
    if (!provider) return Response.json({ error: { type: "provider_not_found", message: "Provider 不存在" } }, { status: 404 })
    const account = new AccountRepository(user.id, db).listByPoolType(provider.poolType)[0]
    apiKey = account ? new ProviderCredentialRepository(user.id, db).get(account.id)?.token : undefined
  }

  try {
    const result = await probeCustomProvider({
      baseUrl: parsed.data.baseUrl,
      apiKey,
      extraHeaders: parsed.data.extraHeaders,
      balanceConfig: parsed.data.balanceConfig,
    })
    return Response.json({ result })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "探测失败"
    return Response.json({ error: { message } }, { status: 400 })
  }
}
