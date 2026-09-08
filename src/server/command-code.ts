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
 * 个人号调管理面无需 orgId（2026-09-08 真 key 验证）。
 *
 * 用量/配额（三窗，2026-09-08 真 key 实测）：
 * - GET /alpha/billing/credits（Bearer，个人号无需 orgId）→
 *   {credits: {belowThreshold, creditThreshold, monthlyCredits, purchasedCredits,
 *   freeCredits}（三个 credits 字段都是「剩余」）, windowLimits: {limited, exceeded,
 *   fiveHour: {used, cap:14, exceeded, resetAt<毫秒时间戳>},
 *   weekly: {used, cap:35, exceeded, resetAt}}}。
 *   验证：套餐总量 70 − monthlyCredits 66.2795 = 3.7205 = 5h 窗口 used。
 * - GET /alpha/billing/subscriptions → {data: {status:"active",
 *   planId:"individual-goat", currentPeriodStart, currentPeriodEnd,
 *   cancelAtPeriodEnd}}（套餐/账期）。
 * - 套餐总量表（CLI 内置）：individual-goat=70、go=10、pro=30、pro-v1=80、
 *   provider=15、max=150、ultra=300、teams-pro=40。
 * → FIVE_HOUR / WEEKLY 窗：usagePercent=used/cap*100，resetAt=resetAt；
 *   MONTHLY 余额窗：unit="credits"，cap=套餐表[planId]（未知 planId 时兜底
 *   remaining+本账期已消耗），usagePercent=(cap−remaining)/cap*100。
 * 消耗对账：GET /alpha/usage/summary（纯消耗口径，totalCredits=账期已消耗等）→
 * 仅合并进 MONTHLY extra 作对账展示，不再单独成窗。
 * 兄弟端点 /alpha/usage/limits、/alpha/usage/rate-limits、/alpha/usage/windows、/alpha/quota 全 404。
 * 窗口/套餐调度依赖被动错误分类（403 MODEL_NOT_IN_PLAN / 429+rateLimit.window，见 providers/command-code.ts）。
 * key 验证：GET /alpha/whoami（2026-09-08 持 key 实测 200）：
 * {"success":true,"user":{"id","name","email","userName"},"org":null}——无 plan 字段。
 *
 * 错误分类：429 = 限流退避；超窗 declined/429 错误体带 rateLimit.window:
 * "fiveHour"|"weekly" 与重置时间（resetAt）→ 账号冷却到该时间；geo 限制（GPT-5.6 Luna
 * 与 Gemini 系对中国 IP 不可用）直接透传错误。
 */

import { createHash } from "node:crypto"
import { apiFetchWithMirrorContext, type MirrorSelectionAccount } from "./api-fetch"
import type { QuotaWindow } from "./providers/types"

export const COMMAND_CODE_POOL_TYPE = "command-code" as const

/** 推理端点前缀（chat/completions 与 messages 同 base；responses 不存在）。 */
export const COMMAND_CODE_PROVIDER_BASE = "https://api.commandcode.ai/provider/v1"
/** 管理面（/alpha/whoami、/alpha/billing/*、/alpha/usage/summary）。 */
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
 * 宽容解析 /alpha/whoami 响应：实测结构为 {success, user: {id, name, email, userName}, org}
 * （2026-09-08 持 key 实测）。同时兼容此前的扁平形态（user_id/userId/id 直键）与
 * data envelope，best-effort 摘字段。plan 上游不返回，恒为空串。
 */
export function parseCommandCodeWhoami(payload: unknown): CommandCodeWhoami | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  // 兼容 {data:{...}} envelope。
  const outer = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  // 实测形态：用户字段嵌套在 user 对象下。
  const inner = outer.user && typeof outer.user === "object" && !Array.isArray(outer.user)
    ? outer.user as Record<string, unknown>
    : outer
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

// ─── 账单/配额（/alpha/billing/credits + /alpha/billing/subscriptions，三窗，2026-09-08 真 key 实测） ───

/** CLI 内置套餐总量表（credits）：planId → 账期总量。未知 planId 时兜底 remaining+本账期已消耗。 */
export const COMMAND_CODE_PLAN_CREDIT_CAPS: Record<string, number> = {
  "individual-goat": 70,
  go: 10,
  pro: 30,
  "pro-v1": 80,
  provider: 15,
  max: 150,
  ultra: 300,
  "teams-pro": 40,
}

/** planId → 账号 plan 展示名。 */
export const COMMAND_CODE_PLAN_DISPLAY: Record<string, string> = {
  "individual-goat": "GOAT",
  go: "GO",
  pro: "PRO",
  "pro-v1": "PRO",
  provider: "PROVIDER",
  max: "MAX",
  ultra: "ULTRA",
  "teams-pro": "TEAMS",
}

