import type { Provider, QuotaWindow, ProviderCredential, ForwardRequestInput, ForwardTarget, UpstreamErrorClassification } from "./types"
import type { AccountRecord, QuotaKind } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { apiFetchWithMirrorContext } from "../api-fetch"

// OpenAI Codex models served by the OpenCode Go upstream.
// Bootstrap catalog used before /models sync succeeds. Runtime routing must
// still honor the cached remote list once available — never "any model".
// GPT 系模型在 OpenCode Go 上游原生走 /v1/responses（官方文档 API 端点表）。
// responses 入口遇到这些模型保持原生直通，避免转 chat 后兼容性下降。
// 上游原生支持 /v1/responses 的模型白名单（实测确认）。
// 不在白名单的模型只走 chat/messages；responses 请求则经网关转 chat 兼容链路。
const OPENCODE_GO_RESPONSES_MODELS = new Set(["gpt-5.6-luna"])

// muse-* 模型上游只支持 /v1/responses（2026-09-03 生产实测：muse-spark-1.2-contributor /
// muse-spark-1.3-contributor 走 chat/completions 一律 HTTP 500
// {"type":"error","error":{"type":"error","message":"Internal server error"}}，多账号一致复现；
// 同模型 responses 原生直通则正常返回标准 responses 报文）。
// 大小写不敏感的 muse- 前缀匹配，覆盖 muse-spark-1.2 / muse-spark-1.3-contributor 及后续变体。
const MUSE_RESPONSES_ONLY_PATTERN = /^muse-/i

/** muse-* 判定：命中即强制只走上游原生 /v1/responses（supportedInterfaces 只声明 responses）。 */
export function isMuseResponsesOnlyModel(model: string): boolean {
  return MUSE_RESPONSES_ONLY_PATTERN.test(model.trim())
}

/**
 * muse-* 瞬时 429（速率/并发限流，非配额耗尽）同账号退避重试的最大次数。
 * 退避间隔由网关 computeBackoffMs 统一计算：无 Retry-After 时 1s/2s/4s 指数退避，
 * 有则尊重 Retry-After（单次封顶 30s）；全部失败后按 shouldSwitchAccount 切号。
 * 取 3（open-design-go TierConcurrencyLimit 同值；GLM 取 6、Kimi 取 10，
 * muse 上游限流恢复快，3 次足以覆盖抖动又不至于久挂客户端）。
 */
export const MUSE_RATE_LIMIT_MAX_RETRIES = 3

/**
 * 单请求内 muse-* 429 同账号退避引入的额外等待总预算（毫秒）。
 * 累计等待将超出预算时网关不再等待，直接返回最后一次上游错误，避免挂住客户端。
 * 60s（指数退避路径 1+2+4=7s 远不触发；仅约束 Retry-After 偏大的极端情况，
 * 此时 2 次 30s 等待即达预算）。
 */
export const MUSE_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS = 60_000

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
}

// muse-* 429 配额耗尽措辞（对齐 kimi-code / glm-coding 二分法）：结构化
// error.code/type 或 message 命中即视为配额/余额耗尽（标记冷却并切号），
// 其余 429 为瞬时限流（同号退避重试）。opencode.ai 的 muse 429 真实错误体
// 尚未实测复现，按计费类通用措辞收敛；拿到真实错误体后再精化。
const MUSE_QUOTA_EXHAUSTED_CODES = new Set([
  "exceeded_current_quota_error",
  "insufficient_quota",
  "quota_exceeded",
])
const MUSE_QUOTA_EXHAUSTED_PATTERNS = [
  /exceeded your current (?:token )?quota/,
  /check your account balance/,
  /insufficient (?:balance|quota)/,
  /recharge your account|please recharge/,
  /account (?:is )?in arrears/,
  /(?:coding )?plan (?:quota|limit) (?:has been )?exceeded/,
  /套餐(?:额度|已用完|耗尽)/,
  /额度(?:已用完|耗尽|不足)/,
  /欠费|余额不足/,
] as const

function isMuseQuotaExhausted(body: string): boolean {
  if (!body) return false
  try {
    // 结构化：遍历 error → error.error 最多 3 层，收集 code/type（同 kimi-code）。
    const codes: string[] = []
    let current: unknown = JSON.parse(body)
    for (let depth = 0; current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3; depth += 1) {
      const record = current as Record<string, unknown>
      if (typeof record.code === "string") codes.push(record.code)
      if (typeof record.type === "string") codes.push(record.type)
      current = record.error
    }
    if (codes.some((code) => MUSE_QUOTA_EXHAUSTED_CODES.has(code))) return true
  } catch {
    // 非 JSON（如纯文本），走 message 匹配。
  }
  return MUSE_QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(body.toLowerCase()))
}

