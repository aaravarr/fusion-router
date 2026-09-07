/**
 * Command Code（GOAT 套餐）
 *
 * 单 base：https://api.commandcode.ai/provider/v1（2026-09-07 实测）：
 * - POST /chat/completions（OpenAI 格式，原生）
 * - POST /messages（Anthropic 格式，原生；亦支持 x-api-key 头）
 * - POST /responses → 404 不存在（实测）→ responses 入口走网关 responses->chat 转换
 * - GET  /models → 免 key 公开（实测 67 个模型，OpenAI list 形 {id, name, context_length}，
 *   ID 含斜杠如 deepseek/deepseek-v4-flash，原样透传）
 *
 * 认证：Authorization: Bearer <key>，key 形态 user_...（Studio 创建，长期有效，CLI 与 API 同 key）。
 * 无 OAuth、无指纹要求（CLI 与 API 同端点同 key，无需伪装客户端头）。
 *
 * 用量：GET https://api.commandcode.ai/alpha/usage/summary（Bearer）
 * （契约来自客户端源码逆向，文档未公开；**持 key 可用性待实测**，解析做宽容兜底）：
 * 含 credits（monthly/purchased/free）、plan、5h 与 weekly 双窗 {used, cap, resetAt}。
 * key 验证：GET /alpha/whoami（401 错误体 {"success":false,"error":{"code":"UNAUTHORIZED",...}} 已实测）。
 *
 * 错误分类：429 = 限流退避；超窗 declined/429 错误体带 rateLimit.window:
 * "fiveHour"|"weekly" 与重置时间（resetAt）→ 账号冷却到该时间；geo 限制（GPT-5.6 Luna
 * 与 Gemini 系对中国 IP 不可用）直接透传错误。
 */

import { createHash } from "node:crypto"
import { apiFetchWithMirrorContext, type MirrorSelectionAccount } from "./api-fetch"
import type { QuotaWindow } from "./providers/types"
import type { QuotaKind } from "./types"

export const COMMAND_CODE_POOL_TYPE = "command-code" as const

/** 推理端点前缀（chat/completions 与 messages 同 base；responses 不存在）。 */
export const COMMAND_CODE_PROVIDER_BASE = "https://api.commandcode.ai/provider/v1"
/** 管理面（/alpha/whoami、/alpha/usage/summary）。 */
export const COMMAND_CODE_API_BASE = "https://api.commandcode.ai"

const REQUEST_TIMEOUT_MS = 30_000

/**
 * API key 无效（401/403，含 UNAUTHORIZED 错误码）。录入路由必须用 400
 * 而非 401 回给前端——前端 sessionFetch 会把 401 当会话过期跳登录页。
 */
export class CommandCodeApiKeyInvalidError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = "CommandCodeApiKeyInvalidError"
    this.status = status
  }
}

/**
 * /alpha/* 管理面接口不可用。两种语义由 kind 区分（录入路由据此分流）：
 * - NOT_FOUND：/alpha 前缀不存在或已迁移（404）→ 宽容降级为格式校验，
 *   照常建号并在凭据标注 commandCodeVerified=false（持 key 实测后再收紧）。
 * - UNREACHABLE：网络故障 / 5xx / 其他非预期状态 → 路由回 502，请用户重试。
 */
export class CommandCodeProbeUnavailableError extends Error {
  readonly kind: "NOT_FOUND" | "UNREACHABLE"

  constructor(message: string, kind: "NOT_FOUND" | "UNREACHABLE" = "UNREACHABLE") {
    super(message)
    this.name = "CommandCodeProbeUnavailableError"
    this.kind = kind
  }
}

// ─── key 验证（/alpha/whoami，契约待实测，宽容解析） ──────────────────────

export interface CommandCodeWhoami {
  userId: string
  plan: string
  email: string | null
}

/**
 * 宽容解析 /alpha/whoami 响应：任何对象形态都接受，best-effort 摘字段。
 * 契约来自客户端源码逆向，未公开文档，持 key 实测前不做强结构假设。
 */
export function parseCommandCodeWhoami(payload: unknown): CommandCodeWhoami | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  // 兼容 {data:{...}} envelope。
  const inner = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  const userId = stringish(inner.user_id) ?? stringish(inner.userId) ?? stringish(inner.id)
  if (!userId) return null
  return {
    userId,
    plan: stringish(inner.plan) ?? stringish(inner.planType) ?? "",
    email: stringish(inner.email),
  }
}

