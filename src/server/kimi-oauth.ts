/**
 * Kimi Code OAuth (RFC 8628 Device Code Flow)
 * Mirrors MoonshotAI/kimi-code packages/oauth device flow.
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname, release, type as osType, arch } from "node:os"
import { join } from "node:path"
import { apiFetch, apiFetchWithMirrorContext, type MirrorSelectionAccount } from "./api-fetch"

export const KIMI_CODE_POOL_TYPE = "kimi-code" as const
export const DEFAULT_KIMI_OAUTH_HOST = "https://auth.kimi.com"
export const DEFAULT_KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1"
export const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const KIMI_CODE_PLATFORM = "kimi_code_cli"
export const KIMI_CODE_PRODUCT = "kimi-code-cli"
export const KIMI_CODE_VERSION = process.env.KIMI_CODE_VERSION?.trim() || "1.0.0"

const REQUEST_TIMEOUT_MS = 30_000
const SESSION_TTL_MS = 15 * 60_000

/**
 * refresh_token 被上游拒绝（401/403/invalid_grant）时抛出，表示凭据已失效、
 * 需要重新登录。与网络/5xx 类错误区分，调用方（provider）据此落失效标记，
 * 而不是反复用死 token 刷新。
 */
export class KimiTokenInvalidError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = "KimiTokenInvalidError"
    this.status = status
  }
}

/**
 * 刷新阈值对齐官方 oauth-manager.ts defaultRefreshThreshold：
 * `expiresIn > 0 ? max(300, expiresIn * 0.5) : 300`。
 * 官方在 token 剩余不足一半（至少 5 分钟）时就提前刷新，避免长请求中途过期。
 */
export function kimiRefreshThresholdSeconds(expiresIn: number): number {
  if (expiresIn > 0) return Math.max(300, Math.floor(expiresIn * 0.5))
  return 300
}

export interface KimiTokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
  expiresIn: number
  scope: string
  tokenType: string
}

export interface KimiDeviceAuthorization {
  userCode: string
  deviceCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number | null
  interval: number
}

export type KimiDevicePollResult =
  | { kind: "success"; token: KimiTokenInfo }
  | { kind: "pending"; errorCode: string; description: string }
  | { kind: "expired" }
  | { kind: "denied"; description: string }

export interface KimiOAuthSession {
  id: string
  ownerUserId: string
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  interval: number
  expiresAtMs: number
  createdAtMs: number
  pollAfterMs: number
}

export interface KimiUsageRow {
  label: string
  used: number
  limit: number
  resetAt: string | null
}

/**
 * Booster 钱包余额，来自官方 /usages 响应的 boosterWallet。
 * amount / amountLeft 是 fixed-point 数值（÷1_000_000 = 美分）；
 * monthlyChargeLimit / monthlyUsed 的 priceInCents 直接就是美分。
 * 参见官方 kimi-code 仓库 packages/oauth/src/managed-usage.ts。
 */
export interface KimiWalletInfo {
  /** 剩余余额（美分）。 */
  balanceCents: number
  /** 总余额（美分）。 */
  totalCents: number
  /** 是否启用了月度消费上限。 */
  monthlyChargeLimitEnabled: boolean
  /** 月度消费上限（美分）；0 表示不限额。 */
  monthlyChargeLimitCents: number
  /** 本月已消费（美分）。 */
  monthlyUsedCents: number
  /** ISO 货币代码，如 USD / CNY。 */
  currency: string
}

export interface KimiParsedUsage {
  summary: KimiUsageRow | null
  limits: KimiUsageRow[]
  /** Booster 钱包余额；无钱包（非 BOOSTER 类型）时为 null。 */
  wallet: KimiWalletInfo | null
}

type DeviceHeaders = Record<string, string>

function oauthHost(): string {
  return (process.env.KIMI_CODE_OAUTH_HOST?.trim() || process.env.KIMI_OAUTH_HOST?.trim() || DEFAULT_KIMI_OAUTH_HOST).replace(/\/+$/, "")
}

export function kimiCodeBaseUrl(): string {
  return (process.env.KIMI_CODE_BASE_URL?.trim() || DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, "")
}

