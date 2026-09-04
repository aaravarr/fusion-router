/**
 * GLM Coding Plan（智谱 Bigmodel / Z.AI Coding Plan）
 *
 * 上游三端点（2026-09-04 真实 key curl 实测，全部 200）：
 * - chat:      https://open.bigmodel.cn/api/coding/paas/v4/chat/completions（OpenAI chat，含 reasoning_content）
 * - responses: https://open.bigmodel.cn/api/v1/responses（OpenAI Responses，resp_ 前缀，注意不在 coding 路径下）
 * - messages:  https://open.bigmodel.cn/api/anthropic/v1/messages（Anthropic 格式，thinking 块带 signature）
 * 国际版同构，域名 api.z.ai。
 *
 * 配额：GET https://open.bigmodel.cn/api/monitor/usage/quota/limit（Bearer）
 * unit=3 → 5 小时滚动窗（FIVE_HOUR），unit=6 → 周窗（WEEKLY），
 * nextResetTime 为毫秒时间戳，percentage 为已用百分比，level 为套餐等级。
 *
 * OAuth：ZCode server-mediated 设备流（2026-09-04 实测 + 社区复刻
 * TriDefender/zcode-api src/auth/oauth.ts 交叉验证）：
 * 1. POST https://zcode.z.ai/api/v1/oauth/cli/init，必须带
 *    `Authorization: Bearer <客户端生成的 64 位 hex>`（缺失 → 400 {"code":3004,"msg":"invalid_flow"}，
 *    实测确认），body {"provider":"bigmodel"（国内）|"zai"（国际）}。
 * 2. 响应 envelope {code, msg, data}，成功 code===0；data =
 *    {flow_id, poll_token, authorize_url, expires_at(Unix 秒), poll_interval_sec}。
 *    authorize_url 的 redirect 指向 zcode.z.ai 自有回调，浏览器不会回到本地，无需回调服务器。
 * 3. GET /api/v1/oauth/cli/poll/{flow_id}，`Authorization: Bearer <init 返回的 poll_token>`
 *    （实测：服务器签发的 poll_token 与 init 客户端 token 均可，随机 token → 400 invalid_flow）。
 *    data.status = pending | ready | failed；ready 形态（zcode-api 源码，需真人授权无法离线实测）：
 *    {status:"ready", token:<zcode plan JWT>, bigmodel|zai:{access_token}, user:{user_id}}。
 * 4. 凭据兑换（zcode-api README："Resolve your coding-plan API key automatically"）：OAuth
 *    access_token 不能长期使用，官方客户端/复刻项目都会经 bigmodel.cn/api.z.ai 的 biz API
 *    自动创建名为 zcode-api-key 的 API key（形态 `{apiKey}.{secret}`，与控制台手建的 key 同构）。
 *    最终凭据按长期 API key 处理：无过期、无刷新。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { apiFetch, apiFetchWithMirrorContext, type MirrorSelectionAccount } from "./api-fetch"
import type { QuotaWindow } from "./providers/types"
import type { QuotaKind } from "./types"

export const GLM_CODING_POOL_TYPE = "glm-coding" as const

/**
 * ZCode 指纹版本常量。
 * 来源：本机 ZCode 3.9.1 desktop app.asar 逆向 + 生产日志实证（2026-09-04）。
 * 转发 GLM 上游时固定该 UA（不透传客户端 UA）是拿到 1.5 倍折扣的关键。
 */
export const ZCODE_APP_VERSION = process.env.ZCODE_APP_VERSION?.trim() || "3.9.1"
/** X-Title 的后半段：官方 electron 客户端为 "Z Code@electron"。 */
export const ZCODE_SOURCE_TITLE = process.env.ZCODE_SOURCE_TITLE?.trim() || "electron"

/** zcode.z.ai API（cli-login 流）。 */
export const ZCODE_API_BASE = "https://zcode.z.ai/api/v1"
/** OAuth init 时自动创建/复用的 coding-plan API key 名称（zcode-api 复刻值）。 */
export const GLM_OAUTH_API_KEY_NAME = "zcode-api-key"

const REQUEST_TIMEOUT_MS = 30_000
/** OAuth flow 存活上限（上游 expires_at 之外的第二道保险）。 */
const SESSION_TTL_MS = 15 * 60_000

export type GlmRegion = "cn" | "global"

