import { z } from "zod"
import { requireSession } from "../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import {
  commandCodeExternalId,
  isValidCommandCodeApiKeyShape,
  verifyCommandCodeApiKey,
  CommandCodeApiKeyInvalidError,
  CommandCodeProbeUnavailableError,
} from "@/server/command-code"

export const runtime = "nodejs"

const bodySchema = z.object({
  apiKey: z.string().min(12, "API Key 过短"),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  const apiKey = parsed.data.apiKey.trim()

  // 先实测验证 key：GET /alpha/whoami（2026-09-08 持 key 实测 200，
  // 返回 {success, user: {id, name, email, userName}, org}，无 plan 字段）。
  // 注意：key 无效必须返回 400 而非 401——前端 sessionFetch 会把 401 当会话过期
  // 跳转登录页（铁律，同 Kimi/GLM）。/alpha 接口 404 不存在时宽容降级为格式校验
  // 照常录入（commandCodeVerified=false）；网络/5xx 等上游故障回 502。
  let plan = ""
  let email: string | null = null
  let userId: string | null = null
  let verified = true
  try {
    const whoami = await verifyCommandCodeApiKey(apiKey)
    plan = whoami?.plan ?? ""
    email = whoami?.email ?? null
    userId = whoami?.userId ?? null
  } catch (cause) {
    if (cause instanceof CommandCodeApiKeyInvalidError) {
      return Response.json(
        { error: { type: "command_code_apikey_invalid", message: `Command Code API Key 验证失败：${cause.message}` } },
        { status: 400 },
      )
    }
    if (cause instanceof CommandCodeProbeUnavailableError && cause.kind === "NOT_FOUND") {
      verified = false
      if (!isValidCommandCodeApiKeyShape(apiKey)) {
        return Response.json(
          { error: { type: "command_code_apikey_invalid", message: "Command Code API Key 格式不合法（无法在线验证，仅接受标准 key 形态）" } },
          { status: 400 },
        )
      }
    } else {
      const message = cause instanceof Error ? cause.message : String(cause)
      return Response.json(
        { error: { type: "command_code_apikey_unreachable", message: `Command Code 上游暂时不可达：${message}` } },
        { status: 502 },
      )
    }
  }

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)

  const account = accountRepo.createProviderAccount({
    name: `Command Code (GOAT)${email ? ` · ${email}` : ""}`,
    poolType: "command-code",
    email,
    externalId: commandCodeExternalId(apiKey),
  })

  // 长期 API key：无 refreshToken / expiresAt，token 直接就是 key，无 OAuth 刷新。
  const credentialData: Record<string, string> = {
    token: apiKey,
    tokenType: "Bearer",
    authMode: "apikey",
    commandCodeVerified: verified ? "true" : "false",
  }
  if (plan) credentialData.commandCodePlan = plan
  if (userId) credentialData.commandCodeUserId = userId
  credRepo.upsert({ accountId: account.id, poolType: "command-code", credentialData })

  void import("@/server/provider-models").then(({ syncProviderModelsForAccount }) =>
    syncProviderModelsForAccount(user.id, account.id, db).catch(() => undefined),
  )
  void import("@/server/provider-sync").then(({ syncProviderAccount }) =>
    syncProviderAccount(user.id, account.id, db).catch(() => undefined),
  )

  return Response.json({
    status: "success",
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      poolType: account.poolType,
    },
    plan,
    verified,
  })
}