function stringish(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** GET /alpha/whoami。200 视为 key 有效；401/403 抛 invalid；404/5xx/网络抛 unavailable。 */
export async function verifyCommandCodeApiKey(apiKey: string, account?: MirrorSelectionAccount): Promise<CommandCodeWhoami | null> {
  let response: Response
  try {
    response = await apiFetchWithMirrorContext(`${COMMAND_CODE_API_BASE}/alpha/whoami`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { account })
  } catch (cause) {
    throw new CommandCodeProbeUnavailableError(`Command Code whoami 请求失败：${cause instanceof Error ? cause.message : String(cause)}`, "UNREACHABLE")
  }
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "")
    throw new CommandCodeApiKeyInvalidError(`Command Code API Key 验证失败（HTTP ${response.status}）: ${body.slice(0, 200)}`, response.status)
  }
  if (response.status === 404) {
    // /alpha 前缀不存在或已迁移：不阻断录入，降级为格式校验。
    throw new CommandCodeProbeUnavailableError("Command Code /alpha/whoami 返回 404（接口可能未开放）", "NOT_FOUND")
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new CommandCodeProbeUnavailableError(`Command Code whoami 失败（HTTP ${response.status}）: ${body.slice(0, 200)}`, "UNREACHABLE")
  }
  return parseCommandCodeWhoami(await response.json().catch(() => null))
}

// ─── 用量（/alpha/usage/summary，契约待实测，宽容解析） ───────────────────

export interface CommandCodeWindowRow {
  used: number
  cap: number
  resetAt: string | null
}

export interface CommandCodeUsagePayload {
  plan: string
  fiveHour: CommandCodeWindowRow | null
  weekly: CommandCodeWindowRow | null
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 毫秒与秒时间戳二分：当前毫秒时间戳约 1.7e12，阈值 1e12 足够区分。
    return new Date(value > 1e12 ? value : value * 1000).toISOString()
  }
  if (typeof value !== "string" || !value.trim()) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return new Date(n > 1e12 ? n : n * 1000).toISOString()
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function parseWindow(raw: unknown): CommandCodeWindowRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const used = toFiniteNumber(record.used)
  const cap = toFiniteNumber(record.cap ?? record.limit)
  if (used === null && cap === null) return null
  return { used: used ?? 0, cap: cap ?? 0, resetAt: toIsoOrNull(record.resetAt ?? record.reset_at ?? record.resetTime) }
}

/**
 * 宽容解析 /alpha/usage/summary：5h 窗与 weekly 窗各 best-effort 摘取
 * （键名可能是 fiveHour / five_hour / weekly / week，也可能是数组元素带
 * window: "fiveHour"|"weekly" 标记）。任何解析不出窗口的组合都返回空窗
 * 列表而非抛错，配合上游重试。
 */