// 上游 /messages 端点不支持的模型清单（精确匹配，大小写不敏感）。
// 证据：omen-alpha —— 2026-09-04 生产实测，带图与纯文本的 messages 原生请求
// 一律 HTTP 500 {"type":"error","error":{"type":"error","message":"Internal server error"}}
// （落点日志 messages-native/reason:direct，多账号一致）；同模型 chat 原生正常
// （含多模态图片），responses 经网关 opencode_go_responses_to_chat 转换链亦正常。
// 注意：仅 omen-alpha 一例有实测证据，不要泛化为 omen-* 前缀；
// 后续新增型号须先实测确认再追加到此列表。
const OPENCODE_GO_MESSAGES_UNSUPPORTED_MODELS = new Set(["omen-alpha"])

/** 上游不支持 /messages 的模型判定：精确匹配（大小写不敏感），命中即从 supportedInterfaces 摘掉 messages。 */
export function isMessagesUnsupportedModel(model: string): boolean {
  return OPENCODE_GO_MESSAGES_UNSUPPORTED_MODELS.has(model.trim().toLowerCase())
}

/** OpenCode Go 官方上游地址（原 system_settings.opencode_upstream_base_url 的默认值，现已收敛为常量）。 */
export const OPENCODE_GO_UPSTREAM_BASE_URL = "https://opencode.ai/zen/go/v1"

const OPENCODE_GO_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "gpt-5.6-luna",
  "grok-4.5",
  "hy3",
  "hy3-preview",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "mimo-v2-omni",
  "mimo-v2-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.8-max",
]

function parseOpenAiModelList(body: string): string[] {
  const parsed = JSON.parse(body) as { data?: unknown; models?: unknown } | unknown[]
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
      const id = (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name
      if (typeof id === "string" && id.trim()) models.add(id.trim())
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b))
}

// Parse GoUsageLimitError from upstream response body.
function classifyGoUsageLimit(status: number, body: string): UpstreamErrorClassification | null {
  if (status !== 429) return null
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown }; metadata?: { limitName?: unknown } }
    if (parsed.error?.type !== "GoUsageLimitError") return null
    const name = parsed.metadata?.limitName
    const kind: QuotaKind = name === "5 hour" ? "FIVE_HOUR" : name === "weekly" ? "WEEKLY" : name === "monthly" ? "MONTHLY" : "UNKNOWN_GO_LIMIT"
    return { shouldSwitchAccount: true, quotaKind: kind, errorType: "GoUsageLimitError" }
  } catch { return null }
}

// Parse the first SSE event to detect GoUsageLimitError in streaming responses.
function classifyFirstSseEvent(chunk: string): UpstreamErrorClassification | null {
  const normalized = chunk.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  const complete = normalized.endsWith("\n\n") ? parts : parts.slice(0, -1)
  for (const event of complete) {
    if (!event.trim()) continue
    const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
    if (!data || data === "[DONE]") continue
    return classifyGoUsageLimit(429, data)
  }
  return null
}

export { classifyGoUsageLimit, classifyFirstSseEvent }

// Headers to forward from the client request to the upstream.
const PASSTHROUGH_HEADERS = ["accept", "content-type", "anthropic-version", "anthropic-beta", "user-agent"]

export class OpenCodeGoProvider implements Provider {
  readonly poolType = "opencode-go" as const
  readonly displayName = "OpenCode Go"

  supportedQuotaKinds(): readonly QuotaKind[] {
    return ["FIVE_HOUR", "WEEKLY", "MONTHLY"] as const
  }

  supportedInterfaces(model?: string): readonly import("../messages/route-decision").InterfaceFormat[] {
    // muse-* 上游只支持 /v1/responses：只声明 responses，responses 入口原生直通；
    // chat 入口由网关经 chat->responses 转换上行（响应逆向转回 chat），
    // messages 入口经 messages->chat->responses 接力（响应同理逆向），不再原样上行。
    if (model && isMuseResponsesOnlyModel(model)) return ["responses"] as const
    // 上游 /messages 端点不支持的模型（如 omen-alpha）：摘掉 messages 只声明 chat，
    // messages 入口由网关经 messages->chat 转换接力上行（含 image 块映射），
    // chat 入口仍原生直通；responses 维持非白名单转 chat 的既有行为。
    if (model && isMessagesUnsupportedModel(model)) return ["chat"] as const
    // GPT 系模型原生支持 responses；其余模型走 chat/messages（chat 是所有模型的通用兜底）。
    if (model && OPENCODE_GO_RESPONSES_MODELS.has(model)) {
      return ["responses", "chat", "messages"] as const
    }
    return ["chat", "messages"] as const
  }

