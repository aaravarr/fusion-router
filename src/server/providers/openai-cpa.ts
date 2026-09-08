/**
 * OpenAI Codex Provider（CLIProxyAPI 契约对齐版）
 *
 * 统一号池：OpenAI Codex OAuth 账号（refresh token 自动刷新）与 Personal
 * Access Token（at-*，无刷新）。上游：chatgpt.com/backend-api/codex。
 *
 * 契约来源：CLIProxyAPI（Go 项目，OpenAI 官方支持的接入方式）源码，2026-09-07 核实。
 * 关键对齐点（逐项注释标注）：
 *  - cloaking 指纹头：codex-tui UA + Originator（强制伪装，不透传客户端 UA）
 *  - OAuth 凭据推理必带 Chatgpt-Account-Id
 *  - 刷新提前 24h（RefreshLead）；refresh_token_reused/401 → revoked 墓碑停止刷新
 *  - usage_limit_reached → credentialScoped 冷却（resets_at/resets_in_seconds）
 *  - "model is at capacity" → 429 换号；401/authentication_error → 判死切号
 *  - body 规范化：stream:true、instructions 兜底 ""、删除指定字段
 */

import type {
  Provider,
  QuotaWindow,
  ProviderCredential,
  ForwardRequestInput,
  ForwardTarget,
  UpstreamErrorClassification,
} from "./types"
import type { AccountRecord, QuotaKind, ProviderAccountData } from "../types"
import type { PoolType } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { apiFetchWithMirrorContext, type MirrorSelectionContext } from "../api-fetch"
import { isPoolModelFastEnabled } from "../pool-model-config"
import { OPENAI_OAUTH_CLIENT_ID, OPENAI_OAUTH_TOKEN_URL, parseOpenAIIdentity } from "../openai-oauth"

// ─── Constants ───────────────────────────────────────────────────────────

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENAI_PAT_WHOAMI_URL = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami"
const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex"

// CLIProxyAPI cloaking 指纹头（2026-09-07 源码核实）：UA 与 Originator 必须
// 是同一套 codex-tui 组合（CLIProxyAPI 强制伪装 Codex CLI 官方 TUI 客户端），
// 客户端 UA 一律不透传。
const CODEX_CLOAK_USER_AGENT = "codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)"
const CODEX_CLOAK_ORIGINATOR = "codex-tui"

// CLIProxyAPI RefreshLead = 24h：access_token 距过期不足 24h 即提前刷新。
const OPENAI_REFRESH_LEAD_SECONDS = 24 * 3600
// CLIProxyAPI 刷新 grant：grant_type=refresh_token&client_id&refresh_token&scope="openid profile email"。
const OPENAI_REFRESH_SCOPE = "openid profile email"
// token 端点返回这些 error.code（或 401）= refresh_token 已被吊销/复用，凭据判死。
const OPENAI_REFRESH_FATAL_CODES = new Set(["refresh_token_reused", "invalid_grant"])

// 刷新瞬时失败（网络/5xx）指数退避：保留旧 token，10s×2^n（封顶 10min）后再试。
const REFRESH_BACKOFF_BASE_MS = 10_000
const REFRESH_BACKOFF_MAX_MS = 10 * 60_000

// CLIProxyAPI codex 转发约束（internal/translator/codex/openai，2026-09-08 源码核实）：
// responses 入口 ConvertOpenAIResponsesRequestToCodex 强制 stream=true、store=false、
// parallel_tool_calls=true、include=["reasoning.encrypted_content"]，删除 token 上限与
// 采样参数（max_output_tokens/max_completion_tokens/temperature/top_p）、
// service_tier（仅保留 "priority"）、truncation/prompt_cache_options/
// prompt_cache_retention（含嵌套 prompt_cache_breakpoint）、context_management、user，
// input 为字符串时包装为 [{type:"message",role:"user",
// content:[{type:"input_text",text}]}]，system role 转 developer。
// chat 入口 ConvertOpenAIRequestToCodex 从 {"instructions":""} 白名单重建，
// temperature/top_p/top_k/max_tokens/max_completion_tokens/stream_options/include_usage
// 一律不带，store=false 强制。
// 网关侧取交集实现（删除类 + store/input 规范化全做；parallel_tool_calls/include 强制
// 与 system→developer 转换暂不做：前者会覆盖客户端显式意图，后者超出参数规范化范畴）。
const CODEX_BODY_STRIP_KEYS = [
  "previous_response_id",
  "generate",
  "prompt_cache_retention",
  "prompt_cache_options",
  "safety_identifier",
  "stream_options",
  "include_usage",
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "truncation",
  "context_management",
  "user",
] as const

// Windows with limit_window_seconds <= 21600 (6h) are classified as 5h;
// anything larger is weekly.
const FIVE_HOUR_THRESHOLD_SECONDS = 21600
const FIVE_HOUR_THRESHOLD_MINUTES = 360

