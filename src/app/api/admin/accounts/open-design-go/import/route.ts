import { createHash } from "node:crypto"
import { z } from "zod"
import { requireSession } from "../../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { apiFetch } from "@/server/api-fetch"

export const runtime = "nodejs"

const DEFAULT_API_URL = "https://amr-api.open-design.ai"

function normalizeApiUrl(apiUrl?: string | null): string {
  const raw = (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "")
  return raw || DEFAULT_API_URL
}

function parseModels(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: unknown[] }
    const rows = Array.isArray(parsed.data) ? parsed.data : []
    const models = new Set<string>()
    for (const row of rows as unknown[]) {
      if (typeof row === "string" && row.trim()) models.add(row.trim())
      else if (row && typeof row === "object") {
        const id = (row as { id?: unknown }).id
        if (typeof id === "string" && id.trim()) models.add(id.trim())
      }
    }
    return [...models].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

const bodySchema = z.object({
  configJson: z.any().optional(),
  runtimeKey: z.string().optional(),
  linkUrl: z.string().optional(),
  controlKey: z.string().optional(),
  apiUrl: z.string().optional(),
  name: z.string().optional(),
})

interface AmrUser {
  id?: string
  email?: string
  plan?: string
}
interface AmrProfile {
  controlKey?: string
  runtimeKey?: string
  apiUrl?: string
  linkUrl?: string
  user?: AmrUser
}