/**
 * API key 无效（401/403）。调用方（apikey 录入路由）必须用 400 而非 401
 * 回给前端——前端 sessionFetch 把 401 当会话过期跳登录页。
 */
export class GlmApiKeyInvalidError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = "GlmApiKeyInvalidError"
    this.status = status
  }
}

/** OAuth 流程性失败（init/poll 非 200、envelope code!=0 且非 invalid_flow 类）。 */
export class GlmOAuthFlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GlmOAuthFlowError"
  }
}

// ─── 端点/base_url 表 ─────────────────────────────────────────────────────

export interface GlmEndpointBases {
  /** chat/completions 端点前缀（coding 路径）。 */
  chat: string
  /** responses 端点前缀（不在 coding 路径下）。 */
  responses: string
  /** Anthropic messages 端点前缀。 */
  messages: string
  /** 用量查询 host（.../api/monitor/usage/quota/limit）。 */
  monitorHost: string
  /** biz API host（OAuth 兑换 API key 用）。 */
  bizHost: string
  /** zcode.z.ai cli/init 的 provider 参数。 */
  oauthProvider: "bigmodel" | "zai"
}

const CN_BASES: GlmEndpointBases = {
  chat: "https://open.bigmodel.cn/api/coding/paas/v4",
  responses: "https://open.bigmodel.cn/api/v1",
  messages: "https://open.bigmodel.cn/api/anthropic/v1",
  monitorHost: "https://open.bigmodel.cn",
  bizHost: "https://bigmodel.cn",
  oauthProvider: "bigmodel",
}

const GLOBAL_BASES: GlmEndpointBases = {
  chat: "https://api.z.ai/api/coding/paas/v4",
  responses: "https://api.z.ai/api/v1",
  messages: "https://api.z.ai/api/anthropic/v1",
  monitorHost: "https://api.z.ai",
  bizHost: "https://api.z.ai",
  oauthProvider: "zai",
}

export function glmEndpointBases(region: GlmRegion = "cn"): GlmEndpointBases {
  return region === "global" ? GLOBAL_BASES : CN_BASES
}

/** ForwardRequestInput.endpoint（"chat/completions" | "responses" | "messages"）→ base。 */
export function glmBaseForEndpoint(endpoint: string, region: GlmRegion = "cn"): string | null {
  const bases = glmEndpointBases(region)
  const normalized = endpoint.replace(/^\/+/, "")
  if (normalized === "chat/completions") return bases.chat
  if (normalized === "responses") return bases.responses
  if (normalized === "messages") return bases.messages
  return null
}

// ─── ZCode 指纹头 ─────────────────────────────────────────────────────────

function serverTimezone(): string {
  // 参照 zcode 取值风格（Intl IANA 时区名，如 Asia/Shanghai）；取值失败退 UTC+8 偏移格式。
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"
  } catch {
    return "UTC+8"
  }
}

/** 进程级 ZCode session uuid（X-Session-Id：进程级或账号级，这里取进程级）。 */
let processSessionId = ""
function zcodeSessionId(): string {
  processSessionId ||= randomUUID()
  return processSessionId
}

export interface ZcodeIdentityInput {
  /** 每账号持久化的 hex 设备 ID（provider_credentials.data.deviceMid）。 */
  deviceMid?: string | null
  /** 测试注入用；缺省取进程级 session。 */
  sessionId?: string | null
}

/**
 * 构造 ZCode 客户端指纹头（转发 GLM 上游时整体注入并覆盖客户端同名头）。
 * 清单与取值来自 ZCode 3.9.1 app.asar 逆向 + 生产日志实证；zcode-api
 * src/proxy/identity.ts（bundle `pio` 逐字段复刻）交叉印证。
 *
 * TODO(zcode-signing): zcode 对推理路径存在 Ed25519 + PoW 请求签名
 * （x-client-ts/x-client-version/x-client-sig/x-client-nonce/x-client-pow），
 * 但 isUnsignedModelRequestPath 对模型推理端点豁免且校验 fail-open，
 * 生产日志确认不签名可用 1.5 倍折扣，故暂不实现。
 */
export function createZcodeIdentityHeaders(input: ZcodeIdentityInput = {}): Record<string, string> {
  return {
    "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": `Z Code@${ZCODE_SOURCE_TITLE}`,
    "X-ZCode-App-Version": ZCODE_APP_VERSION,
    "X-Platform": "win32-x64",
    "X-Os-Category": "windows",
    "X-Release-Channel": "production",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": serverTimezone(),
    ...(input.deviceMid ? { "X-Device-Mid": input.deviceMid } : {}),
    "X-Session-Id": input.sessionId || zcodeSessionId(),
  }
}

