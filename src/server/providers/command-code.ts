/**
 * Command Code（GOAT 套餐）Provider
 *
 * 单 base：https://api.commandcode.ai/provider/v1（2026-09-07/08 实测）：
 * - POST /chat/completions（OpenAI 格式）：全量 OpenAI 与 OSS 模型（muse/deepseek/
 *   kimi/glm 等）唯一入口；claude 系模型在它这里 400 拒绝（实测 claude-sonnet-5）。
 * - POST /messages（Anthropic 格式）：只收 Claude 系模型（实测 muse 走它 400
 *   "Model not supported on this endpoint"）；GOAT 套餐不含 Claude（claude-sonnet-5
 *   经 messages 403 MODEL_NOT_IN_PLAN）。
 * - GET  /models → 免 key 公开（2026-09-08 复测 67 个模型，带 key 同样 67 个，
 *   含全部 5 个 muse；OpenAI list 形 {id, name, context_length}，ID 含斜杠）。
 * - POST /responses → 404 不存在（实测）→ responses 入口走网关 responses->chat 转换。
 * messages 端点只收 Claude 系（实测 muse 走它 400），而 GOAT 套餐不含 Claude
 * （claude-sonnet-5 经 messages 403 MODEL_NOT_IN_PLAN）——本池只服务 OpenAI/OSS
 * 模型，supportedInterfaces 摘掉 messages 统一只声明 chat，messages 入口由网关
 * messages->chat 接力（对齐 commit 1eb8a43 对 omen-alpha 的处理）。
 *
 * 认证：Authorization: Bearer <user_... key>，CLI 与 API 同端点同 key，
 * 无任何客户端指纹要求（不透传也不伪装 UA）。
 *
 * 错误语义（2026-09-07/08 调研 + 实测）：
 * - 401/403 → 认证错误（无 key 实测响应体 {"success":false,"error":{"code":"UNAUTHORIZED","status":401}}）。
 * - 403 MODEL_NOT_IN_PLAN（{"type":"error","error":{"type":"permission_error","message":"MODEL_NOT_IN_PLAN: ..."}}）
 *   → 套餐不含该模型：切账号（可能切到含该模型的套餐），不冷却不标记。
 * - 429/402/400 且错误体带 rateLimit.window: "fiveHour"|"weekly" → 对应窗口配额耗尽，
 *   按 rateLimit.resetAt 冷却到该时间后切号（窗口结构待生产验证）。
 * - 其余 429 → 瞬时限流，同账号退避重试（上限 COMMAND_CODE_RATE_LIMIT_MAX_RETRIES）再切号。
 * - 403/其他状态命中 geo 限制措辞（GPT-5.6 Luna / Gemini 系对中国 IP 不可用）→ 不分类，
 *   透传错误给客户端。
 *
 * 已知上游特性（2026-09-08 实测，网关侧不做特判）：
 * - muse 经 GOAT 时 max_tokens < 512 会被 reasoning 吃光返回空 content；
 * - 偶发 finish_reason=stop 但 content 为空串（上游重试节点问题）。
 */

import type {
  Provider,
  QuotaWindow,
  ProviderCredential,
  ForwardRequestInput,
  ForwardTarget,
  UpstreamErrorClassification,
} from "./types"
import type { AccountRecord, ProviderAccountData, QuotaKind } from "../types"
import type { PoolType } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import {
  COMMAND_CODE_PROVIDER_BASE,
  CommandCodeApiKeyInvalidError,
  commandCodePlanDisplay,
  fetchCommandCodeCredits,
  fetchCommandCodeModels,
  fetchCommandCodeSubscription,
  fetchCommandCodeUsage,
  matchCommandCodeModel,
  windowsFromCommandCodeQuota,
} from "../command-code"

/**
 * 瞬时 429（非窗口耗尽）同账号退避重试的最大次数；全部失败后再走切账号逻辑。
 * 对齐 GLM 的 GLM_RATE_LIMIT_MAX_RETRIES 语义。
 */
export const COMMAND_CODE_RATE_LIMIT_MAX_RETRIES = 6

/** 配额三窗：FIVE_HOUR + WEEKLY（/alpha/billing/credits 双窗）+ MONTHLY 余额窗。 */
const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY", "MONTHLY"]
/**
 * 首次 /models 同步成功前的引导目录（全量 67 个模型由 REMOTE 同步覆盖）。
 * 选自 2026-09-07 实测 GET /provider/v1/models 响应。
 */