// 上游真实列表端点（2026-09-08 生产实测 HTTP 200）：
// GET https://chatgpt.com/backend-api/codex/models?client_version=<codex-tui 版本>
// CLIProxyAPI 同款用法（cmd/fetch_codex_models）：cloaking 头 + Bearer +
// Chatgpt-Account-Id，响应 {models:[{slug,display_name,...}]}，slug 即请求用模型 ID。
// CLIProxyAPI 另有嵌入快照 internal/registry/models/codex_client_models.json（3h 刷新），
// 本地默认清单与该快照 + 生产实测双对齐。
const CODEX_CLIENT_VERSION = "0.153.3"

const REQUEST_TIMEOUT_MS = 20000

const CODEX_MODELS = [
  // 2026-09-08 生产实测 GET /codex/models?client_version=0.153.3（HTTP 200，8 个，
  // 经 7890 代理，plus 号）：下表即当时上游返回的全量 slug。
  // CLIProxyAPI internal/registry/models/codex_client_models.json 快照同期为同样的
  // 8 个条目（唯 gpt-5.3-codex-spark 一处已被上游轮换为 gpt-5.4-mini）。
  // display_name 对照（上游字段，网关模型目录为纯 ID 列表，此处备查）：
  //   gpt-6-astra→GPT-6-Astra / gpt-reserve→GPT-Reserve / gpt-5.6-sol→GPT-5.6-Sol /
  //   gpt-5.6-terra→GPT-5.6-Terra / gpt-5.6-luna→GPT-5.6-Luna / gpt-5.5→GPT-5.5 /
  //   gpt-5.4-mini→GPT-5.4-Mini / codex-auto-review→Codex Auto Review。
  // gpt-reserve 与 codex-auto-review 上游 visibility=hide（不对 codex 客户端展示），
  // 但 supported_in_api=true，是合法请求目标，故一并保留（CLIProxyAPI 仅隐藏展示，
  // 不限制请求）。
  "gpt-6-astra",
  "gpt-reserve",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4-mini",
  "codex-auto-review",
] as const

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY"]

/**
 * refresh_token 被上游拒绝（401 / refresh_token_reused / invalid_grant）时抛出，
 * 表示凭据已失效、需要重新登录。与网络/5xx 抖动区分：provider 据此写 revokedAt
 * 墓碑并停止刷新调度，而不是拿死 token 反复白刷（CLIProxyAPI revoked 语义）。
 */
export class OpenAITokenRevokedError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = "OpenAITokenRevokedError"
    this.status = status
  }
}

// ─── Token Endpoint ──────────────────────────────────────────────────────

export interface OpenAIRefreshedToken {
  accessToken: string
  refreshToken: string
  idToken: string
  /** access_token 过期时刻（unix 秒，字符串——与既有凭据存储格式一致）。 */
  expiresAt: string
  expiresIn: number
  /** id_token 解出的 ChatGPT AccountID（https://api.openai.com/auth.chatgpt_account_id）。 */
  chatgptAccountId: string
  email: string
  planType: string
}

/**
 * 用 refresh_token 换新 access_token（CLIProxyAPI 契约：POST
 * auth.openai.com/oauth/token，x-www-form-urlencoded + Accept: application/json，
 * 携带 scope="openid profile email"）。token 响应 {access_token, refresh_token,
 * id_token, token_type, expires_in}；id_token 不验签、base64url 解 payload 取身份。
 * 401 / refresh_token_reused / invalid_grant → OpenAITokenRevokedError（凭据判死）。
 */
export async function exchangeOpenAIRefreshToken(
  refreshToken: string,
  clientId = OPENAI_OAUTH_CLIENT_ID,
  mirrorContext: MirrorSelectionContext = {},
): Promise<OpenAIRefreshedToken> {
  // refresh 兑换与 OAuth code 兑换同理：必须带镜像上下文走运营方给
  // auth.openai.com 配的镜像/proxy，否则地域封锁下直接 403（裸 apiFetch
  // 丢归属，非 ADMIN 用户的刷新请求直连上游）。
  const resp = await apiFetchWithMirrorContext(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId || OPENAI_OAUTH_CLIENT_ID,
      scope: OPENAI_REFRESH_SCOPE,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, mirrorContext)
  const body = await resp.text()
  if (!resp.ok) {
    let errorCode = ""
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      errorCode = typeof parsed.error === "string" ? parsed.error : ""
    } catch { /* 非 JSON 错误体 */ }
    if (resp.status === 401 || OPENAI_REFRESH_FATAL_CODES.has(errorCode)) {
      throw new OpenAITokenRevokedError(
        `OpenAI refresh_token 已被上游拒绝（${errorCode || `HTTP ${resp.status}`}），凭据失效需重新登录`,
        resp.status,
      )
    }
    throw new Error(`OpenAI refresh token 刷新失败（HTTP ${resp.status}）`)
  }
  const token = JSON.parse(body) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
    expires_in?: number
  }
  if (!token.access_token) throw new Error("OpenAI refresh token 响应缺少 access_token")
  const expiresIn = Math.max(1, Number(token.expires_in) || 3600)
  const identity = parseOpenAIIdentity(token.id_token ?? "", token.access_token)
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    idToken: token.id_token ?? "",
    expiresAt: String(Math.floor(Date.now() / 1000) + expiresIn),
    expiresIn,
    chatgptAccountId: identity.chatgptAccountId,
    email: identity.email,
    planType: identity.planType,
  }
}