/** 每账号生成一次并持久化到凭据 data.deviceMid 的 hex 设备 ID。 */
export function newGlmDeviceMid(): string {
  return randomBytes(16).toString("hex")
}

// ─── 用量/配额 ────────────────────────────────────────────────────────────

export interface GlmQuotaLimitRow {
  type: string
  /** 3 = 5 小时滚动窗，6 = 周窗。 */
  unit: number
  number: number
  /** 窗口总额。 */
  usage: number
  /** 已用。 */
  currentValue: number
  /** 剩余。 */
  remaining: number
  /** 已用百分比（0-100）。 */
  percentage: number
  /** 毫秒时间戳。 */
  nextResetTime: number
}

export interface GlmQuotaPayload {
  level: string
  limits: GlmQuotaLimitRow[]
}

/** 实测响应样例（2026-09-04）：{"code":200,"data":{"limits":[{...unit:3...},{...unit:6...}],"level":"pro"},"success":true} */
export function parseGlmQuotaPayload(payload: unknown): GlmQuotaPayload | null {
  if (!payload || typeof payload !== "object") return null
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  const limits: GlmQuotaLimitRow[] = []
  if (Array.isArray(record.limits)) {
    for (const item of record.limits) {
      if (!item || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      const unit = Number(row.unit)
      const nextResetTime = Number(row.nextResetTime)
      if (!Number.isFinite(unit) || !Number.isFinite(nextResetTime)) continue
      limits.push({
        type: typeof row.type === "string" ? row.type : "",
        unit,
        number: Number(row.number) || 0,
        usage: Number(row.usage) || 0,
        currentValue: Number(row.currentValue) || 0,
        remaining: Number(row.remaining) || 0,
        percentage: Number(row.percentage) || 0,
        nextResetTime,
      })
    }
  }
  return { level: typeof record.level === "string" ? record.level : "", limits }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function quotaKindForUnit(unit: number): QuotaKind | null {
  // 实测口径：unit=3 是 5 小时滚动窗，unit=6 是周窗。
  if (unit === 3) return "FIVE_HOUR"
  if (unit === 6) return "WEEKLY"
  return null
}

/**
 * unit=3/6 → quota_windows（FIVE_HOUR/WEEKLY）。percentage 是已用百分比，
 * 与本网关阻塞语义（usage_percent >= 100 阻塞）同向，直接采用；level 挂在
 * 窗口 extra 透传给管理端。
 */
export function windowsFromGlmQuota(payload: GlmQuotaPayload, nowMs = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  const seen = new Set<QuotaKind>()
  for (const limit of payload.limits) {
    const kind = quotaKindForUnit(limit.unit)
    if (!kind || seen.has(kind)) continue
    seen.add(kind)
    const resetMs = limit.nextResetTime > 0 ? limit.nextResetTime : null
    windows.push({
      kind,
      usagePercent: clampPercent(limit.percentage),
      limitValue: limit.usage || null,
      remainingValue: limit.remaining || null,
      resetAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
      resetInSeconds: resetMs !== null ? Math.max(0, Math.ceil((resetMs - nowMs) / 1000)) : null,
      lastObservedAt: new Date(nowMs).toISOString(),
      source: "API_PROBE",
      extra: payload.level ? { level: payload.level } : null,
    })
  }
  return windows
}

/** GET /api/monitor/usage/quota/limit。200 且带 data 即有效；401/403 抛 GlmApiKeyInvalidError。 */
export async function fetchGlmQuota(apiKey: string, region: GlmRegion = "cn", account?: MirrorSelectionAccount): Promise<GlmQuotaPayload> {
  const response = await apiFetchWithMirrorContext(`${glmEndpointBases(region).monitorHost}/api/monitor/usage/quota/limit`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...createZcodeIdentityHeaders(),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { account })
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "")
    throw new GlmApiKeyInvalidError(`GLM 用量接口拒绝访问（HTTP ${response.status}）: ${body.slice(0, 200)}`, response.status)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`GLM 用量接口失败（HTTP ${response.status}）: ${body.slice(0, 200)}`)
  }
  const parsed = parseGlmQuotaPayload(await response.json().catch(() => null))
  if (!parsed) throw new Error("GLM 用量接口响应缺少 data 结构")
  return parsed
}