const DEFAULT_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "gpt-5.6-sol",
  "deepseek/deepseek-v4-pro",
  "moonshotai/Kimi-K3",
  "zai-org/GLM-5.3",
  "meta/muse-spark-1.3-contributor",
] as const
const PASSTHROUGH_HEADERS = ["accept-language", "anthropic-version", "anthropic-beta"] as const

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
}

/** 超窗错误体的 rateLimit 结构：{"rateLimit":{"window":"fiveHour"|"weekly","resetAt":...}}。 */
interface WindowRateLimitHit {
  window: "fiveHour" | "weekly"
  resetAt: string | null
}

function toIsoString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
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

/**
 * 从错误体解析 rateLimit.window 标记。宽容下钻 error 嵌套（≤3 层），
 * window 只认 fiveHour / weekly 两值，其余视为未命中（不当窗口耗尽处理）。
 */
export function parseWindowRateLimit(body: string): WindowRateLimitHit | null {
  if (!body) return null
  try {
    let current: unknown = JSON.parse(body)
    for (let depth = 0; current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3; depth += 1) {
      const record = current as Record<string, unknown>
      const rateLimit = record.rateLimit
      if (rateLimit && typeof rateLimit === "object" && !Array.isArray(rateLimit)) {
        const row = rateLimit as Record<string, unknown>
        const label = String(row.window ?? "").toLowerCase()
        const resetAt = toIsoString(row.resetAt ?? row.reset_at ?? row.resetTime)
        if (/five[_-]?hour|5h/.test(label)) return { window: "fiveHour", resetAt }
        if (/week/.test(label)) return { window: "weekly", resetAt }
        return null
      }
      current = record.error
    }
  } catch {
    // 非 JSON 错误体：无结构化窗口信息。
  }
  return null
}

// geo 限制措辞（GPT-5.6 Luna 与 Gemini 系对中国 IP 不可用，2026-09-07 调研）。
// 命中即不分类（return null），让网关把上游错误原样透传给客户端。
const GEO_RESTRICTION_PATTERNS = [
  /not available in (?:your )?(?:region|country|location)/i,
  /unsupported[_ ](?:country|region|territory)/i,
  /geo(?:-|\s)?(?:restrict|block|limit)/i,
  /region (?:is )?not supported/i,
] as const

function isGeoRestrictionError(body: string): boolean {
  if (!body) return false
  return GEO_RESTRICTION_PATTERNS.some((pattern) => pattern.test(body))
}

export class CommandCodeProvider implements Provider {
  readonly poolType: PoolType = "command-code"
  readonly displayName = "Command Code"

  private readonly vault = new SecretVault()

  private readCredentialData(account: AccountRecord): { data: ProviderAccountData; credentialVersion: number } {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new CommandCodeApiKeyInvalidError(`Command Code 账号缺少凭据，account=${account.id}`)
    return {
      data: JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData,
      credentialVersion: row.credential_version,
    }
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const { data, credentialVersion } = this.readCredentialData(account)
    if (!data.token) {
      throw new CommandCodeApiKeyInvalidError(`Command Code 账号缺少 API key，account=${account.id}`)
    }
    // 凭据为 Studio 创建的长期 API key（user_...），无过期无刷新；无指纹头要求。
    return { token: data.token, credentialVersion }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    let credential: ProviderCredential
    try {
      credential = await this.getCredential(account)
    } catch (cause) {
      if (cause instanceof CommandCodeApiKeyInvalidError) return { valid: false }
      throw cause
    }
    try {
      const credits = await fetchCommandCodeCredits(credential.token, account)
      // 套餐/账期 best-effort：失败不影响校验，plan 回退常量标识。
      let subscription: Awaited<ReturnType<typeof fetchCommandCodeSubscription>> = null
      try {
        subscription = await fetchCommandCodeSubscription(credential.token, account)
      } catch {
        subscription = null
      }
      const planId = subscription?.planId ?? ""
      const planType = commandCodePlanDisplay(planId) || "command-code"
      this.backfillCredentialPlan(account.id, planId)
      return { valid: true, planType, extra: { planId: planId || undefined, subscriptionStatus: subscription?.status } }
    } catch (error) {
      if (error instanceof CommandCodeApiKeyInvalidError) return { valid: false }
      // 网络/5xx 抖动不误杀账号。
      return { valid: true }
    }
  }