// Headers forwarded from the incoming request to the upstream. 注意 accept 不在
// 其中：body 强制 stream:true，Accept 固定 text/event-stream（CLIProxyAPI 契约）。
const PASSTHROUGH_HEADERS = [
  "accept-language",
  "conversation_id",
  "session_id",
  "openai-beta",
] as const

// ─── Upstream Response Types ─────────────────────────────────────────────

interface RateLimitWindowData {
  used_percent: number
  limit_window_seconds: number
  reset_after_seconds: number
  reset_at: number
}

interface RateLimitEnvelope {
  allowed?: boolean
  limit_reached?: boolean
  primary_window?: RateLimitWindowData | null
  secondary_window?: RateLimitWindowData | null
}

interface UsageResponseBody {
  rate_limit?: RateLimitEnvelope
  rate_limit_reached?: boolean
}

interface WhoamiResponseBody {
  email?: string
  chatgpt_user_id?: string
  chatgpt_account_id?: string
  chatgpt_plan_type?: string
}

/** Codex 后端结构化错误（顶层 error / 流内 response.error 两种嵌套，见 extractCodexError）。 */
interface CodexErrorInfo {
  type: string
  code: string
  message: string
  resetsAt: unknown
  resetsInSeconds: unknown
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function classifyWindowBySeconds(limitWindowSeconds: number): QuotaKind {
  return limitWindowSeconds <= FIVE_HOUR_THRESHOLD_SECONDS ? "FIVE_HOUR" : "WEEKLY"
}

function classifyWindowByMinutes(windowMinutes: number): QuotaKind {
  return windowMinutes <= FIVE_HOUR_THRESHOLD_MINUTES ? "FIVE_HOUR" : "WEEKLY"
}

function toISOFromUnixSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function toISOFromNowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function parseNumberFromHeader(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function retryAfterSecondsFromHeader(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
}

/**
 * 从错误体（HTTP 429 body 或 SSE error/response.failed 事件的 data JSON）提取
 * Codex 结构化错误。按优先级查找：顶层 error 链 → response.error 链 → 顶层自身
 * （仅当带 code/message/resets 字段；裸事件名如 response.failed 不算错误）。
 */
export function extractCodexError(body: string): CodexErrorInfo | null {
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const root = parsed as Record<string, unknown>
  // error 为纯字符串的形态（{"error":"invalid or expired token"}）归一化为 message。
  const candidates: unknown[] = [typeof root.error === "string" ? { message: root.error } : root.error]
  const response = root.response
  if (response && typeof response === "object" && !Array.isArray(response)) {
    candidates.push((response as Record<string, unknown>).error)
  }
  candidates.push(root)

  for (const candidate of candidates) {
    if (!candidate) continue
    let current: unknown = candidate
    for (let depth = 0; current && typeof current === "object" && !Array.isArray(current) && depth < 3; depth += 1) {
      const record = current as Record<string, unknown>
      const type = typeof record.type === "string" ? record.type : ""
      const code = typeof record.code === "string" ? record.code : ""
      const message = typeof record.message === "string" ? record.message : ""
      const hasResetFields = record.resets_at !== undefined || record.resets_in_seconds !== undefined
      const looksLikeError = Boolean(code || message || hasResetFields || (type && candidate !== root))
      if (looksLikeError) {
        return { type, code, message, resetsAt: record.resets_at, resetsInSeconds: record.resets_in_seconds }
      }
      current = record.error
    }
  }
  return null
}

/** CLIProxyAPI：error.type = usage_limit_reached → credentialScoped 冷却。 */
function isUsageLimitReached(error: CodexErrorInfo): boolean {
  const marker = `${error.type} ${error.code}`.toLowerCase()
  if (marker.includes("usage_limit_reached")) return true
  return /usage limit (?:has been )?reached/.test(error.message.toLowerCase())
}

/** CLIProxyAPI："model is at capacity" → 429 可换号重试。 */
function isModelAtCapacity(error: CodexErrorInfo | null, body: string): boolean {
  if (error && /at capacity/.test(`${error.type} ${error.code} ${error.message}`.toLowerCase())) return true
  return body.toLowerCase().includes("model is at capacity")
}

/** CLIProxyAPI：401 / authentication_error / invalid or expired token → 凭据判死切号。 */
function isCodexAuthError(error: CodexErrorInfo): boolean {
  const marker = `${error.type} ${error.code}`.toLowerCase()
  if (marker.includes("authentication_error") || marker.includes("invalid_token")) return true
  return /invalid or expired (?:token|credential)/.test(error.message.toLowerCase())
}

/** usage_limit_reached 冷却时长：优先 resets_in_seconds，再 resets_at（unix s/ms/ISO）。 */
function codexUsageLimitCooldownSeconds(error: CodexErrorInfo): number | null {
  const inSeconds = Number(error.resetsInSeconds)
  if (Number.isFinite(inSeconds) && inSeconds > 0) return Math.ceil(inSeconds)
  const at = error.resetsAt
  if (typeof at === "number" && Number.isFinite(at) && at > 0) {
    const ms = at > 1_000_000_000_000 ? at : at * 1000
    return Math.max(0, Math.ceil((ms - Date.now()) / 1000))
  }
  if (typeof at === "string" && at.trim()) {
    const numeric = Number(at)
    if (Number.isFinite(numeric) && numeric > 0) {
      return codexUsageLimitCooldownSeconds({ ...error, resetsAt: numeric, resetsInSeconds: undefined })
    }
    const parsed = Date.parse(at)
    if (!Number.isNaN(parsed)) return Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
  }
  return null
}

/**
 * Given two rate-limit windows, determine which one triggered the 429 and
 * return its quotaKind and reset_after_seconds. Falls back to the primary
 * window when neither is clearly exhausted.
 */
function identifyExhaustedWindow(
  primary: RateLimitWindowData | null | undefined,
  secondary: RateLimitWindowData | null | undefined,
): { quotaKind: QuotaKind; resetAfterSeconds: number | null } {
  if (!primary && !secondary) {
    return { quotaKind: "FIVE_HOUR", resetAfterSeconds: null }
  }
  if (primary && secondary) {
    const pExhausted = primary.used_percent >= 100
    const sExhausted = secondary.used_percent >= 100
    if (pExhausted && !sExhausted) {
      return {
        quotaKind: classifyWindowBySeconds(primary.limit_window_seconds),
        resetAfterSeconds: primary.reset_after_seconds,
      }
    }
    if (sExhausted && !pExhausted) {
      return {
        quotaKind: classifyWindowBySeconds(secondary.limit_window_seconds),
        resetAfterSeconds: secondary.reset_after_seconds,
      }
    }
    // Both exhausted (or neither): pick the smaller window (typically 5h).
    const smaller =
      primary.limit_window_seconds <= secondary.limit_window_seconds ? primary : secondary
    return {
      quotaKind: classifyWindowBySeconds(smaller.limit_window_seconds),
      resetAfterSeconds: smaller.reset_after_seconds,
    }
  }
  // Only one window present.
  const window = primary ?? secondary!
  return {
    quotaKind: classifyWindowBySeconds(window.limit_window_seconds),
    resetAfterSeconds: window.reset_after_seconds,
  }
}

/**
 * CLIProxyAPI codex 转发约束（2026-09-08 源码核实，见 CODEX_BODY_STRIP_KEYS 注释）：
 * 强制 stream:true、store:false；instructions 为 null/缺失时置 ""；input 为字符串时
 * 包装为标准列表形态 [{type:"message",role:"user",content:[{type:"input_text",text}]}]；
 * service_tier 仅保留 "priority"；删除 strip 清单字段。
 * 非 JSON body 原样透传。
 * 覆盖两条入口：responses 原生直通与 chat→responses 转换（网关转换后统一经
 * buildForwardTarget 走到这里）。
 *
 * Codex fast 开关（预埋）：按请求 model 查 pool_model_config，开关打开时注入
 * service_tier:"priority"。service_tier 优先级规则：客户端显式传 "priority"
 * 时保留不动（客户端显式意图优先）；客户端传其他值会被既有的 strip 逻辑删除，
 * 之后开关打开才由网关注入 "priority" —— 即网关配置 > 客户端非 priority 值 >
 * 无配置。客户端传非 "priority" 但开关未开时，仅删除不注入（维持既有行为）。
 *
 * 已知事实（诚实提示，见账号池页 UI）：当前 Codex 上游 HTTP POST 链路下该字段
 * 被静默忽略（按 standard 调度，响应回显 default），priority 仅 websocket 传输
 * 生效；Plus 套餐接受该字段无副作用，故为预埋能力，不承诺 HTTP 链路加速。
 * fast 配置读取走 pool-model-config 的 10s TTL 内存缓存，热路径零额外打库。
 */
export function normalizeCodexResponsesBody(body: Uint8Array<ArrayBuffer> | null, ownerUserId?: string, model?: string): Uint8Array<ArrayBuffer> | null {
  if (!body || body.byteLength === 0) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body
  const record = { ...(parsed as Record<string, unknown>) }
  record.stream = true
  record.store = false
  if (typeof record.input === "string") {
    record.input = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: record.input }],
    }]
  }
  // service_tier 仅保留 "priority"（CLIProxyAPI 同款）；fast 开启时由网关注入。
  const clientPriority = record.service_tier === "priority"
  if (!clientPriority) delete record.service_tier
  const fastEnabled = Boolean(ownerUserId && model && isPoolModelFastEnabled(ownerUserId, model))
  if (!clientPriority && fastEnabled) record.service_tier = "priority"
  if (record.instructions === null || record.instructions === undefined) record.instructions = ""
  for (const key of CODEX_BODY_STRIP_KEYS) delete record[key]
  return new TextEncoder().encode(JSON.stringify(record)) as Uint8Array<ArrayBuffer>
}