export interface CommandCodeWindowLimit {
  /** 窗口已用 credits。 */
  used: number
  /** 窗口上限 credits。 */
  cap: number
  /** 是否已超窗。 */
  exceeded: boolean
  /** 重置时间：上游毫秒时间戳 → ISO 字符串，无则 null。 */
  resetAt: string | null
}

export interface CommandCodeCreditsPayload {
  /** 订阅月度 credits 剩余。 */
  monthlyRemaining: number
  /** 购买 credits 剩余。 */
  purchasedRemaining: number
  /** 赠送 credits 剩余。 */
  freeRemaining: number
  /** 是否低于阈值。 */
  belowThreshold: boolean
  /** 阈值（credits）。 */
  creditThreshold: number | null
  fiveHour: CommandCodeWindowLimit | null
  weekly: CommandCodeWindowLimit | null
}

export interface CommandCodeSubscriptionPayload {
  status: string
  planId: string
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
}

function toResetIso(value: unknown): string | null {
  const n = toFiniteNumber(value)
  if (n == null || n <= 0) return null
  // 上游 resetAt 为毫秒时间戳；若误传秒级同样兼容。
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

function parseWindowLimit(value: unknown): CommandCodeWindowLimit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const used = toFiniteNumber(row.used) ?? toFiniteNumber(row.usedCredits)
  const cap = toFiniteNumber(row.cap) ?? toFiniteNumber(row.limit) ?? toFiniteNumber(row.total)
  if (used == null || cap == null) return null
  return {
    used,
    cap,
    exceeded: row.exceeded === true,
    resetAt: toResetIso(row.resetAt ?? row.reset_at ?? row.resetTime),
  }
}

/** 宽容解析 /alpha/billing/credits（兼容 {credits, windowLimits} 直键与 {data:{...}} envelope）。 */
export function parseCommandCodeCredits(payload: unknown): CommandCodeCreditsPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const inner = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  const credits = inner.credits && typeof inner.credits === "object" && !Array.isArray(inner.credits)
    ? inner.credits as Record<string, unknown>
    : null
  if (!credits) return null
  // 三个 credits 字段都是「剩余」（实测：70 − 66.2795 = 3.7205 = 窗口 used）。
  const monthlyRemaining = toFiniteNumber(credits.monthlyCredits)
  const purchasedRemaining = toFiniteNumber(credits.purchasedCredits)
  const freeRemaining = toFiniteNumber(credits.freeCredits)
  if (monthlyRemaining == null && purchasedRemaining == null && freeRemaining == null) return null
  const windows = inner.windowLimits && typeof inner.windowLimits === "object" && !Array.isArray(inner.windowLimits)
    ? inner.windowLimits as Record<string, unknown>
    : null
  return {
    monthlyRemaining: monthlyRemaining ?? 0,
    purchasedRemaining: purchasedRemaining ?? 0,
    freeRemaining: freeRemaining ?? 0,
    belowThreshold: credits.belowThreshold === true,
    creditThreshold: toFiniteNumber(credits.creditThreshold),
    fiveHour: windows ? parseWindowLimit(windows.fiveHour ?? windows.five_hour ?? windows["5h"]) : null,
    weekly: windows ? parseWindowLimit(windows.weekly ?? windows.week) : null,
  }
}

/** 宽容解析 /alpha/billing/subscriptions（兼容直键与 {data:{...}} envelope）。 */
export function parseCommandCodeSubscription(payload: unknown): CommandCodeSubscriptionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const inner = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  const status = stringish(inner.status)
  const planId = stringish(inner.planId) ?? stringish(inner.plan) ?? ""
  if (!status && !planId) return null
  return {
    status: status ?? "",
    planId,
    currentPeriodStart: stringish(inner.currentPeriodStart) ?? stringish(inner.current_period_start),
    currentPeriodEnd: stringish(inner.currentPeriodEnd) ?? stringish(inner.current_period_end),
    cancelAtPeriodEnd: inner.cancelAtPeriodEnd === true,
  }
}

/** planId → 展示名（individual-goat → "GOAT"，未知回原串）。 */
export function commandCodePlanDisplay(planId: string | null | undefined): string {
  if (!planId) return ""
  return COMMAND_CODE_PLAN_DISPLAY[planId] ?? COMMAND_CODE_PLAN_DISPLAY[planId.toLowerCase()] ?? planId
}