function extractFromConfigJson(configJson: unknown): {
  runtimeKey?: string
  linkUrl?: string
  controlKey?: string
  apiUrl?: string
  email?: string
  plan?: string
  userId?: string
} | null {
  if (!configJson || typeof configJson !== "object") return null
  const obj = configJson as Record<string, unknown>
  // 结构 {profiles:{prod:{controlKey,runtimeKey,apiUrl,linkUrl,user:{id,email,plan}}}}
  const profiles = (obj.profiles as Record<string, unknown> | undefined) ?? (obj.profile as Record<string, unknown> | undefined)
  let profile: Record<string, unknown> | null = null
  if (profiles && typeof profiles === "object") {
    const prod = (profiles as Record<string, unknown>).prod
    if (prod && typeof prod === "object") profile = prod as Record<string, unknown>
    else {
      const first = Object.values(profiles as Record<string, unknown>).find((v) => v && typeof v === "object")
      if (first && typeof first === "object") profile = first as Record<string, unknown>
    }
  }
  // 兼容 configJson 本身就是 profile
  if (!profile && ("runtimeKey" in obj || "controlKey" in obj)) {
    profile = obj
  }
  if (!profile) return null
  const runtimeKey = typeof profile.runtimeKey === "string" ? profile.runtimeKey.trim() : typeof (profile as Record<string, unknown>).runtime_key === "string" ? String((profile as Record<string, unknown>).runtime_key).trim() : undefined
  const linkUrl = typeof profile.linkUrl === "string" ? profile.linkUrl.trim() : typeof (profile as Record<string, unknown>).link_url === "string" ? String((profile as Record<string, unknown>).link_url).trim() : undefined
  const controlKey = typeof profile.controlKey === "string" ? profile.controlKey.trim() : typeof (profile as Record<string, unknown>).control_key === "string" ? String((profile as Record<string, unknown>).control_key).trim() : undefined
  const apiUrl = typeof profile.apiUrl === "string" ? profile.apiUrl.trim() : typeof (profile as Record<string, unknown>).api_url === "string" ? String((profile as Record<string, unknown>).api_url).trim() : undefined
  const user = profile.user as AmrUser | undefined
  const email = user?.email?.trim()
  const plan = user?.plan?.trim()
  const userId = user?.id?.trim()
  return { runtimeKey, linkUrl, controlKey, apiUrl, email, plan, userId }
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  let runtimeKey: string | undefined = parsed.data.runtimeKey?.trim() || undefined
  let linkUrl: string | undefined = parsed.data.linkUrl?.trim() || undefined
  let controlKey: string | undefined = parsed.data.controlKey?.trim() || undefined
  let apiUrl: string | undefined = parsed.data.apiUrl?.trim() || undefined
  let name: string | undefined = parsed.data.name?.trim() || undefined
  let email: string | undefined
  let plan: string | undefined
  let userId: string | undefined

  if (parsed.data.configJson !== undefined && parsed.data.configJson !== null) {
    let configJson = parsed.data.configJson
    if (typeof configJson === "string") {
      const trimmed = configJson.trim()
      if (!trimmed) {
        return Response.json({ error: { type: "validation_error", message: "configJson 不能为空" } }, { status: 400 })
      }
      try {
        configJson = JSON.parse(trimmed)
      } catch {
        return Response.json({ error: { type: "validation_error", message: "configJson 不是合法 JSON" } }, { status: 400 })
      }
    }
    const extracted = extractFromConfigJson(configJson)
    if (!extracted) {
      return Response.json({ error: { type: "validation_error", message: "configJson 中未找到有效的 profile（需包含 profiles.prod 或首个 profile）" } }, { status: 400 })
    }
    // configJson 优先，但若 body 直接传了则覆盖
    runtimeKey = runtimeKey || extracted.runtimeKey
    linkUrl = linkUrl || extracted.linkUrl
    controlKey = controlKey || extracted.controlKey
    apiUrl = apiUrl || extracted.apiUrl
    email = extracted.email
    plan = extracted.plan
    userId = extracted.userId
    // 若未传 name，用 email 兜底
    if (!name && email) name = email
  }

  if (!runtimeKey || !linkUrl || !controlKey) {
    return Response.json(
      { error: { type: "validation_error", message: "缺少必要字段：runtimeKey、linkUrl、controlKey（或提供 configJson）" } },
      { status: 400 },
    )
  }

  const normalizedApiUrl = normalizeApiUrl(apiUrl)
  // 先实测验证 controlKey：调 /api/v1/models 确认有效，无效直接拒绝。
  // 注意：业务失败一律不用 401，必须用 400/422，否则前端 sessionFetch 会跳登录。
  let models: string[] = []
  try {
    const resp = await apiFetch(`${normalizedApiUrl}/api/v1/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${controlKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`Open Design GO /api/v1/models 拉取失败（HTTP ${resp.status}）: ${text.slice(0, 200)}`)
    models = parseModels(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/\b(401|403)\b/.test(message) || /invalid|unauthorized|expired|forbidden/i.test(message)) {
      return Response.json(
        { error: { type: "open_design_go_invalid", message: `Open Design GO 凭据验证失败：${message}` } },
        { status: 400 },
      )
    }
    return Response.json(
      { error: { type: "open_design_go_unreachable", message: `Open Design GO 上游暂时不可达：${message}` } },
      { status: 502 },
    )
  }

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)
  const externalId = createHash("sha256").update(`open-design-go:${controlKey}:${runtimeKey}`).digest("hex").slice(0, 24)

  const accountName = name?.trim() || email || "Open Design GO"
  const account = accountRepo.createProviderAccount({
    name: accountName,
    poolType: "open-design-go",
    email: email || null,
    externalId,
  })

  const credentialData: Record<string, string> = {
    runtimeKey,
    linkUrl,
    controlKey,
    apiUrl: normalizedApiUrl,
  }
  if (email) credentialData.email = email
  if (plan) credentialData.plan = plan
  if (userId) credentialData.userId = userId

  credRepo.upsert({ accountId: account.id, poolType: "open-design-go", credentialData })

  void import("@/server/provider-models").then(({ syncProviderModelsForAccount }) =>
    syncProviderModelsForAccount(user.id, account.id, db).catch(() => undefined),
  )

  return Response.json({
    status: "success",
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      poolType: account.poolType,
    },
    models,
  })
}
