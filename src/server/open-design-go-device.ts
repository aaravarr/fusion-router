/**
 * Open Design GO Device Code Flow
 * 仿 kimi-oauth 会话管理，适配实测协议：
 * Step1 POST {apiUrl}/api/v1/cli/device-authorizations {cliVersion,host,profile}
 * Step2 POST {apiUrl}/api/v1/cli/device-authorizations/{deviceId}/token {deviceSecret}
 */

import { createHash, randomUUID } from "node:crypto"
import { getDatabase } from "./db"
import { apiFetch } from "./api-fetch"
import { AccountRepository, ProviderCredentialRepository } from "./repository"
import { normalizeOpenDesignGoApiUrl, normalizeOpenDesignGoBaseUrl } from "./providers/open-design-go"

const DEFAULT_API_URL = "https://amr-api.open-design.ai"
const REQUEST_TIMEOUT_MS = 30000
const SESSION_TTL_MS = 15 * 60 * 1000

export interface OpenDesignGoDeviceSession {
  id: string
  ownerUserId: string
  deviceId: string
  deviceSecret: string
  userCode: string
  activationUrl: string
  pollIntervalSeconds: number
  expiresAtMs: number
  createdAtMs: number
  apiUrl: string
}

export interface OpenDesignGoDeviceStartResult {
  sessionId: string
  userCode: string
  activationUrl: string
  pollIntervalSeconds: number
  expiresIn: number
}

export type OpenDesignGoDevicePollResult =
  | { status: "pending"; pollIntervalSeconds: number }
  | { status: "approved"; account: { id: string; name: string; email: string | null; poolType: string }; workspaceId?: string | null }
  | { status: "denied"; message?: string }
  | { status: "expired"; message?: string }
  | { status: "invalid_secret"; message?: string }

const sessionGlobal = globalThis as typeof globalThis & { __openDesignGoDeviceSessions?: Map<string, OpenDesignGoDeviceSession> }
const sessions = (sessionGlobal.__openDesignGoDeviceSessions ??= new Map<string, OpenDesignGoDeviceSession>())

function pruneSessions(now = Date.now()): void {
  for (const [id, session] of sessions) if (session.expiresAtMs <= now) sessions.delete(id)
}

function getApiUrl(): string {
  const raw = process.env.OPEN_DESIGN_GO_API_URL?.trim() || DEFAULT_API_URL
  return normalizeOpenDesignGoApiUrl(raw)
}

function generateHost(): string {
  // 随机短标识，8位 hex
  return "host-" + randomUUID().slice(0, 8)
}