/** GET /alpha/billing/credits。401/403 抛 invalid，其余非 200 抛普通 Error（调用方保留旧快照）。 */
export async function fetchCommandCodeCredits(apiKey: string, account?: MirrorSelectionAccount): Promise<CommandCodeCreditsPayload | null> {
  const response = await apiFetchWithMirrorContext(`${COMMAND_CODE_API_BASE}/alpha/billing/credits`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "")
    throw new CommandCodeApiKeyInvalidError(`Command Code 账单接口拒绝访问（HTTP ${response.status}）: ${body.slice(0, 200)}`, response.status)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Command Code 账单接口失败（HTTP ${response.status}）: ${body.slice(0, 200)}`)
  }
  return parseCommandCodeCredits(await response.json().catch(() => null))
}

/** GET /alpha/billing/subscriptions。best-effort：失败/缺结构返回 null（调用方用兜底口径继续）。 */
export async function fetchCommandCodeSubscription(apiKey: string, account?: MirrorSelectionAccount): Promise<CommandCodeSubscriptionPayload | null> {
  const response = await apiFetchWithMirrorContext(`${COMMAND_CODE_API_BASE}/alpha/billing/subscriptions`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "")
    throw new CommandCodeApiKeyInvalidError(`Command Code 订阅接口拒绝访问（HTTP ${response.status}）: ${body.slice(0, 200)}`, response.status)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Command Code 订阅接口失败（HTTP ${response.status}）: ${body.slice(0, 200)}`)
  }
  return parseCommandCodeSubscription(await response.json().catch(() => null))
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

/** 双窗（FIVE_HOUR/WEEKLY）行 → quota_windows：usagePercent=used/cap*100。 */
function windowFromLimit(kind: "FIVE_HOUR" | "WEEKLY", label: string, row: CommandCodeWindowLimit, nowMs: number, extra: Record<string, unknown>): QuotaWindow {
  const usagePercent = row.cap > 0 ? clampPercent((row.used / row.cap) * 100) : 0
  const resetMs = row.resetAt ? Date.parse(row.resetAt) : Number.NaN
  return {
    kind,
    usagePercent,
    limitValue: row.cap,
    remainingValue: row.cap > 0 ? Math.max(0, row.cap - row.used) : null,
    resetAt: row.resetAt,
    resetInSeconds: !Number.isNaN(resetMs) ? Math.max(0, Math.ceil((resetMs - nowMs) / 1000)) : null,
    lastObservedAt: new Date(nowMs).toISOString(),
    source: "API_PROBE",
    unit: "credits",
    extra: { service: label, used: row.used, cap: row.cap, exceeded: row.exceeded, ...extra },
  }
}

export interface CommandCodeQuotaInput {
  credits: CommandCodeCreditsPayload
  subscription: CommandCodeSubscriptionPayload | null
  /** /alpha/usage/summary（可选）：仅作 MONTHLY extra 对账数据与兜底 cap 的消耗口径。 */
  usage?: CommandCodeUsagePayload | null
}

/**
 * 账单三窗 → quota_windows：
 * - FIVE_HOUR / WEEKLY：usagePercent=used/cap*100，resetsAt=resetAt。
 * - MONTHLY（余额窗）：unit="credits"；cap=套餐表[planId]，找不到时兜底
 *   remaining + 本账期已消耗（summary 的 totalMonthlyCredits）；usagePercent=
 *   (cap−remaining)/cap*100；extra 挂 remaining/purchased/free/cap/planId/
 *   periodStart/periodEnd/belowThreshold + summary 对账字段。
 * 任意输入都不抛错；credits 为空时至少按 summary 口径产出 MONTHLY 信息窗（兼容旧快照）。
 */
