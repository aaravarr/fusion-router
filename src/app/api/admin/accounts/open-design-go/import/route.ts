import { createHash } from "node:crypto"
import { z } from "zod"
import { requireSession } from "../../../_auth"
import { getDatabase } from "@/server/db"
import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { apiFetch } from "@/server/api-fetch"

export const runtime = "nodejs"

const DEFAULT_API_URL = "https://amr-api.open-design.ai"
const DEFAULT_LINK_URL = "https://amr-link.open-design.ai"

function normalizeApiUrl(apiUrl?: string | null): string {
  const raw = (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "")
  return raw || DEFAULT_API_URL
}

function normalizeLinkUrl(linkUrl?: string | null): string {
  const raw = (linkUrl?.trim() || DEFAULT_LINK_URL).replace(/\/+$/, "")
  const trimmed = raw || DEFAULT_LINK_URL
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
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
  workspaceId: z.string().optional(),
})

interface AmrUser {
  id?: string
  email?: string
  name?: string
  plan?: string
}
interface AmrProfile {
  controlKey?: string
  runtimeKey?: string
  apiUrl?: string
  linkUrl?: string
  workspaceId?: string
  user?: AmrUser
}

function extractFromConfigJson(configJson: unknown): {
  runtimeKey?: string
  linkUrl?: string
  controlKey?: string
  apiUrl?: string
  email?: string
  userName?: string
  plan?: string
  userId?: string
  workspaceId?: string
} | null {
  if (!configJson || typeof configJson !== "object") return null
  const obj = configJson as Record<string, unknown>
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
  if (!profile && ("runtimeKey" in obj || "controlKey" in obj || "workspaceId" in obj)) {
    profile = obj
  }
  if (!profile) return null
  const runtimeKey = typeof profile.runtimeKey === "string" ? profile.runtimeKey.trim() : typeof (profile as Record<string, unknown>).runtime_key === "string" ? String((profile as Record<string, unknown>).runtime_key).trim() : undefined
  const linkUrl = typeof profile.linkUrl === "string" ? profile.linkUrl.trim() : typeof (profile as Record<string, unknown>).link_url === "string" ? String((profile as Record<string, unknown>).link_url).trim() : undefined
  const controlKey = typeof profile.controlKey === "string" ? profile.controlKey.trim() : typeof (profile as Record<string, unknown>).control_key === "string" ? String((profile as Record<string, unknown>).control_key).trim() : undefined
  const apiUrl = typeof profile.apiUrl === "string" ? profile.apiUrl.trim() : typeof (profile as Record<string, unknown>).api_url === "string" ? String((profile as Record<string, unknown>).api_url).trim() : undefined
  const workspaceId = typeof (profile as Record<string, unknown>).workspaceId === "string" ? String((profile as Record<string, unknown>).workspaceId).trim() : typeof (profile as Record<string, unknown>).workspace_id === "string" ? String((profile as Record<string, unknown>).workspace_id).trim() : typeof (profile as Record<string, unknown>)["x-vela-workspace-id"] === "string" ? String((profile as Record<string, unknown>)["x-vela-workspace-id"]).trim() : undefined
  const user = profile.user as AmrUser | undefined
  const email = user?.email?.trim()
  const userName = user?.name?.trim()
  const plan = user?.plan?.trim()
  const userId = user?.id?.trim()
  return { runtimeKey, linkUrl, controlKey, apiUrl, email, userName, plan, userId, workspaceId }
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
  let workspaceId: string | undefined = parsed.data.workspaceId?.trim() || undefined
  let email: string | undefined
  let userName: string | undefined
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
    runtimeKey = runtimeKey || extracted.runtimeKey
    linkUrl = linkUrl || extracted.linkUrl
    controlKey = controlKey || extracted.controlKey
    apiUrl = apiUrl || extracted.apiUrl
    email = extracted.email
    userName = extracted.userName
    plan = extracted.plan
    userId = extracted.userId
    workspaceId = workspaceId || extracted.workspaceId
  }

  linkUrl = linkUrl?.trim() || DEFAULT_LINK_URL
  if (!runtimeKey) {
    return Response.json(
      { error: { type: "validation_error", message: "缺少必要字段：runtimeKey（或提供 configJson）" } },
      { status: 400 },
    )
  }

  const normalizedApiUrl = normalizeApiUrl(apiUrl)
  const normalizedLinkUrl = normalizeLinkUrl(linkUrl)
  // 优先用 runtimeKey 验证推理面（核心），controlKey 仅用于附带拉取 wallet/balance 自动发现 workspaceId
  let models: string[] = []
  try {
    const resp = await apiFetch(`${normalizedLinkUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${runtimeKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`OpenDesign Go /models 拉取失败（HTTP ${resp.status}）: ${text.slice(0, 200)}`)
    models = parseModels(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/\b(401|403)\b/.test(message) || /invalid|unauthorized|expired|forbidden/i.test(message)) {
      return Response.json(
        { error: { type: "open_design_go_invalid", message: `OpenDesign Go 推理凭据验证失败：${message}` } },
        { status: 400 },
      )
    }
    return Response.json(
      { error: { type: "open_design_go_unreachable", message: `OpenDesign Go 上游暂时不可达：${message}` } },
      { status: 502 },
    )
  }

  // controlKey 存在时，附带拉取 wallet/balance 自动发现 workspaceId（best-effort，不阻塞导入）
  if (controlKey && !workspaceId) {
    try {
      const resp = await apiFetch(`${normalizedApiUrl}/api/v1/wallet/balance`, {
        method: "GET",
        headers: { authorization: `Bearer ${controlKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const body = await resp.text()
        try {
          const parsed = JSON.parse(body) as { workspaceId?: unknown; workspace_id?: unknown }
          const discovered = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : typeof parsed.workspace_id === "string" ? parsed.workspace_id.trim() : undefined
          if (discovered) workspaceId = discovered
        } catch {}
      }
    } catch {
      // best-effort，忽略
    }
  }

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)
  const externalId = createHash("sha256").update(`open-design-go:${controlKey ?? runtimeKey}:${runtimeKey}:${workspaceId ?? ""}`).digest("hex").slice(0, 24)

  const accountName = name?.trim() || email || userName || "OpenDesign Go"
  const account = accountRepo.createProviderAccount({
    name: accountName,
    poolType: "open-design-go",
    email: email || null,
    externalId,
    maxConcurrency: 5,
  })

  const credentialData: Record<string, string> = {
    runtimeKey,
    linkUrl: normalizedLinkUrl,
    apiUrl: normalizedApiUrl,
  }
  if (controlKey) credentialData.controlKey = controlKey
  if (email) credentialData.email = email
  if (plan) credentialData.plan = plan
  if (userId) credentialData.userId = userId
  if (workspaceId) credentialData.workspaceId = workspaceId

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
    validatedVia: "runtimeKey" as const,
    workspaceId: workspaceId ?? null,
  })
}