export function parseCommandCodeUsage(payload: unknown): CommandCodeUsagePayload {
  const empty: CommandCodeUsagePayload = { plan: "", fiveHour: null, weekly: null }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty
  const record = payload as Record<string, unknown>
  const inner = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  const plan = stringish(inner.plan) ?? stringish(inner.planType) ?? ""
  const directFive = inner.fiveHour ?? inner.five_hour
  const directWeekly = inner.weekly ?? inner.week
  let fiveHour = parseWindow(directFive)
  let weekly = parseWindow(directWeekly)
  // 数组形态：windows / usage.windows 中每项带 window 标记（"fiveHour"|"weekly"）。
  const usageRecord = inner.usage && typeof inner.usage === "object" && !Array.isArray(inner.usage)
    ? inner.usage as Record<string, unknown>
    : null
  const arrayRaw: unknown = Array.isArray(inner.windows) ? inner.windows : usageRecord?.windows
  if ((!fiveHour || !weekly) && Array.isArray(arrayRaw)) {
    for (const item of arrayRaw) {
      if (!item || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      const label = String(row.window ?? row.name ?? row.kind ?? "").toLowerCase()
      const parsed = parseWindow(row)
      if (!parsed) continue
      if (!fiveHour && /five[_-]?hour|5h/.test(label)) fiveHour = parsed
      if (!weekly && /week/.test(label)) weekly = parsed
    }
  }
  return { plan, fiveHour, weekly }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function windowFromRow(row: CommandCodeWindowRow, kind: QuotaKind, nowMs: number): QuotaWindow {
  const usagePercent = row.cap > 0 ? clampPercent((row.used / row.cap) * 100) : 0
  const resetMs = row.resetAt ? Date.parse(row.resetAt) : Number.NaN
  const hasReset = !Number.isNaN(resetMs)
  return {
    kind,
    usagePercent,
    limitValue: row.cap || null,
    remainingValue: row.cap > 0 ? Math.max(0, row.cap - row.used) : null,
    resetAt: hasReset ? new Date(resetMs).toISOString() : null,
    resetInSeconds: hasReset ? Math.max(0, Math.ceil((resetMs - nowMs) / 1000)) : null,
    lastObservedAt: new Date(nowMs).toISOString(),
    source: "API_PROBE",
    extra: { service: "command-code" },
  }
}

/** 双窗 {used, cap, resetAt} → quota_windows（FIVE_HOUR / WEEKLY）；plan 挂 extra 透传。 */
export function windowsFromCommandCodeUsage(payload: CommandCodeUsagePayload, nowMs = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  if (payload.fiveHour) {
    const window = windowFromRow(payload.fiveHour, "FIVE_HOUR", nowMs)
    if (payload.plan) window.extra = { ...window.extra, plan: payload.plan }
    windows.push(window)
  }
  if (payload.weekly) {
    const window = windowFromRow(payload.weekly, "WEEKLY", nowMs)
    if (payload.plan) window.extra = { ...window.extra, plan: payload.plan }
    windows.push(window)
  }
  return windows
}

/** GET /alpha/usage/summary。401/403 抛 invalid，其余非 200 抛普通 Error（调用方保留旧快照）。 */
export async function fetchCommandCodeUsage(apiKey: string, account?: MirrorSelectionAccount): Promise<CommandCodeUsagePayload> {
  const response = await apiFetchWithMirrorContext(`${COMMAND_CODE_API_BASE}/alpha/usage/summary`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "")
    throw new CommandCodeApiKeyInvalidError(`Command Code 用量接口拒绝访问（HTTP ${response.status}）: ${body.slice(0, 200)}`, response.status)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Command Code 用量接口失败（HTTP ${response.status}）: ${body.slice(0, 200)}`)
  }
  return parseCommandCodeUsage(await response.json().catch(() => null))
}

// ─── 模型（/provider/v1/models 免 key，2026-09-07 实测 67 个） ────────────

/** 宽容解析 OpenAI list 形 {object:"list", data:[{id, ...}]}；字符串元素亦接受；非 JSON 输入返回 []。 */
export function parseCommandCodeModels(body: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : []
  const models = new Set<string>()
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) models.add(row.trim())
    else if (row && typeof row === "object") {
      const id = (row as { id?: unknown }).id ?? (row as { name?: unknown }).name
      if (typeof id === "string" && id.trim()) models.add(id.trim())
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b))
}

/** GET /provider/v1/models（免 key 公开，实测 67 个模型全量入库）。 */
export async function fetchCommandCodeModels(account?: MirrorSelectionAccount): Promise<string[]> {
  const response = await apiFetchWithMirrorContext(`${COMMAND_CODE_PROVIDER_BASE}/models`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  const body = await response.text()
  if (!response.ok) throw new Error(`Command Code /models 拉取失败（HTTP ${response.status}）: ${body.slice(0, 200)}`)
  return parseCommandCodeModels(body)
}

// ─── 杂项 ────────────────────────────────────────────────────────────────

/**
 * Command Code API key 形态校验。已观测形态为 `user_...`（Studio 创建，长期有效），
 * 但不做前缀硬校验（宽容，不阻断未来格式变化），仅约束长度与字符集。
 */
export function isValidCommandCodeApiKeyShape(apiKey: string): boolean {
  return /^[A-Za-z0-9_-]{12,}$/.test(apiKey)
}

export function commandCodeExternalId(apiKey: string): string {
  return createHash("sha256").update(`command-code-apikey:${apiKey}`).digest("hex").slice(0, 24)
}