export function windowsFromCommandCodeQuota(input: CommandCodeQuotaInput, nowMs = Date.now()): QuotaWindow[] {
  const nowIso = new Date(nowMs).toISOString()
  const windows: QuotaWindow[] = []
  const usage = input.usage ?? null
  const planId = input.subscription?.planId ?? ""
  const planCap = planId ? (COMMAND_CODE_PLAN_CREDIT_CAPS[planId] ?? COMMAND_CODE_PLAN_CREDIT_CAPS[planId.toLowerCase()]) : undefined
  const periodExtra: Record<string, unknown> = planId ? { planId } : {}
  if (input.subscription?.currentPeriodStart) periodExtra.periodStart = input.subscription.currentPeriodStart
  if (input.subscription?.currentPeriodEnd) periodExtra.periodEnd = input.subscription.currentPeriodEnd
  if (input.subscription?.status) periodExtra.subscriptionStatus = input.subscription.status

  if (input.credits.fiveHour) {
    windows.push(windowFromLimit("FIVE_HOUR", "command-code", input.credits.fiveHour, nowMs, periodExtra))
  }
  if (input.credits.weekly) {
    windows.push(windowFromLimit("WEEKLY", "command-code", input.credits.weekly, nowMs, periodExtra))
  }

  const remaining = input.credits.monthlyRemaining
  const consumed = usage?.totalMonthlyCredits ?? usage?.totalCredits ?? 0
  const cap = planCap ?? remaining + Math.max(0, consumed)
  const monthlyUsage = cap > 0 ? clampPercent(((cap - remaining) / cap) * 100) : 0
  const monthlyExtra: Record<string, unknown> = {
    service: "command-code",
    remaining,
    purchased: input.credits.purchasedRemaining,
    free: input.credits.freeRemaining,
    cap,
    ...periodExtra,
    belowThreshold: input.credits.belowThreshold,
  }
  if (input.credits.creditThreshold != null) monthlyExtra.creditThreshold = input.credits.creditThreshold
  if (usage) {
    monthlyExtra.periodBasis = usage.periodBasis
    monthlyExtra.totalCredits = usage.totalCredits
    monthlyExtra.totalFreeCredits = usage.totalFreeCredits
    monthlyExtra.totalMonthlyCredits = usage.totalMonthlyCredits
    monthlyExtra.totalPurchasedCredits = usage.totalPurchasedCredits
    monthlyExtra.totalCount = usage.totalCount
    monthlyExtra.completedCount = usage.completedCount
    monthlyExtra.failedCount = usage.failedCount
    monthlyExtra.totalTokens = usage.totalTokens
    monthlyExtra.totalTokensIn = usage.totalTokensIn
    monthlyExtra.totalTokensOut = usage.totalTokensOut
  }
  windows.push({
    kind: "MONTHLY",
    usagePercent: monthlyUsage,
    limitValue: cap > 0 ? cap : null,
    remainingValue: remaining,
    resetAt: input.subscription?.currentPeriodEnd ?? null,
    resetInSeconds: input.subscription?.currentPeriodEnd
      ? Math.max(0, Math.ceil((Date.parse(input.subscription.currentPeriodEnd) - nowMs) / 1000))
      : null,
    lastObservedAt: nowIso,
    source: "API_PROBE",
    unit: "credits",
    extra: monthlyExtra,
  })
  return windows
}

// ─── 用量（/alpha/usage/summary，纯消耗对账，2026-09-08 持 key 实测） ────────

export interface CommandCodeUsagePayload {
  /** 账期内请求总数。 */
  totalCount: number
  /** 账期内成功/失败请求数。 */
  completedCount: number
  failedCount: number
  /** 账期累计消耗 credits（= totalFreeCredits + totalMonthlyCredits + totalPurchasedCredits）。 */
  totalCredits: number
  totalFreeCredits: number
  totalMonthlyCredits: number
  totalPurchasedCredits: number
  /** 账期内 token 消耗。 */
  totalTokens: number
  totalTokensIn: number
  totalTokensOut: number
  /** 统计口径，实测为 "billing-period"。 */
  periodBasis: string
}