// ─── OAuth：zcode.z.ai server-mediated 设备流 ─────────────────────────────

interface ZcodeEnvelope {
  code?: number
  msg?: string
  data?: unknown
}

async function requestZcode<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const response = await apiFetch(url, init)
  let raw: ZcodeEnvelope | null = null
  try {
    raw = await response.json() as ZcodeEnvelope
  } catch {
    raw = null
  }
  // 实测 envelope：成功 code===0；无效 flow 400 + {"code":3004,"msg":"invalid_flow"}。
  if (!raw || typeof raw.code !== "number") {
    throw new GlmOAuthFlowError(`${label}: 响应缺少 code envelope（HTTP ${response.status}）`)
  }
  if (!response.ok || raw.code !== 0) {
    throw new GlmOAuthFlowError(`${label} 失败（HTTP ${response.status}，code=${raw.code}）: ${raw.msg || "(none)"}`)
  }
  return raw.data as T
}

interface ZcodeCliInitData {
  flow_id: string
  poll_token: string
  authorize_url: string
  expires_at: number
  poll_interval_sec: number
}

export interface GlmOAuthSession {
  id: string
  ownerUserId: string
  region: GlmRegion
  flowId: string
  pollToken: string
  authorizeUrl: string
  intervalSec: number
  createdAtMs: number
  pollAfterMs: number
  expiresAtMs: number
}

export type GlmOAuthPollResult =
  | { kind: "pending"; intervalSec: number }
  | { kind: "expired" }
  | { kind: "failed"; description: string }
  | { kind: "ready"; accessToken: string; zcodeJwt?: string; userId?: string }

const sessionGlobal = globalThis as typeof globalThis & { __glmOAuthSessions?: Map<string, GlmOAuthSession> }
const sessions = (sessionGlobal.__glmOAuthSessions ??= new Map<string, GlmOAuthSession>())

function pruneSessions(now = Date.now()): void {
  for (const [id, session] of sessions) if (session.expiresAtMs <= now) sessions.delete(id)
}

export async function startGlmOAuthSession(ownerUserId: string, region: GlmRegion = "cn"): Promise<{
  sessionId: string
  authorizeUrl: string
  intervalSec: number
  expiresInSeconds: number
}> {
  pruneSessions()
  const clientToken = randomBytes(32).toString("hex")
  const data = await requestZcode<Partial<ZcodeCliInitData>>(`${ZCODE_API_BASE}/oauth/cli/init`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${clientToken}` },
    body: JSON.stringify({ provider: glmEndpointBases(region).oauthProvider }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, "GLM OAuth init")
  if (!data || typeof data.flow_id !== "string" || typeof data.authorize_url !== "string" || typeof data.poll_token !== "string") {
    throw new GlmOAuthFlowError("GLM OAuth init 响应结构异常（缺少 flow_id/authorize_url/poll_token）")
  }
  const now = Date.now()
  const expiresAtSec = Number(data.expires_at) || Math.floor(now / 1000) + 900
  const session: GlmOAuthSession = {
    id: randomUUID(),
    ownerUserId,
    region,
    flowId: data.flow_id,
    pollToken: data.poll_token,
    authorizeUrl: data.authorize_url,
    intervalSec: Math.max(1, Number(data.poll_interval_sec) || 2),
    createdAtMs: now,
    pollAfterMs: now,
    expiresAtMs: Math.min(now + SESSION_TTL_MS, expiresAtSec * 1000),
  }
  sessions.set(session.id, session)
  return {
    sessionId: session.id,
    authorizeUrl: session.authorizeUrl,
    intervalSec: session.intervalSec,
    expiresInSeconds: Math.max(1, Math.floor((session.expiresAtMs - now) / 1000)),
  }
}

interface ZcodeCliPollData {
  status?: string
  token?: string
  user?: { user_id?: string }
  bigmodel?: { access_token?: string }
  zai?: { access_token?: string }
}

async function pollZcodeCliFlow(session: GlmOAuthSession): Promise<GlmOAuthPollResult> {
  const providerKey = glmEndpointBases(session.region).oauthProvider
  let data: ZcodeCliPollData | null
  try {
    data = await requestZcode<ZcodeCliPollData>(
      `${ZCODE_API_BASE}/oauth/cli/poll/${encodeURIComponent(session.flowId)}`,
      { method: "GET", headers: { authorization: `Bearer ${session.pollToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      "GLM OAuth poll",
    )
  } catch (cause) {
    // 实测：flow 不存在/过期 → 400 {"code":3004,"msg":"invalid_flow"}，按过期处理。
    if (cause instanceof GlmOAuthFlowError && /invalid_flow|code=3004/.test(cause.message)) return { kind: "expired" }
    throw cause
  }
  if (data?.status === "pending") return { kind: "pending", intervalSec: session.intervalSec }
  if (data?.status === "ready") {
    // ready 形态（zcode-api 源码）：data.{bigmodel|zai}.access_token + data.token（zcode plan JWT）+ data.user.user_id。
    const accessToken = (data[providerKey]?.access_token ?? "").trim()
    if (!accessToken) throw new GlmOAuthFlowError("GLM OAuth poll ready 响应缺少 access_token")
    return {
      kind: "ready",
      accessToken,
      zcodeJwt: typeof data.token === "string" && data.token.trim() ? data.token.trim() : undefined,
      userId: typeof data.user?.user_id === "string" && data.user.user_id ? data.user.user_id : undefined,
    }
  }
  if (data?.status === "failed") return { kind: "failed", description: "授权失败，请重试" }
  throw new GlmOAuthFlowError(`GLM OAuth poll 返回未知状态：${String(data?.status ?? "(none)")}`)
}