function dataDir(): string {
  return process.env.OPENCODE_API_DATA_DIR?.trim() || join(process.cwd(), "data")
}

function asciiHeader(value: string, fallback = "unknown"): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/g, "").trim()
  return cleaned.length > 0 ? cleaned : fallback
}

function ensureDeviceId(): string {
  const dir = dataDir()
  const path = join(dir, "kimi-device-id")
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim()
      if (existing) return existing
    }
  } catch {
    // ignore
  }
  const id = randomUUID()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, id, { encoding: "utf8" })
  } catch {
    // ignore
  }
  return id
}

function deviceModel(): string {
  const os = osType()
  const version = release()
  const osArch = arch()
  if (os === "Darwin") return `macOS ${version} ${osArch}`
  if (os === "Windows_NT") return `Windows ${version} ${osArch}`
  return `${os} ${version} ${osArch}`.trim()
}

export function createKimiDeviceHeaders(): DeviceHeaders {
  return {
    "User-Agent": `${KIMI_CODE_PRODUCT}/${KIMI_CODE_VERSION}`,
    "X-Msh-Platform": KIMI_CODE_PLATFORM,
    "X-Msh-Version": asciiHeader(KIMI_CODE_VERSION, "1.0.0"),
    "X-Msh-Device-Name": asciiHeader(hostname()),
    "X-Msh-Device-Model": asciiHeader(deviceModel()),
    "X-Msh-Os-Version": asciiHeader(release()),
    "X-Msh-Device-Id": ensureDeviceId(),
  }
}

async function postForm(url: string, params: Record<string, string>, headers?: DeviceHeaders): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await apiFetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    // ignore
  }
  return { status: response.status, data }
}

function pickErrorDetail(data: Record<string, unknown>): string {
  for (const key of ["error_description", "message", "detail", "error"]) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return "unknown"
}

function tokenFromResponse(payload: Record<string, unknown>): KimiTokenInfo {
  const accessToken = payload.access_token
  if (typeof accessToken !== "string" || !accessToken) throw new Error("Kimi OAuth response missing access_token")
  const refreshToken = payload.refresh_token
  if (typeof refreshToken !== "string" || !refreshToken) throw new Error("Kimi OAuth response missing refresh_token")
  const expiresIn = Number(payload.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Kimi OAuth response missing valid expires_in")
  return {
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof payload.scope === "string" ? payload.scope : "",
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
  }
}

export async function requestKimiDeviceAuthorization(clientId = KIMI_CODE_CLIENT_ID): Promise<KimiDeviceAuthorization> {
  const url = `${oauthHost()}/api/oauth/device_authorization`
  const { status, data } = await postForm(url, { client_id: clientId }, createKimiDeviceHeaders())
  if (status !== 200) throw new Error(`Kimi device authorization failed (HTTP ${status}): ${pickErrorDetail(data)}`)
  const userCode = data.user_code
  const deviceCode = data.device_code
  const verificationUriComplete = data.verification_uri_complete
  if (typeof userCode !== "string" || !userCode) throw new Error("Kimi device authorization missing user_code")
  if (typeof deviceCode !== "string" || !deviceCode) throw new Error("Kimi device authorization missing device_code")
  if (typeof verificationUriComplete !== "string" || !verificationUriComplete) throw new Error("Kimi device authorization missing verification_uri_complete")
  return {
    userCode,
    deviceCode,
    verificationUri: typeof data.verification_uri === "string" ? data.verification_uri : "",
    verificationUriComplete,
    expiresIn: data.expires_in !== undefined ? Number(data.expires_in) : null,
    interval: Math.max(1, Number(data.interval ?? 5) || 5),
  }
}

export async function pollKimiDeviceToken(deviceCode: string, clientId = KIMI_CODE_CLIENT_ID): Promise<KimiDevicePollResult> {
  const url = `${oauthHost()}/api/oauth/token`
  const { status, data } = await postForm(url, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  }, createKimiDeviceHeaders())

  if (status === 200 && typeof data.access_token === "string") return { kind: "success", token: tokenFromResponse(data) }
  if (status >= 500) throw new Error(`Kimi device poll server error (HTTP ${status}): ${pickErrorDetail(data)}`)

  const errorCode = typeof data.error === "string" ? data.error : "unknown_error"
  const description = typeof data.error_description === "string" ? data.error_description : pickErrorDetail(data)
  switch (errorCode) {
    case "authorization_pending":
    case "slow_down":
      return { kind: "pending", errorCode, description }
    case "expired_token":
      return { kind: "expired" }
    case "access_denied":
      return { kind: "denied", description }
    default:
      throw new Error(`Kimi device poll failed (HTTP ${status}): ${description || errorCode}`)
  }
}