export async function startOpenDesignGoDeviceSession(ownerUserId: string, options?: { apiUrl?: string }): Promise<OpenDesignGoDeviceStartResult> {
  pruneSessions()
  const apiUrl = normalizeOpenDesignGoApiUrl(options?.apiUrl || getApiUrl())
  const host = generateHost()
  const url = `${apiUrl}/api/v1/cli/device-authorizations`
  const resp = await apiFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ cliVersion: "0.0.33", host, profile: "prod" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const bodyText = await resp.text()
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(bodyText) as Record<string, unknown> } catch {}
  if (resp.status !== 201 && resp.status !== 200) {
    throw new Error(`创建设备码失败（HTTP ${resp.status}）：${bodyText.slice(0, 300)}`)
  }
  const deviceId = typeof data.deviceId === "string" ? data.deviceId : typeof (data as Record<string, unknown>).device_id === "string" ? String((data as Record<string, unknown>).device_id) : undefined
  const userCode = typeof data.userCode === "string" ? data.userCode : typeof (data as Record<string, unknown>).user_code === "string" ? String((data as Record<string, unknown>).user_code) : undefined
  const deviceSecret = typeof data.deviceSecret === "string" ? data.deviceSecret : typeof (data as Record<string, unknown>).device_secret === "string" ? String((data as Record<string, unknown>).device_secret) : undefined
  const activationUrl = typeof data.activationUrl === "string" ? data.activationUrl : typeof (data as Record<string, unknown>).activation_url === "string" ? String((data as Record<string, unknown>).activation_url) : undefined
  const pollIntervalSeconds = typeof data.pollIntervalSeconds === "number" ? data.pollIntervalSeconds : typeof (data as Record<string, unknown>).pollIntervalSeconds === "number" ? Number((data as Record<string, unknown>).pollIntervalSeconds) : typeof (data as Record<string, unknown>).poll_interval_seconds === "number" ? Number((data as Record<string, unknown>).poll_interval_seconds) : 2
  const expiresAtRaw = typeof data.expiresAt === "string" ? data.expiresAt : typeof (data as Record<string, unknown>).expires_at === "string" ? String((data as Record<string, unknown>).expires_at) : undefined

  if (!deviceId || !userCode || !deviceSecret || !activationUrl) {
    throw new Error(`设备码响应缺少必要字段：${bodyText.slice(0, 300)}`)
  }
  const now = Date.now()
  let expiresAtMs: number
  if (expiresAtRaw) {
    const parsed = Date.parse(expiresAtRaw)
    expiresAtMs = Number.isNaN(parsed) ? now + SESSION_TTL_MS : parsed
  } else {
    expiresAtMs = now + SESSION_TTL_MS
  }
  const sessionId = randomUUID()
  const session: OpenDesignGoDeviceSession = {
    id: sessionId,
    ownerUserId,
    deviceId,
    deviceSecret,
    userCode,
    activationUrl,
    pollIntervalSeconds: Math.max(1, pollIntervalSeconds || 2),
    expiresAtMs,
    createdAtMs: now,
    apiUrl,
  }
  sessions.set(sessionId, session)
  const expiresIn = Math.max(1, Math.ceil((expiresAtMs - now) / 1000))
  return { sessionId, userCode, activationUrl, pollIntervalSeconds: session.pollIntervalSeconds, expiresIn }
}

export function cancelOpenDesignGoDeviceSession(ownerUserId: string, sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.ownerUserId !== ownerUserId) return false
  sessions.delete(sessionId)
  return true
}

function getSession(ownerUserId: string, sessionId: string): OpenDesignGoDeviceSession {
  pruneSessions()
  const session = sessions.get(sessionId)
  if (!session) throw new Error("设备码会话不存在或已过期")
  if (session.ownerUserId !== ownerUserId) throw new Error("无权访问该设备码会话")
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(sessionId)
    throw new Error("设备码已过期")
  }
  return session
}