/**
 * 上游 {models:[{slug,...}]} 提取 slug 列表（CLIProxyAPI 以 slug 为请求模型 ID；
 * display_name 仅展示用）。解析失败返回 null；models 缺失/非数组返回 null；
 * 空数组原样返回（调用方 syncProviderModels 会回落默认列表并提示）。
 */
export function parseCodexModelsPayload(body: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models)) return null
  const slugs = models
    .map((item) => (item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).slug
      : undefined))
    .filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0)
    .map((slug) => slug.trim())
  return [...new Set(slugs)]
}

// ─── Provider ────────────────────────────────────────────────────────────

export class OpenAICPAProvider implements Provider {
  readonly poolType: PoolType = "openai"
  readonly displayName = "OpenAI"

  private readonly vault = new SecretVault()

  /** 并发去重：同一账号的进行中刷新共享一个 Promise（refresh_token 轮换制，并发刷新会触发 refresh_token_reused 误杀）。 */
  private readonly refreshInflight = new Map<string, Promise<ProviderCredential>>()
  /** 瞬时失败退避状态（内存即可，对齐 CLIProxyAPI 的运行时刷新调度）。 */
  private readonly refreshBackoff = new Map<string, { failures: number; nextAttemptAtMs: number }>()

  // ── Token Refresh ─────────────────────────────────────────────────────