function toFiniteNumberLoose(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 宽容解析 /alpha/usage/summary。实测响应（200）：
 * {totalCount, totalCost, averageCost, successRate, completedCount, failedCount,
 *  totalTokensIn, totalTokensOut, totalTokens, totalCredits, totalFreeCredits,
 *  totalMonthlyCredits, totalPurchasedCredits, periodBasis: "billing-period"}
 * 所有数值字段缺省落 0，periodBasis 缺省空串；任何输入都不抛错。
 */
export function parseCommandCodeUsage(payload: unknown): CommandCodeUsagePayload {
  const empty: CommandCodeUsagePayload = {
    totalCount: 0, completedCount: 0, failedCount: 0,
    totalCredits: 0, totalFreeCredits: 0, totalMonthlyCredits: 0, totalPurchasedCredits: 0,
    totalTokens: 0, totalTokensIn: 0, totalTokensOut: 0,
    periodBasis: "",
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty
  const record = payload as Record<string, unknown>
  const inner = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  return {
    totalCount: toFiniteNumberLoose(inner.totalCount) ?? 0,
    completedCount: toFiniteNumberLoose(inner.completedCount) ?? 0,
    failedCount: toFiniteNumberLoose(inner.failedCount) ?? 0,
    totalCredits: toFiniteNumberLoose(inner.totalCredits) ?? 0,
    totalFreeCredits: toFiniteNumberLoose(inner.totalFreeCredits) ?? 0,
    totalMonthlyCredits: toFiniteNumberLoose(inner.totalMonthlyCredits) ?? 0,
    totalPurchasedCredits: toFiniteNumberLoose(inner.totalPurchasedCredits) ?? 0,
    totalTokens: toFiniteNumberLoose(inner.totalTokens) ?? 0,
    totalTokensIn: toFiniteNumberLoose(inner.totalTokensIn) ?? 0,
    totalTokensOut: toFiniteNumberLoose(inner.totalTokensOut) ?? 0,
    periodBasis: stringish(inner.periodBasis) ?? "",
  }
}

/**
 * @deprecated 改用 windowsFromCommandCodeQuota（三窗：双窗已用比 + MONTHLY 余额窗）。
 * 保留仅为兼容旧快照回放：单 MONTHLY 信息窗（usagePercent 固定 0，不触发路由拉黑）。
 */
export function windowsFromCommandCodeUsage(payload: CommandCodeUsagePayload, nowMs = Date.now()): QuotaWindow[] {
  const nowIso = new Date(nowMs).toISOString()
  return [{
    kind: "MONTHLY",
    usagePercent: 0,
    limitValue: null,
    remainingValue: null,
    resetAt: null,
    resetInSeconds: null,
    lastObservedAt: nowIso,
    source: "API_PROBE",
    unit: "credits",
    extra: {
      service: "command-code",
      periodBasis: payload.periodBasis,
      totalCredits: payload.totalCredits,
      totalFreeCredits: payload.totalFreeCredits,
      totalMonthlyCredits: payload.totalMonthlyCredits,
      totalPurchasedCredits: payload.totalPurchasedCredits,
      totalCount: payload.totalCount,
      completedCount: payload.completedCount,
      failedCount: payload.failedCount,
      totalTokens: payload.totalTokens,
      totalTokensIn: payload.totalTokensIn,
      totalTokensOut: payload.totalTokensOut,
    },
  }]
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

/**
 * GET /provider/v1/models。免 key 公开（2026-09-08 实测：无认证与带 key 均为
 * 200、同 67 个模型），无需凭据即可同步全量目录。
 */
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

// ─── 模型 ID 裸名匹配（{model} → {provider}/{model}，仅 command-code 池范围） ──

/**
 * 模型 ID 解析结果三态：
 * - EXACT：请求串精确命中目录（含带斜杠全 ID 原样、裸名恰为某全 ID）→ matched 原样；
 * - UNIQUE_SUFFIX：请求串不含斜杠、非精确命中，但恰好是一个目录 ID 的「/」后缀
 *   → matched 为该全 ID（上行 body 的 model 必须改写成它）；
 * - AMBIGUOUS / MISS：多个候选或零候选 → matched 为 null。
 */
export type CommandCodeModelMatch = {
  kind: "EXACT" | "UNIQUE_SUFFIX"
  matched: string
} | {
  kind: "AMBIGUOUS" | "MISS"
  matched: null
  candidates: string[]
}

/**
 * 在 command-code 模型目录中解析请求模型 ID。
 * 目录元素大小写保留、匹配大小写不敏感（上游目录观测到混合大小写，
 * 如 moonshotai/Kimi-K3、zai-org/GLM-5.3）；匹配按字面（含大小写变体）后缀，
 * 不做任何语义推断。精确匹配优先；裸名唯一后缀映射到全 ID；多候选=歧义、
 * 零候选=未命中。未提供目录时只能做精确判断（EXACT 或 MISS）。
 */
export function matchCommandCodeModel(requested: string, catalog: readonly string[]): CommandCodeModelMatch {
  const trimmed = requested.trim()
  if (!trimmed) return { kind: "MISS", matched: null, candidates: [] }
  const lower = trimmed.toLowerCase()
  for (const model of catalog) {
    if (model.trim().toLowerCase() === lower) return { kind: "EXACT", matched: model }
  }
  if (trimmed.includes("/")) {
    return { kind: "MISS", matched: null, candidates: [] }
  }
  // 唯一后缀：全 ID 的 "/" 后段恰为请求裸名（大小写不敏感）。
  const candidates: string[] = []
  for (const model of catalog) {
    const slash = model.indexOf("/")
    if (slash < 0 || slash === model.length - 1) continue
    if (model.slice(slash + 1).toLowerCase() === lower) candidates.push(model)
  }
  if (candidates.length === 1) return { kind: "UNIQUE_SUFFIX", matched: candidates[0] }
  if (candidates.length > 1) return { kind: "AMBIGUOUS", matched: null, candidates: candidates.sort((a, b) => a.localeCompare(b)) }
  return { kind: "MISS", matched: null, candidates: [] }
}