export async function pollGlmOAuthSession(ownerUserId: string, sessionId: string): Promise<
  | { status: "pending"; intervalSec: number; authorizeUrl: string }
  | { status: "expired" }
  | { status: "failed"; description: string }
  | { status: "success"; accessToken: string; zcodeJwt?: string; userId?: string; region: GlmRegion }
> {
  pruneSessions()
  const session = sessions.get(sessionId)
  if (!session || session.ownerUserId !== ownerUserId) throw new Error("GLM OAuth session 不存在或已过期")
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(sessionId)
    return { status: "expired" }
  }
  const now = Date.now()
  if (now < session.pollAfterMs) {
    return { status: "pending", intervalSec: Math.max(1, Math.ceil((session.pollAfterMs - now) / 1000)), authorizeUrl: session.authorizeUrl }
  }
  const result = await pollZcodeCliFlow(session)
  if (result.kind === "ready") {
    // ready 只会出现一次，消费后即删会话；上游兑换失败需重新发起 OAuth。
    sessions.delete(sessionId)
    return { status: "success", accessToken: result.accessToken, zcodeJwt: result.zcodeJwt, userId: result.userId, region: session.region }
  }
  if (result.kind === "expired" || result.kind === "failed") {
    sessions.delete(sessionId)
    return result.kind === "expired" ? { status: "expired" } : { status: "failed", description: result.description }
  }
  session.pollAfterMs = Date.now() + result.intervalSec * 1000
  sessions.set(sessionId, session)
  return { status: "pending", intervalSec: result.intervalSec, authorizeUrl: session.authorizeUrl }
}

export function cancelGlmOAuthSession(ownerUserId: string, sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session && session.ownerUserId === ownerUserId) sessions.delete(sessionId)
}

// ─── OAuth 凭据兑换：coding-plan API key（zcode-api resolver 复刻） ───────