  /**
   * best-effort 回填 subscriptions 发现的套餐（照抄 kimi userLevel / openai-cpa
   * backfillCredentialIdentity 模式）：只写凭据 commandCodePlan，回填失败不影响校验。
   */
  private backfillCredentialPlan(accountId: string, planId: string): void {
    if (!planId) return
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?").get(accountId) as { credential_data_ciphertext: string } | undefined
      if (!row) return
      const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
      if (data.commandCodePlan === planId) return
      data.commandCodePlan = planId
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)
    } catch {
      // best-effort：回填失败不影响校验结果
    }
  }

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  supportedInterfaces(_model?: string): readonly import("../messages/route-decision").InterfaceFormat[] {
    // /responses 上游 404 不存在（实测）：responses 入口由网关转换链转 chat 后上行。
    // messages 端点只收 Claude 系（实测 muse 走它 400 "Model not supported on this
    // endpoint"），而 GOAT 套餐不含 Claude（claude-sonnet-5 经 messages 403
    // MODEL_NOT_IN_PLAN）——本池实际只服务 OpenAI/OSS 模型，messages 能力整体摘掉，
    // 统一只声明 chat：messages 入口由网关 messages->chat 接力，chat 入口原生直通
    // （对齐 commit 1eb8a43 对 omen-alpha 的处理，网关无 chat->messages 转换链）。
    void _model
    return ["chat"] as const
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    void _accountId
    const credential = await this.getCredential(account)
    // 三窗主源 /alpha/billing/credits（双窗 + 余额）；subscriptions 取套餐/账期
    // best-effort（失败继续，用兜底 cap）；summary 仅作 extra 对账 + 兜底消耗口径。
    const credits = await fetchCommandCodeCredits(credential.token, account)
    if (!credits) throw new Error("Command Code 账单接口响应缺少 credits 结构")
    let subscription: Awaited<ReturnType<typeof fetchCommandCodeSubscription>> = null
    try {
      subscription = await fetchCommandCodeSubscription(credential.token, account)
    } catch {
      subscription = null
    }
    let usage: Awaited<ReturnType<typeof fetchCommandCodeUsage>> | null = null
    try {
      usage = await fetchCommandCodeUsage(credential.token, account)
    } catch {
      usage = null
    }
    if (subscription?.planId) this.backfillCredentialPlan(account.id, subscription.planId)
    return windowsFromCommandCodeQuota({ credits, subscription, usage })
  }

  getAvailableModels(): string[] {
    return this.readCachedModels() ?? [...DEFAULT_MODELS]
  }

  getDefaultModels(): string[] {
    return [...DEFAULT_MODELS]
  }

  /**
   * 目录成员判定 + 裸名唯一后缀命中（{model} → {provider}/{model}）。
   * 精确命中（含大小写不敏感变体）与裸名唯一后缀均视为支持；歧义/未命中不支持，
   * 让路由 fail-closed（与全仓库 providerSupportsModel 的目录语义一致）。
   */
  supportsModel(model: string): boolean {
    const requested = model.trim()
    if (!requested) return false
    if (!requested.includes("/")) {
      // 目录里恰好存在以裸名为全 ID 的模型时精确命中已覆盖；这里处理唯一后缀。
      const match = matchCommandCodeModel(requested, this.getAvailableModels())
      return match.kind === "EXACT" || match.kind === "UNIQUE_SUFFIX"
    }
    return matchCommandCodeModel(requested, this.getAvailableModels()).kind === "EXACT"
  }

  /**
   * GET /provider/v1/models 免 key 公开（2026-09-08 复测：无认证与带 key 均 200、
   * 同 67 个模型含全部 5 个 muse），有账号无账号都能同步。
   */
  async fetchRemoteModels(_account: AccountRecord): Promise<string[] | null> {
    void _account
    return fetchCommandCodeModels()
  }

  /** 免鉴权目录拉取：无 ready 账号时 syncProviderModels 走这里同步全量清单。 */
  async fetchCredentiallessModels(): Promise<string[] | null> {
    return fetchCommandCodeModels()
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
    void _account
    const requested = requestedModel.trim()
    if (!requested) return requestedModel
    const match = matchCommandCodeModel(requested, this.getAvailableModels())
    if (match.kind === "UNIQUE_SUFFIX") {
      // 裸名 → 唯一 {provider}/{model} 全 ID：上行 body 的 model 必须改写成全 ID。
      return match.matched
    }
    if (match.kind === "AMBIGUOUS") {
      // 多个 {provider}/{同裸名} 候选：不确定性错误，宁可失败也不静默猜一个
      // （静默取第一个会烧错账号的配额且行为不可复现）。候选清单随错误透出，
      // 客户端带上前缀重试即可。
      throw new Error(
        `Command Code 模型裸名 "${requested}" 命中多个候选（${match.candidates.join(", ")}），请使用带前缀的全名`,
      )
    }
    if (match.kind === "EXACT") return match.matched
    // MISS：原样透传，交给上游做模型校验（路由层 fail-closed 已在 supportsModel 拦截；
    // 走到这里说明目录缺项但用户显式指定，保留上游兜底）。
    return requested
  }

  getUpstreamBaseUrl(_account: AccountRecord): string {
    void _account
    return COMMAND_CODE_PROVIDER_BASE
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    void _account
    // 单 base：endpoint（chat/completions | messages）直拼。responses 不会原生
    // 到达这里（supportedInterfaces 未声明，路由层先转 chat）；万一到达则上游
    // 404 透传，不做特殊处理。
    const url = `${COMMAND_CODE_PROVIDER_BASE}/${input.endpoint.replace(/^\/+/, "")}`

    const headers = new Headers()
    headers.set("Authorization", `Bearer ${credential.token}`)
    headers.set("accept", "application/json, text/event-stream")
    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }
    // 白名单透传（messages 原生端点依赖 anthropic-version 等）；客户端 UA 不透传，
    // 也无需伪装——Command Code 对 CLI 与 API 客户端一视同仁（2026-09-07 调研）。
    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }

    // 裸名唯一后缀命中时 upstreamModel 是 {provider}/{model} 全 ID（resolveModel 已解析），
    // 上行 body 的 model 必须改写成全 ID（对齐 custom.ts 的 upstreamModel 注入模式）。
    let body = input.body
    if (body?.length && input.upstreamModel && input.upstreamModel !== input.model) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
        parsed.model = input.upstreamModel
        body = new TextEncoder().encode(JSON.stringify(parsed))
      } catch { /* upstream will validate malformed JSON */ }
    }

    return { url, headers, body }
  }

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    // 超窗错误优先识别：declined/429/402 等形态的错误体带 rateLimit.window +
    // resetAt（调研结论，待生产验证）→ 冷却到 resetAt 后恢复。
    const windowHit = parseWindowRateLimit(body)
    if (windowHit && (status === 400 || status === 402 || status === 403 || status === 429)) {
      const resetMs = windowHit.resetAt ? Date.parse(windowHit.resetAt) : Number.NaN
      return {
        shouldSwitchAccount: true,
        quotaKind: windowHit.window === "fiveHour" ? "FIVE_HOUR" : "WEEKLY",
        retryAfterSeconds: !Number.isNaN(resetMs)
          ? Math.max(0, Math.ceil((resetMs - Date.now()) / 1000))
          : retryAfterSeconds(headers.get("retry-after")) ?? 60,
        errorType: "COMMAND_CODE_WINDOW_EXHAUSTED",
      }
    }
    // 套餐不含该模型（如 GOAT 不含 Claude 系，2026-09-08 实测 403
    // {"type":"error","error":{"type":"permission_error","message":"MODEL_NOT_IN_PLAN: ..."}}）：
    // 切下一个可用账号（换号可能换到含该模型的套餐），不冷却、不标记失效。
    if (status === 403 && /MODEL_NOT_IN_PLAN/i.test(body)) {
      return {
        shouldSwitchAccount: true,
        errorType: "COMMAND_CODE_MODEL_NOT_IN_PLAN",
      }
    }
    if (status === 401 || status === 403) {
      // geo 限制（部分模型对中国 IP 不可用）不是账号问题：透传错误，不切号不标记。
      if (status === 403 && isGeoRestrictionError(body)) return null
      return {
        shouldSwitchAccount: false,
        errorType: "AuthenticationError",
      }
    }
    if (status === 402) {
      // 402 = 计费/套餐类错误（订阅制下不应出现；兜底对齐 GLM 语义直接切账号）。
      return {
        shouldSwitchAccount: true,
        quotaKind: "WEEKLY",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 60,
        errorType: "COMMAND_CODE_QUOTA_EXCEEDED",
      }
    }
    if (status === 429) {
      // 无窗口标记的 429 = 瞬时限流：先同号退避重试，用尽后再切账号。
      return {
        shouldSwitchAccount: true,
        retrySameAccount: { maxRetries: COMMAND_CODE_RATE_LIMIT_MAX_RETRIES },
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")),
        errorType: "COMMAND_CODE_RATE_LIMITED",
      }
    }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}