  private refreshTokenIfNeeded(credential: ProviderCredential, account: AccountRecord): Promise<ProviderCredential> {
    const accountId = account.id
    const inflight = this.refreshInflight.get(accountId)
    if (inflight) return inflight
    const task = this.doRefreshTokenIfNeeded(credential, account)
    this.refreshInflight.set(accountId, task)
    const cleanup = () => {
      if (this.refreshInflight.get(accountId) === task) this.refreshInflight.delete(accountId)
    }
    task.then(cleanup, cleanup)
    return task
  }

  private async doRefreshTokenIfNeeded(credential: ProviderCredential, account: AccountRecord): Promise<ProviderCredential> {
    const accountId = account.id
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?").get(accountId) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) return credential
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData

    // No refresh_token → PAT / 纯 access token，无法刷新。
    if (!data.refreshToken) return credential

    // revoked 墓碑：凭据已判死，停止刷新调度（双保险，getCredential 已拦截）。
    if (data.revokedAt) {
      throw new OpenAITokenRevokedError(`OpenAI 账号凭据已失效（refresh_token 被拒绝，需重新登录），account=${accountId}`)
    }

    const expiresAtSec = Number(data.expiresAt)
    const hasExpiry = Number.isFinite(expiresAtSec) && expiresAtSec > 0
    const now = Date.now()
    // CLIProxyAPI RefreshLead=24h：距过期超过 24h 直接用现有 token；
    // expiresAt 缺失/非法（旧数据）时按“需要刷新”处理，刷新后回填。
    if (data.token && hasExpiry && now < (expiresAtSec - OPENAI_REFRESH_LEAD_SECONDS) * 1000) return credential

    // 瞬时故障退避窗口内：直接用旧 token，避免每次请求都轰炸 token 端点。
    const backoff = this.refreshBackoff.get(accountId)
    if (backoff && now < backoff.nextAttemptAtMs) return credential

    try {
      const refreshed = await exchangeOpenAIRefreshToken(data.refreshToken, data.clientId || OPENAI_OAUTH_CLIENT_ID, { account })
      data.token = refreshed.accessToken
      // 上游每次刷新都轮换 refresh_token；响应缺失时保留旧值（exchange 已兜底）。
      data.refreshToken = refreshed.refreshToken
      data.expiresAt = refreshed.expiresAt
      data.expiresIn = String(refreshed.expiresIn)
      if (refreshed.idToken) data.idToken = refreshed.idToken
      if (refreshed.chatgptAccountId) data.chatgptAccountId = refreshed.chatgptAccountId
      if (refreshed.email) data.email = refreshed.email
      if (refreshed.planType) data.planType = refreshed.planType
      delete data.revokedAt
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
      this.refreshBackoff.delete(accountId)

      const extraHeaders = { ...(credential.extraHeaders ?? {}) }
      if (refreshed.chatgptAccountId) extraHeaders["chatgpt-account-id"] = refreshed.chatgptAccountId
      return { token: refreshed.accessToken, extraHeaders, credentialVersion: row.credential_version + 1 }
    } catch (cause) {
      // refresh_token 被上游拒绝（401/refresh_token_reused/invalid_grant）：
      // 写 revokedAt 墓碑、清空 token、停止刷新调度，需重新登录（CLIProxyAPI revoked 语义）。
      if (cause instanceof OpenAITokenRevokedError) {
        data.token = ""
        data.revokedAt = new Date().toISOString()
        db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
          .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
        this.refreshBackoff.delete(accountId)
        throw cause
      }
      // 网络/5xx 抖动：指数退避 + 保留旧 token 静默降级，不误杀账号。
      const failures = (backoff?.failures ?? 0) + 1
      const delayMs = Math.min(REFRESH_BACKOFF_MAX_MS, REFRESH_BACKOFF_BASE_MS * 2 ** (failures - 1))
      this.refreshBackoff.set(accountId, { failures, nextAttemptAtMs: now + delayMs })
      return credential
    }
  }