async function requestBizApi(url: string, authorization: string, init?: RequestInit): Promise<unknown> {
  const response = await apiFetch(url, {
    ...init,
    headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new GlmOAuthFlowError(`biz API ${url} 失败（HTTP ${response.status}）`)
  const body = await response.json().catch(() => null) as { code?: unknown; status?: unknown; msg?: unknown; data?: unknown } | null
  const code = body?.code ?? body?.status
  // biz envelope：code 为 0/200（含字符串形态）均视为成功。
  if (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    throw new GlmOAuthFlowError(`biz API ${url} 错误：${body?.msg ?? code}`)
  }
  return body?.data ?? body
}

const DEFAULT_ORG_MARKER = "默认机构"
const DEFAULT_PROJECT_MARKER = "默认项目"

function pickOrgAndProject(data: unknown): { orgId: string; projectId: string } {
  if (!data || typeof data !== "object") throw new GlmOAuthFlowError("getCustomerInfo 响应结构异常")
  const record = data as Record<string, unknown>
  const orgsRaw = Array.isArray(record.organizations ?? record.orgs) ? ((record.organizations ?? record.orgs) as unknown[]) : []
  if (orgsRaw.length === 0) throw new GlmOAuthFlowError("账号下没有机构（organization）")
  const org = (orgsRaw.find((item) => {
    const name = item && typeof item === "object" ? String((item as Record<string, unknown>).organizationName ?? (item as Record<string, unknown>).name ?? "") : ""
    return name.includes(DEFAULT_ORG_MARKER)
  }) ?? orgsRaw[0]) as Record<string, unknown> | undefined
  if (!org) throw new GlmOAuthFlowError("账号下没有机构（organization）")
  const orgId = String(org.organizationId ?? org.id ?? org.orgId ?? "")
  const projects = Array.isArray(org.projects) ? (org.projects as unknown[]) : []
  if (!orgId || projects.length === 0) throw new GlmOAuthFlowError("默认机构缺少项目（project）")
  const project = (projects.find((item) => {
    const name = item && typeof item === "object" ? String((item as Record<string, unknown>).projectName ?? (item as Record<string, unknown>).name ?? "") : ""
    return name.includes(DEFAULT_PROJECT_MARKER)
  }) ?? projects[0]) as Record<string, unknown> | undefined
  if (!project) throw new GlmOAuthFlowError("默认机构缺少项目（project）")
  const projectId = String(project.projectId ?? project.id ?? "")
  if (!projectId) throw new GlmOAuthFlowError("项目缺少 projectId")
  return { orgId, projectId }
}

/**
 * 把 OAuth access_token 兑换成长期 coding-plan API key。
 * 复刻 zcode-api src/auth/resolver.ts：getCustomerInfo → 找/建 zcode-api-key → copy 取 secret。
 * bigmodel 最终 key = `{apiKey}.{secret}`；secret 获取失败时退化为纯 apiKey。
 */
export async function resolveGlmCodingPlanApiKey(accessToken: string, region: GlmRegion = "cn"): Promise<{ apiKey: string; userId?: string }> {
  const bases = glmEndpointBases(region)
  let authorization = `Bearer ${accessToken}`
  if (region === "global") {
    // zai 需先经 /api/auth/z/login 把 OAuth token 换成 biz token。
    const response = await apiFetch(`${bases.bizHost}/api/auth/z/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new GlmOAuthFlowError(`z/login 失败（HTTP ${response.status}）`)
    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    const bizToken = String(data?.access_token ?? data?.accessToken ?? (data?.data as Record<string, unknown> | undefined)?.access_token ?? "")
    if (!bizToken) throw new GlmOAuthFlowError("z/login 响应缺少 access_token")
    authorization = `Bearer ${bizToken}`
  }

  const { orgId, projectId } = pickOrgAndProject(
    await requestBizApi(`${bases.bizHost}/api/biz/customer/getCustomerInfo`, authorization, { method: "GET" }),
  )
  const keysUrl = `${bases.bizHost}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`

  let apiKey = ""
  try {
    const existing = await requestBizApi(keysUrl, authorization, { method: "GET" })
    if (Array.isArray(existing)) {
      const found = existing.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).name === GLM_OAUTH_API_KEY_NAME) as Record<string, unknown> | undefined
      apiKey = String(found?.apiKey ?? "")
    }
  } catch {
    // 列表失败则尝试直接创建。
  }
  if (!apiKey) {
    const created = await requestBizApi(keysUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: GLM_OAUTH_API_KEY_NAME }),
    }) as Record<string, unknown> | null
    apiKey = String((created ?? {}).apiKey ?? "")
  }
  if (!apiKey) throw new GlmOAuthFlowError("自动创建 coding-plan API key 失败")

  try {
    const copied = await requestBizApi(
      `${keysUrl}/copy/${encodeURIComponent(apiKey)}`,
      authorization,
      { method: "GET" },
    ) as Record<string, unknown> | null
    const secret = String((copied ?? {}).secretKey ?? (copied ?? {}).secret_key ?? "")
    if (secret) return { apiKey: `${apiKey}.${secret}` }
  } catch {
    // secret 获取失败：退化为纯 apiKey（zcode-api 同样处理）。
  }
  return { apiKey }
}

// ─── 杂项 ────────────────────────────────────────────────────────────────

export function glmExternalId(identity: string | null | undefined, apiKey: string): string {
  const source = (identity || "").trim() || apiKey
  return createHash("sha256").update(`glm-coding:${source}`).digest("hex").slice(0, 24)
}