export async function refreshKimiAccessToken(refreshToken: string, clientId = KIMI_CODE_CLIENT_ID): Promise<KimiTokenInfo> {
  const url = `${oauthHost()}/api/oauth/token`
  const maxRetries = 3
  let lastError: Error | undefined
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const { status, data } = await postForm(url, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }, createKimiDeviceHeaders())
      if (status === 200 && typeof data.access_token === "string") return tokenFromResponse(data)
      const errorCode = typeof data.error === "string" ? data.error : ""
      if (status === 401 || status === 403 || errorCode === "invalid_grant") {
        throw new KimiTokenInvalidError(`Kimi refresh token invalid: ${pickErrorDetail(data)}`, status)
      }
      if ([429, 500, 502, 503, 504].includes(status) && attempt < maxRetries - 1) {
        lastError = new Error(`Kimi token refresh failed (HTTP ${status}): ${pickErrorDetail(data)}`)
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
        continue
      }
      throw new Error(`Kimi token refresh failed (HTTP ${status}): ${pickErrorDetail(data)}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError instanceof KimiTokenInvalidError) throw lastError
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
        continue
      }
    }
  }
  throw lastError ?? new Error("Kimi token refresh failed")
}

const sessionGlobal = globalThis as typeof globalThis & { __kimiOAuthSessions?: Map<string, KimiOAuthSession> }
const sessions = (sessionGlobal.__kimiOAuthSessions ??= new Map<string, KimiOAuthSession>())

function pruneSessions(now = Date.now()): void {
  for (const [id, session] of sessions) if (session.expiresAtMs <= now) sessions.delete(id)
}

export async function startKimiOAuthSession(ownerUserId: string) {
  pruneSessions()
  const auth = await requestKimiDeviceAuthorization()
  const now = Date.now()
  const session: KimiOAuthSession = {
    id: randomUUID(),
    ownerUserId,
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    verificationUriComplete: auth.verificationUriComplete,
    interval: auth.interval,
    createdAtMs: now,
    pollAfterMs: now,
    expiresAtMs: now + (auth.expiresIn && auth.expiresIn > 0 ? auth.expiresIn * 1000 : SESSION_TTL_MS),
  }
  sessions.set(session.id, session)
  return {
    sessionId: session.id,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    verificationUriComplete: session.verificationUriComplete,
    expiresIn: auth.expiresIn,
    interval: session.interval,
  }
}

export async function pollKimiOAuthSession(ownerUserId: string, sessionId: string) {
  pruneSessions()
  const session = sessions.get(sessionId)
  if (!session || session.ownerUserId !== ownerUserId) throw new Error("Kimi OAuth session missing or expired")
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(sessionId)
    return { status: "expired" as const }
  }
  const now = Date.now()
  if (now < session.pollAfterMs) {
    return {
      status: "pending" as const,
      interval: Math.max(1, Math.ceil((session.pollAfterMs - now) / 1000)),
      userCode: session.userCode,
      verificationUriComplete: session.verificationUriComplete,
    }
  }
  const result = await pollKimiDeviceToken(session.deviceCode)
  if (result.kind === "success") {
    sessions.delete(sessionId)
    return { status: "success" as const, token: result.token }
  }
  if (result.kind === "expired") {
    sessions.delete(sessionId)
    return { status: "expired" as const }
  }
  if (result.kind === "denied") {
    sessions.delete(sessionId)
    return { status: "denied" as const, description: result.description }
  }
  if (result.errorCode === "slow_down") session.interval += 5
  session.pollAfterMs = Date.now() + session.interval * 1000
  sessions.set(sessionId, session)
  return {
    status: "pending" as const,
    interval: session.interval,
    userCode: session.userCode,
    verificationUriComplete: session.verificationUriComplete,
  }
}

export function cancelKimiOAuthSession(ownerUserId: string, sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session && session.ownerUserId === ownerUserId) sessions.delete(sessionId)
}

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  return null
}

function resetAtFrom(raw: Record<string, unknown>): string | null {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const value = raw[key]
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? value : new Date(parsed).toISOString()
    }
  }
  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = toInt(raw[key])
    if (seconds !== null && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString()
  }
  return null
}

function toUsageRow(raw: unknown, defaultLabel: string): KimiUsageRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const limit = toInt(record.limit)
  let used = toInt(record.used)
  if (used === null) {
    const remaining = toInt(record.remaining)
    if (remaining !== null && limit !== null) used = limit - remaining
  }
  if (used === null && limit === null) return null
  const label = typeof record.name === "string" && record.name
    ? record.name
    : typeof record.title === "string" && record.title
      ? record.title
      : defaultLabel
  return { label, used: used ?? 0, limit: limit ?? 0, resetAt: resetAtFrom(record) }
}

const FIXED_POINT_CENTS = 1_000_000

function fixedPointToCents(value: number): number {
  const cents = value / FIXED_POINT_CENTS
  if (cents > 0 && cents < 1) return 1
  return Math.round(cents)
}

function parseMoney(raw: unknown): { cents: number; currency: string } | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const cents = toInt(record.priceInCents)
  if (cents === null) return null
  const currency = typeof record.currency === "string" ? record.currency : ""
  return { cents, currency }
}

function parseBoosterWallet(raw: unknown): KimiWalletInfo | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const balance = record.balance
  if (!balance || typeof balance !== "object") return null
  const balanceRecord = balance as Record<string, unknown>
  if (balanceRecord.type !== "BOOSTER") return null
  const amount = toInt(balanceRecord.amount)
  if (amount === null || amount <= 0) return null
  const totalCents = fixedPointToCents(amount)
  const amountLeft = toInt(balanceRecord.amountLeft)
  const balanceCents = amountLeft !== null ? fixedPointToCents(amountLeft) : 0
  const monthlyLimit = parseMoney(record.monthlyChargeLimit)
  const monthlyUsed = parseMoney(record.monthlyUsed)
  const currency =
    monthlyLimit && monthlyLimit.currency
      ? monthlyLimit.currency
      : monthlyUsed && monthlyUsed.currency
        ? monthlyUsed.currency
        : "USD"
  return {
    balanceCents,
    totalCents,
    monthlyChargeLimitEnabled: record.monthlyChargeLimitEnabled === true,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency,
  }
}

export function parseKimiUsagePayload(payload: unknown): KimiParsedUsage {
  if (!payload || typeof payload !== "object") return { summary: null, limits: [], wallet: null }
  const record = payload as Record<string, unknown>
  const summary = toUsageRow(record.usage, "Weekly limit")
  const limits: KimiUsageRow[] = []
  if (Array.isArray(record.limits)) {
    for (const [index, item] of record.limits.entries()) {
      if (!item || typeof item !== "object") continue
      const entry = item as Record<string, unknown>
      const detail = entry.detail && typeof entry.detail === "object" ? entry.detail : entry
      const window = entry.window && typeof entry.window === "object" ? entry.window as Record<string, unknown> : {}
      let label = `Limit #${index + 1}`
      for (const key of ["name", "title", "scope"]) {
        const value = entry[key] ?? (detail as Record<string, unknown>)[key]
        if (typeof value === "string" && value) { label = value; break }
      }
      const duration = toInt(window.duration ?? entry.duration)
      const timeUnit = typeof window.timeUnit === "string" ? window.timeUnit : ""
      if (duration !== null) {
        if (timeUnit.includes("MINUTE")) label = duration >= 60 && duration % 60 === 0 ? `${duration / 60}h limit` : `${duration}m limit`
        else if (timeUnit.includes("HOUR")) label = `${duration}h limit`
        else if (timeUnit.includes("DAY")) label = `${duration}d limit`
      }
      const row = toUsageRow(detail, label)
      if (row) limits.push(row)
    }
  }
  return { summary, limits, wallet: parseBoosterWallet(record.boosterWallet) }
}