  // ── Credential Management ──────────────────────────────────────────────

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db
      .prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined

    if (!row) {
      throw new Error(`No provider credentials found for account ${account.id}`)
    }

    const decrypted = this.vault.decrypt(row.credential_data_ciphertext)
    const data = JSON.parse(decrypted) as ProviderAccountData

    // revoked 墓碑：refresh_token 已被判死，直接报「需重新登录」，不再拿死 token 白刷。
    if (data.revokedAt) {
      throw new OpenAITokenRevokedError(
        `OpenAI 账号凭据已失效（refresh_token 于 ${data.revokedAt} 被拒绝，需重新登录），account=${account.id}`,
      )
    }
    if (!data.token) {
      throw new OpenAITokenRevokedError(`OpenAI 账号缺少 access token，account=${account.id}`)
    }

    const extraHeaders: Record<string, string> = {}
    if (data.chatgptAccountId) {
      extraHeaders["chatgpt-account-id"] = data.chatgptAccountId
    }

    const credential: ProviderCredential = {
      token: data.token,
      extraHeaders,
      credentialVersion: row.credential_version,
    }

    // If this account has a refresh_token, check if we need to refresh before returning.
    return this.refreshTokenIfNeeded(credential, account)
  }

  /** best-effort 回填 whoami 发现的身份信息（PAT/CPA 导入缺 id_token 时补齐 ChatGPT AccountID）。 */
  private backfillCredentialIdentity(accountId: string, identity: { chatgptAccountId?: string; email?: string; planType?: string }): void {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?").get(accountId) as { credential_data_ciphertext: string } | undefined
      if (!row) return
      const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
      let changed = false
      if (identity.chatgptAccountId && !data.chatgptAccountId) {
        data.chatgptAccountId = identity.chatgptAccountId
        changed = true
      }
      if (identity.email && !data.email) {
        data.email = identity.email
        changed = true
      }
      if (identity.planType && !data.planType) {
        data.planType = identity.planType
        changed = true
      }
      if (changed) {
        db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
          .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
      }
    } catch {
      // best-effort：回填失败不影响校验结果
    }
  }

  async validateCredential(
    account: AccountRecord,
  ): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    let credential: ProviderCredential
    try {
      credential = await this.getCredential(account)
    } catch (cause) {
      if (cause instanceof OpenAITokenRevokedError) return { valid: false }
      throw cause
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      accept: "application/json",
      originator: CODEX_CLOAK_ORIGINATOR,
      "user-agent": CODEX_CLOAK_USER_AGENT,
    }
    const chatgptAccountId = credential.extraHeaders?.["chatgpt-account-id"]
    if (chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId

    const resp = await apiFetchWithMirrorContext(OPENAI_PAT_WHOAMI_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { account })

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false }
    }
    if (!resp.ok) {
      // 网络/5xx/404 抖动不证明凭据无效（对齐 kimi/glm「不误杀」语义）。
      return { valid: true }
    }

    const body = (await resp.json()) as WhoamiResponseBody
    this.backfillCredentialIdentity(account.id, {
      chatgptAccountId: body.chatgpt_account_id,
      email: body.email,
      planType: body.chatgpt_plan_type,
    })

    return {
      valid: true,
      email: body.email,
      planType: body.chatgpt_plan_type,
      extra: {
        chatgptUserId: body.chatgpt_user_id,
        chatgptAccountId: body.chatgpt_account_id,
      },
    }
  }

  // ── Quota Management ───────────────────────────────────────────────────

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  supportedInterfaces(): readonly import("../messages/route-decision").InterfaceFormat[] {
    return ["responses"] as const
  }

  async refreshQuota(accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    void accountId
    const credential = await this.getCredential(account)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      accept: "application/json",
      originator: CODEX_CLOAK_ORIGINATOR,
      "user-agent": CODEX_CLOAK_USER_AGENT,
    }
    // Chatgpt-Account-Id 仅当凭据里真实存在时才带（内部账号 UUID 不是合法值，不再兜底）。
    const chatgptAccountId = credential.extraHeaders?.["chatgpt-account-id"]
    if (chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId

    const resp = await apiFetchWithMirrorContext(CHATGPT_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { account })

    if (!resp.ok) return []

    const body = (await resp.json()) as UsageResponseBody
    const now = new Date().toISOString()
    const windows: QuotaWindow[] = []

    const primary = body.rate_limit?.primary_window
    const secondary = body.rate_limit?.secondary_window

    if (primary) {
      windows.push({
        kind: classifyWindowBySeconds(primary.limit_window_seconds),
        usagePercent: primary.used_percent,
        resetAt: primary.reset_at ? toISOFromUnixSeconds(primary.reset_at) : null,
        resetInSeconds: primary.reset_after_seconds,
        lastObservedAt: now,
        source: "DASHBOARD",
      })
    }

    if (secondary) {
      windows.push({
        kind: classifyWindowBySeconds(secondary.limit_window_seconds),
        usagePercent: secondary.used_percent,
        resetAt: secondary.reset_at ? toISOFromUnixSeconds(secondary.reset_at) : null,
        resetInSeconds: secondary.reset_after_seconds,
        lastObservedAt: now,
        source: "DASHBOARD",
      })
    }

    return windows
  }

  extractQuotaFromResponse(headers: Headers): QuotaWindow[] | null {
    const primaryUsed = headers.get("x-codex-primary-used-percent")
    const primaryReset = headers.get("x-codex-primary-reset-after-seconds")
    const primaryWindowMinutes = headers.get("x-codex-primary-window-minutes")
    const secondaryUsed = headers.get("x-codex-secondary-used-percent")
    const secondaryReset = headers.get("x-codex-secondary-reset-after-seconds")
    const secondaryWindowMinutes = headers.get("x-codex-secondary-window-minutes")

    const hasPrimary = primaryWindowMinutes !== null || primaryUsed !== null
    const hasSecondary = secondaryWindowMinutes !== null || secondaryUsed !== null

    if (!hasPrimary && !hasSecondary) return null

    const now = new Date().toISOString()
    const windows: QuotaWindow[] = []

    if (hasPrimary && primaryWindowMinutes !== null) {
      const windowMinutes = parseInt(primaryWindowMinutes, 10)
      const resetSeconds = parseNumberFromHeader(primaryReset)
      windows.push({
        kind: classifyWindowByMinutes(windowMinutes),
        usagePercent: primaryUsed ? parseFloat(primaryUsed) : 0,
        resetAt: resetSeconds !== null ? toISOFromNowPlusSeconds(resetSeconds) : null,
        resetInSeconds: resetSeconds,
        lastObservedAt: now,
        source: "UPSTREAM_HEADER",
      })
    }

    if (hasSecondary && secondaryWindowMinutes !== null) {
      const windowMinutes = parseInt(secondaryWindowMinutes, 10)
      const resetSeconds = parseNumberFromHeader(secondaryReset)
      windows.push({
        kind: classifyWindowByMinutes(windowMinutes),
        usagePercent: secondaryUsed ? parseFloat(secondaryUsed) : 0,
        resetAt: resetSeconds !== null ? toISOFromNowPlusSeconds(resetSeconds) : null,
        resetInSeconds: resetSeconds,
        lastObservedAt: now,
        source: "UPSTREAM_HEADER",
      })
    }

    return windows.length > 0 ? windows : null
  }

  // ── Models ─────────────────────────────────────────────────────────────

  getAvailableModels(_accounts: AccountRecord[]): string[] {
    return this.readCachedModels() ?? [...CODEX_MODELS]
  }

  getDefaultModels(): string[] {
    return [...CODEX_MODELS]
  }

  supportsModel(model: string): boolean {
    return this.getAvailableModels([]).includes(model)
  }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    // 上游真实列表端点（2026-09-08 生产实测 HTTP 200）：GET /codex/models?client_version=…，
    // 与推理请求同一套 cloaking 头 + Bearer + Chatgpt-Account-Id（OAuth 必带，PAT 无则不带），
    // 走镜像上下文（地域封锁下直连 403）。失败抛错 → syncProviderModels 回落默认列表并记录 error。
    const credential = await this.getCredential(account)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      accept: "application/json",
      originator: CODEX_CLOAK_ORIGINATOR,
      "user-agent": CODEX_CLOAK_USER_AGENT,
    }
    const chatgptAccountId = credential.extraHeaders?.["chatgpt-account-id"]
    if (chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId
    const resp = await apiFetchWithMirrorContext(
      `${CODEX_UPSTREAM_BASE_URL}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`,
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      { account },
    )
    const body = await resp.text()
    if (!resp.ok) throw new Error(`OpenAI /codex/models 拉取失败（HTTP ${resp.status}）: ${body.slice(0, 200)}`)
    return parseCodexModelsPayload(body)
  }

  private readCachedModels(): string[] | null {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT models_json FROM provider_model_cache WHERE pool_type=?").get(this.poolType) as { models_json: string } | undefined
      if (!row?.models_json) return null
      const parsed = JSON.parse(row.models_json) as unknown
      if (!Array.isArray(parsed)) return null
      const models = parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      return models.length ? models : null
    } catch {
      return null
    }
  }

  resolveModel(_account: AccountRecord, requestedModel: string): string {
    return requestedModel
  }

  // ── Upstream Forwarding ────────────────────────────────────────────────

  getUpstreamBaseUrl(_account: AccountRecord): string {
    return CODEX_UPSTREAM_BASE_URL
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    const baseUrl = this.getUpstreamBaseUrl(_account)
    const url = `${baseUrl}/${input.endpoint.replace(/^\/+/, "")}`

    const headers = new Headers()
    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }

    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }

    // CLIProxyAPI cloaking（强制伪装，2026-09-07 源码核实）：passthrough 之后
    // 统一断言指纹头——客户端 UA/originator 一律不透传，UA 与 Originator 必须
    // 是同一套 codex-tui 组合；body 已强制 stream:true，Accept 固定 SSE。
    headers.set("user-agent", CODEX_CLOAK_USER_AGENT)
    headers.set("originator", CODEX_CLOAK_ORIGINATOR)
    headers.set("accept", "text/event-stream")
    headers.set("Authorization", `Bearer ${credential.token}`)

    // Chatgpt-Account-Id：OAuth 凭据必带（CLIProxyAPI 契约）；PAT 无此值时不带。
    const chatgptAccountId = credential.extraHeaders?.["chatgpt-account-id"]
    if (chatgptAccountId) {
      headers.set("chatgpt-account-id", chatgptAccountId)
    }

    return {
      url,
      headers,
      // 传账号归属 + 请求模型：responses/chat 两条入口统一在这里做 body 规范化，
      // fast 开关（service_tier:"priority" 注入）因此同时覆盖两条入口。
      body: input.method.toUpperCase() === "GET"
        ? input.body
        : normalizeCodexResponsesBody(input.body, _account.ownerUserId, input.model),
    }
  }

  // ── Error Classification ───────────────────────────────────────────────

  /**
   * CLIProxyAPI 错误分类契约（2026-09-07 源码核实）：
   *  - 401 / authentication_error / invalid or expired token → 判死切号
   *    （permanentlyDisableAccount：网关落 CREDENTIAL_INVALID 墓碑，需重新登录/重新导入）。
   *  - 429 + error.type=usage_limit_reached → credentialScoped 冷却
   *    （按 resets_at/resets_in_seconds 算冷却时间）。
   *  - 429 + "model is at capacity" → 可换号重试（瞬态容量，成功即清窗）。
   *  - 流内 error/response.failed 事件同样映射（gateway 提取内嵌 status 后走同一入口）。
   */
  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    const codexError = extractCodexError(body)

    if (status === 401 || (codexError && isCodexAuthError(codexError))) {
      return {
        shouldSwitchAccount: true,
        permanentlyDisableAccount: true,
        errorType: "CREDENTIAL_INVALID",
      }
    }
    if (status === 429) {
      return this.classify429(body, headers, codexError)
    }
    return null
  }

  private classify429(body: string, headers: Headers, codexError: CodexErrorInfo | null): UpstreamErrorClassification {
    // 1) usage_limit_reached：credentialScoped 冷却（CLIProxyAPI 语义）。
    //    Codex 不告知窗口类型，按冷却时长 best-effort 归入 5h/周窗展示。
    if (codexError && isUsageLimitReached(codexError)) {
      const retryAfterSeconds =
        codexUsageLimitCooldownSeconds(codexError)
        ?? retryAfterSecondsFromHeader(headers.get("retry-after"))
        ?? 300
      return {
        shouldSwitchAccount: true,
        quotaKind: classifyWindowBySeconds(retryAfterSeconds),
        retryAfterSeconds,
        errorType: "OPENAI_USAGE_LIMIT_REACHED",
      }
    }

    // 2) 模型容量不足：换号重试（瞬态，非配额耗尽；PROVIDER_RATE_LIMIT 窗成功即清）。
    if (isModelAtCapacity(codexError, body)) {
      return {
        shouldSwitchAccount: true,
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSecondsFromHeader(headers.get("retry-after")),
        errorType: "OPENAI_MODEL_AT_CAPACITY",
      }
    }

    // 3) 旧版 wham envelope：rate_limit_reached + primary/secondary_window。
    let parsed: UsageResponseBody | null = null
    try {
      parsed = JSON.parse(body) as UsageResponseBody
    } catch {
      parsed = null
    }
    if (parsed?.rate_limit_reached) {
      const { quotaKind, resetAfterSeconds } = identifyExhaustedWindow(
        parsed.rate_limit?.primary_window,
        parsed.rate_limit?.secondary_window,
      )
      const retryAfterSeconds = retryAfterSecondsFromHeader(headers.get("retry-after")) ?? resetAfterSeconds
      return {
        shouldSwitchAccount: true,
        quotaKind,
        retryAfterSeconds,
        errorType: "RateLimitError",
      }
    }

    // 4) 其余 429：瞬时限流，换号重试（透传 retry-after）。
    return {
      shouldSwitchAccount: true,
      quotaKind: "PROVIDER_RATE_LIMIT",
      retryAfterSeconds: retryAfterSecondsFromHeader(headers.get("retry-after")),
      errorType: "OPENAI_RATE_LIMITED",
    }
  }

  // ── Account Readiness ──────────────────────────────────────────────────

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}