  async refreshQuota(accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    // Delegated to OpenCodeWebService.refreshUsage — this method is a no-op stub
    // because the OpenCode Go quota refresh is orchestrated by the maintenance
    // scheduler which calls OpenCodeWebService directly. The provider interface
    // exists for uniformity; the actual refresh logic lives in opencode-web/service.ts.
    return []
  }

  getAvailableModels(_accounts: AccountRecord[]): string[] {
    return this.readCachedModels() ?? [...OPENCODE_GO_MODELS]
  }

  getDefaultModels(): string[] {
    return [...OPENCODE_GO_MODELS]
  }

  // Only models present in the cached /models list (or bootstrap defaults)
  // are eligible. Never claim support for arbitrary model ids.
  supportsModel(model: string): boolean {
    return this.getAvailableModels([]).includes(model)
  }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    const credential = await this.getCredential(account)
    const baseUrl = this.getUpstreamBaseUrl(account)
    const resp = await apiFetchWithMirrorContext(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${credential.token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    }, { account })
    const body = await resp.text()
    if (!resp.ok) throw new Error(`OpenCode Go /models 拉取失败（HTTP ${resp.status}）: ${body.slice(0, 200)}`)
    return parseOpenAiModelList(body)
  }

  private readCachedModels(): string[] | null {
    try {
      const row = getDatabase().prepare("SELECT models_json FROM provider_model_cache WHERE pool_type=?").get(this.poolType) as { models_json: string } | undefined
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
    // OpenCode Go does not remap models — the requested model is forwarded as-is.
    return requestedModel
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const vault = new SecretVault()
    const db = getDatabase()
    const row = db.prepare("SELECT auth_cookie_ciphertext, go_api_key_ciphertext, credential_version FROM accounts WHERE id = ?").get(account.id) as
      { auth_cookie_ciphertext: string; go_api_key_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new Error(`Account not found: ${account.id}`)
    const goApiKey = vault.decrypt(row.go_api_key_ciphertext)
    return { token: goApiKey, credentialVersion: row.credential_version }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    // For OpenCode Go, validation is done via the dashboard sync in OpenCodeWebService.
    // Here we just check that the credential exists and the account state is valid.
    try {
      const cred = await this.getCredential(account)
      return { valid: Boolean(cred.token), extra: { goKeyId: account.goKeyId } }
    } catch {
      return { valid: false }
    }
  }

  getUpstreamBaseUrl(_account: AccountRecord): string {
    return OPENCODE_GO_UPSTREAM_BASE_URL
  }

  buildForwardTarget(input: ForwardRequestInput, credential: ProviderCredential, _account: AccountRecord): ForwardTarget {
    const headers = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has("content-type") && input.method !== "GET") headers.set("content-type", "application/json")
    // messages endpoint uses x-api-key; others use Bearer
    if (input.endpoint === "messages") headers.set("x-api-key", credential.token)
    else headers.set("authorization", `Bearer ${credential.token}`)
    const baseUrl = OPENCODE_GO_UPSTREAM_BASE_URL
    const path = input.endpoint.replace(/^\/+/, "")
    return { url: `${baseUrl}/${path}`, headers, body: input.body }
  }

  classifyError(status: number, body: string, headers: Headers, model?: string): UpstreamErrorClassification | null {
    const limit = classifyGoUsageLimit(status, body)
    if (limit) return limit
    // muse-* 429 二分（仅 muse 模型；其他模型保持既有行为不变）：
    // 配额耗尽语义 → 标记冷却并切号；瞬时限流语义 → 同号退避重试后再切号。
    // 推理调用是只读生成，重试无幂等问题。
    if (status === 429 && model != null && isMuseResponsesOnlyModel(model)) {
      if (isMuseQuotaExhausted(body)) {
        return {
          shouldSwitchAccount: true,
          quotaKind: "UNKNOWN_GO_LIMIT",
          retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 60,
          errorType: "MUSE_QUOTA_EXHAUSTED",
        }
      }
      return {
        shouldSwitchAccount: true,
        retrySameAccount: { maxRetries: MUSE_RATE_LIMIT_MAX_RETRIES, maxTotalBackoffMs: MUSE_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS },
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")),
        errorType: "MUSE_RATE_LIMITED",
      }
    }
    const lower = body.toLowerCase()
    if (/model .+ is not supported/.test(lower) || (lower.includes("not supported") && lower.includes("model"))) {
      return { shouldSwitchAccount: true, errorType: "ModelError" }
    }
    if (status === 401 || status === 403) return { shouldSwitchAccount: false, errorType: "AuthenticationError" }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED"
      && account.authState === "VALID"
      && account.subscriptionState === "ACTIVE"
      && account.billingGuard === "VERIFIED_GO_ONLY"
      && account.useBalance === false
  }
}