export async function fetchKimiUsage(accessToken: string, account?: MirrorSelectionAccount): Promise<KimiParsedUsage> {
  const response = await apiFetchWithMirrorContext(`${kimiCodeBaseUrl()}/usages`, {
    method: "GET",
    headers: { ...createKimiDeviceHeaders(), Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  if (!response.ok) throw new Error(`Kimi /usages failed (HTTP ${response.status})`)
  return parseKimiUsagePayload(await response.json())
}

export async function fetchKimiModels(accessToken: string, account?: MirrorSelectionAccount): Promise<string[]> {
  const response = await apiFetchWithMirrorContext(`${kimiCodeBaseUrl()}/models`, {
    method: "GET",
    headers: { ...createKimiDeviceHeaders(), Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  const body = await response.text()
  if (!response.ok) throw new Error(`Kimi /models failed (HTTP ${response.status}): ${body.slice(0, 200)}`)
  const parsed = JSON.parse(body) as { data?: unknown }
  const rows = Array.isArray(parsed.data) ? parsed.data : []
  const models = new Set<string>()
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) models.add(row.trim())
    else if (row && typeof row === "object") {
      const id = (row as { id?: unknown }).id
      if (typeof id === "string" && id.trim()) models.add(id.trim())
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b))
}

/**
 * /me 用户信息，来自官方 managed-userinfo.ts 的宽松解析：
 * 只要 user_id 存在就视为有效，其余字段独立降级。
 * email/phone 为可选字段——实测企业版账号可能不返回 email。
 */
export interface KimiUserInfo {
  userId: string
  nickname: string
  status: string
  region: string
  userLevel: number
  userLevelName: string
  domain: number
  domainName: string
  globalId?: string
  email?: string
}

function userInfoString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function userInfoInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : undefined
  }
  return undefined
}

export function parseKimiUserInfoPayload(payload: unknown): KimiUserInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const userId = userInfoString(record, "user_id")
  if (!userId) return null
  return {
    userId,
    nickname: userInfoString(record, "nickname") ?? "",
    status: userInfoString(record, "status") ?? "",
    region: userInfoString(record, "region") ?? "",
    userLevel: userInfoInt(record, "user_level") ?? 0,
    userLevelName: userInfoString(record, "user_level_name") ?? "",
    domain: userInfoInt(record, "domain") ?? 0,
    domainName: userInfoString(record, "domain_name") ?? "",
    globalId: userInfoString(record, "global_id"),
    email: userInfoString(record, "email"),
  }
}

export async function fetchKimiUserInfo(accessToken: string, account?: MirrorSelectionAccount): Promise<KimiUserInfo | null> {
  const response = await apiFetchWithMirrorContext(`${kimiCodeBaseUrl()}/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  if (!response.ok) {
    // 401/403 = 凭据失效；其余按不可用处理，调用方 best-effort 忽略。
    const body = await response.text().catch(() => "")
    throw new KimiTokenInvalidError(`Kimi /me failed (HTTP ${response.status}): ${body.slice(0, 200)}`, response.status)
  }
  return parseKimiUserInfoPayload(await response.json())
}

export function kimiExternalId(subject: string | null | undefined, refreshToken: string): string {
  const identity = (subject || "").trim() || refreshToken
  return createHash("sha256").update(`kimi-code:${identity}`).digest("hex").slice(0, 24)
}

export function decodeJwtEmail(token: string | undefined | null): { email: string; subject: string } {
  if (!token) return { email: "", subject: "" }
  const parts = token.split(".")
  if (parts.length < 2) return { email: "", subject: "" }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
    return {
      email: typeof payload.email === "string" ? payload.email.trim() : "",
      subject: typeof payload.sub === "string" ? payload.sub.trim() : "",
    }
  } catch {
    return { email: "", subject: "" }
  }
}