export async function pollOpenDesignGoDeviceSession(ownerUserId: string, sessionId: string): Promise<OpenDesignGoDevicePollResult> {
  const session = getSession(ownerUserId, sessionId)
  const url = `${session.apiUrl}/api/v1/cli/device-authorizations/${encodeURIComponent(session.deviceId)}/token`
  const resp = await apiFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ deviceSecret: session.deviceSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const bodyText = await resp.text()
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(bodyText) as Record<string, unknown> } catch {}

  if (resp.status === 401) {
    // invalid_device_secret
    const msg = typeof data.error === "string" ? data.error : bodyText.slice(0, 200)
    // 清理会话避免死循环
    sessions.delete(sessionId)
    return { status: "invalid_secret", message: msg || "invalid_device_secret" }
  }
  if (!resp.ok) {
    throw new Error(`轮询设备码失败（HTTP ${resp.status}）：${bodyText.slice(0, 300)}`)
  }

  const status = typeof data.status === "string" ? data.status : undefined

  if (status === "pending") {
    return { status: "pending", pollIntervalSeconds: session.pollIntervalSeconds }
  }
  if (status === "denied") {
    sessions.delete(sessionId)
    return { status: "denied", message: typeof data.error === "string" ? data.error : "授权被拒绝" }
  }
  if (status === "expired") {
    sessions.delete(sessionId)
    return { status: "expired", message: "设备码已过期" }
  }
  if (status === "approved") {
    // 提取凭据
    const controlKey = typeof data.controlKey === "string" ? data.controlKey : typeof (data as Record<string, unknown>).control_key === "string" ? String((data as Record<string, unknown>).control_key) : undefined
    const runtimeKey = typeof data.runtimeKey === "string" ? data.runtimeKey : typeof (data as Record<string, unknown>).runtime_key === "string" ? String((data as Record<string, unknown>).runtime_key) : undefined
    const apiUrl = typeof data.apiUrl === "string" ? data.apiUrl : typeof (data as Record<string, unknown>).api_url === "string" ? String((data as Record<string, unknown>).api_url) : session.apiUrl
    const linkUrl = typeof data.linkUrl === "string" ? data.linkUrl : typeof (data as Record<string, unknown>).link_url === "string" ? String((data as Record<string, unknown>).link_url) : undefined
    const user = (data.user as Record<string, unknown> | null) ?? (data as Record<string, unknown>).user as Record<string, unknown> | undefined
    const email = user && typeof user.email === "string" ? user.email.trim() : undefined
    const name = user && typeof user.name === "string" ? user.name.trim() : undefined
    const userId = user && typeof user.id === "string" ? user.id.trim() : user && typeof user.authUserId === "string" ? String(user.authUserId).trim() : undefined

    if (!runtimeKey) {
      throw new Error("设备授权成功但缺少 runtimeKey")
    }

    // 规范化
    const normalizedLinkUrl = normalizeOpenDesignGoBaseUrl(linkUrl || undefined)
    const normalizedApiUrl = normalizeOpenDesignGoApiUrl(apiUrl || session.apiUrl)

    let workspaceId: string | undefined
    // 若 controlKey 存在，尝试拉取 wallet/balance 自动发现 workspaceId
    if (controlKey) {
      try {
        const walletResp = await apiFetch(`${normalizedApiUrl}/api/v1/wallet/balance`, {
          method: "GET",
          headers: { authorization: `Bearer ${controlKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (walletResp.ok) {
          const walletText = await walletResp.text()
          try {
            const walletData = JSON.parse(walletText) as Record<string, unknown>
            const discovered = typeof walletData.workspaceId === "string" ? walletData.workspaceId.trim() : typeof walletData.workspace_id === "string" ? String(walletData.workspace_id).trim() : undefined
            if (discovered) workspaceId = discovered
          } catch {}
        }
      } catch {
        // best-effort
      }
    }

    // 建账号
    const db = getDatabase()
    const accountRepo = new AccountRepository(ownerUserId, db)
    const credRepo = new ProviderCredentialRepository(ownerUserId, db)
    const externalId = createHash("sha256").update(`open-design-go:${controlKey ?? runtimeKey}:${runtimeKey}:${workspaceId ?? ""}`).digest("hex").slice(0, 24)
    const accountName = name || email || "Open Design GO"
    const account = accountRepo.createProviderAccount({
      name: accountName,
      poolType: "open-design-go",
      email: email || null,
      externalId,
    })
    const credentialData: Record<string, string> = {
      runtimeKey,
      linkUrl: normalizedLinkUrl,
      apiUrl: normalizedApiUrl,
    }
    if (controlKey) credentialData.controlKey = controlKey
    if (email) credentialData.email = email
    if (userId) credentialData.userId = userId
    if (workspaceId) credentialData.workspaceId = workspaceId

    credRepo.upsert({ accountId: account.id, poolType: "open-design-go", credentialData })

    // 清理会话
    sessions.delete(sessionId)

    void import("./provider-models").then(({ syncProviderModelsForAccount }) =>
      syncProviderModelsForAccount(ownerUserId, account.id, db).catch(() => undefined),
    )

    return { status: "approved", account: { id: account.id, name: account.name, email: account.email, poolType: account.poolType }, workspaceId: workspaceId ?? null }
  }

  // 未知状态，按 pending 处理
  return { status: "pending", pollIntervalSeconds: session.pollIntervalSeconds }
}

// For testing: allow clearing
export function _clearSessionsForTest(): void { sessions.clear() }
export function _getSessionForTest(sessionId: string): OpenDesignGoDeviceSession | undefined { return sessions.get(sessionId) }
