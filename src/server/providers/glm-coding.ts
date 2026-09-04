/**
 * GLM Coding Plan Provider
 *
 * 智谱 GLM Coding Plan（国内 open.bigmodel.cn / 国际 api.z.ai），凭据为
 * coding-plan API key（OAuth 兑换或控制台手建，长期有效）。
 * 转发时注入 ZCode 3.9.1 客户端指纹头（1.5 倍折扣的关键）。
 * 三接口格式全原生：chat completions / responses / anthropic messages
 * （2026-09-04 真实 key curl 实测均 200）。
 * 配额：GET /api/monitor/usage/quota/limit（unit=3 → 5h 窗，unit=6 → 周窗）。
 */

import { randomUUID } from "node:crypto"
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
import {
  createZcodeIdentityHeaders,
  fetchGlmQuota,
  glmBaseForEndpoint,
  glmEndpointBases,
  GlmApiKeyInvalidError,
  windowsFromGlmQuota,
  type GlmRegion,
} from "../glm-coding"

/**
 * 瞬时 429（并发限流，非配额耗尽）同账号退避重试的最大次数。
 * GLM Coding 的限流口径是并发数，超限通常很快释放，重试几次大概率能过；
 * 全部失败后再走切账号逻辑。
 */
export const GLM_RATE_LIMIT_MAX_RETRIES = 6

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY"]
const DEFAULT_MODELS = ["glm-5.3", "glm-5.3-flash", "glm-5.3[1m]", "glm-5.3-flash[1m]"] as const
const PASSTHROUGH_HEADERS = ["accept-language", "anthropic-version", "anthropic-beta"] as const

/** getCredential → buildForwardTarget 的内部透传键（非 HTTP 头，绝不写入上游请求）。 */
const INTERNAL_REGION_KEY = "__glmRegion"
const INTERNAL_DEVICE_MID_KEY = "__glmDeviceMid"

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
}

// 配额/套餐耗尽措辞。GLM 配额耗尽的错误结构尚未实测复现（需真实耗尽账号），
// 按计费类通用措辞分类：结构化 error.code/type 或 message 命中即视为配额耗尽
// （切账号）；其余 429 为并发限流（同号退避重试）。后续拿到真实错误体再精化。
const GLM_QUOTA_EXHAUSTED_CODES = new Set(["exceeded_current_quota_error", "insufficient_quota", "quota_exceeded"])
const GLM_QUOTA_EXHAUSTED_PATTERNS = [
  /exceeded your current (?:token )?quota/,
  /insufficient (?:balance|quota)/,
  /account (?:is )?in arrears/,
  /please recharge|recharge your account/,
  /(?:coding )?plan (?:quota|limit) (?:has been )?exceeded/,
  /套餐(?:额度|已用完|耗尽)/,
  /额度(?:已用完|耗尽|不足)/,
  /欠费|余额不足/,
] as const

function isGlmQuotaExhausted(body: string): boolean {
  if (!body) return false
  try {
    const codes: string[] = []
    let current: unknown = JSON.parse(body)
    for (let depth = 0; current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3; depth += 1) {
      const record = current as Record<string, unknown>
      if (typeof record.code === "string") codes.push(record.code)
      if (typeof record.type === "string") codes.push(record.type)
      current = record.error
    }
    if (codes.some((code) => GLM_QUOTA_EXHAUSTED_CODES.has(code))) return true
  } catch {
    // 非 JSON（如纯文本），走 message 匹配。
  }
  return GLM_QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(body))
}

export class GlmCodingProvider implements Provider {
  readonly poolType: PoolType = "glm-coding"
  readonly displayName = "GLM Coding Plan"

  private readonly vault = new SecretVault()

  private readCredentialData(account: AccountRecord): { data: ProviderAccountData; credentialVersion: number } {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new GlmApiKeyInvalidError(`GLM 账号缺少凭据，account=${account.id}`)
    return {
      data: JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData,
      credentialVersion: row.credential_version,
    }
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const { data, credentialVersion } = this.readCredentialData(account)
    if (!data.token) {
      throw new GlmApiKeyInvalidError(`GLM 账号缺少 API key，account=${account.id}`)
    }
    // 凭据为长期 coding-plan API key（OAuth 兑换或手建），无过期无刷新；
    // region 默认国内，deviceMid 为建号时生成的持久化 hex 设备 ID。
    return {
      token: data.token,
      extraHeaders: {
        [INTERNAL_REGION_KEY]: data.region === "global" ? "global" : "cn",
        [INTERNAL_DEVICE_MID_KEY]: data.deviceMid || "",
      },
      credentialVersion,
    }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    let credential: ProviderCredential
    try {
      credential = await this.getCredential(account)
    } catch (cause) {
      if (cause instanceof GlmApiKeyInvalidError) return { valid: false }
      throw cause
    }
    const region = (credential.extraHeaders?.[INTERNAL_REGION_KEY] as GlmRegion) || "cn"
    try {
      const quota = await fetchGlmQuota(credential.token, region, account)
      return { valid: true, planType: "glm-coding", extra: { level: quota.level || undefined, windows: quota.limits.length } }
    } catch (error) {
      if (error instanceof GlmApiKeyInvalidError) return { valid: false }
      // 网络/5xx 抖动不误杀账号。
      return { valid: true }
    }
  }

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  supportedInterfaces(): readonly import("../messages/route-decision").InterfaceFormat[] {
    // 三端点均原生支持（2026-09-04 实测），路由零转换。
    return ["chat", "messages", "responses"] as const
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    void _accountId
    const credential = await this.getCredential(account)
    const region = (credential.extraHeaders?.[INTERNAL_REGION_KEY] as GlmRegion) || "cn"
    const quota = await fetchGlmQuota(credential.token, region, account)
    return windowsFromGlmQuota(quota)
  }

  getAvailableModels(): string[] {
    return this.readCachedModels() ?? [...DEFAULT_MODELS]
  }

  getDefaultModels(): string[] {
    return [...DEFAULT_MODELS]
  }

  supportsModel(model: string): boolean {
    return this.getAvailableModels().includes(model)
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
    // 旧型号（glm-5.2 等）由上游自动映射，网关原样透传。
    return requestedModel
  }

  getUpstreamBaseUrl(account: AccountRecord): string {
    // 唯一外部消费者是 mcp/web-search.ts；返回 chat 主址，按账号 region 选择域名。
    try {
      const data = this.readCredentialData(account).data
      return glmEndpointBases(data.region === "global" ? "global" : "cn").chat
    } catch {
      return glmEndpointBases("cn").chat
    }
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    void _account
    const region = (credential.extraHeaders?.[INTERNAL_REGION_KEY] as GlmRegion) || "cn"
    const deviceMid = credential.extraHeaders?.[INTERNAL_DEVICE_MID_KEY] || undefined
    // 三 endpoint（chat/completions | responses | messages）各自映射到对应的
    // base_url（responses 不在 coding 路径下）；未知 endpoint 退回 chat 主址。
    const base = glmBaseForEndpoint(input.endpoint, region) ?? glmEndpointBases(region).chat
    const url = `${base}/${input.endpoint.replace(/^\/+/, "")}`

    const headers = new Headers()
    headers.set("Authorization", `Bearer ${credential.token}`)
    headers.set("accept", "application/json, text/event-stream")
    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }
    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }
    // 指纹头在 passthrough 之后整体注入并覆盖（客户端 UA 一律不透传——
    // 固定 ZCode UA 是拿 1.5 倍折扣的关键）；随后重断言 Authorization。
    for (const [key, value] of Object.entries(createZcodeIdentityHeaders({ deviceMid }))) {
      headers.set(key, value)
    }
    headers.set("Authorization", `Bearer ${credential.token}`)
    // x-request-id：每请求唯一。
    headers.set("x-request-id", randomUUID())

    return { url, headers, body: input.body }
  }

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    if (status === 401 || status === 403) {
      return {
        shouldSwitchAccount: false,
        errorType: "AuthenticationError",
      }
    }
    if (status === 402) {
      // 402 = 计费/套餐类错误：该号配额或权益不可用，直接切账号。
      return {
        shouldSwitchAccount: true,
        quotaKind: "WEEKLY",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 60,
        errorType: "GLM_QUOTA_EXCEEDED",
      }
    }
    if (status === 429) {
      if (isGlmQuotaExhausted(body)) {
        return {
          shouldSwitchAccount: true,
          quotaKind: "WEEKLY",
          retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? 60,
          errorType: "GLM_QUOTA_EXCEEDED",
        }
      }
      // 其余 429 为并发限流（GLM 限流口径是并发数）：先同号退避重试。
      return {
        shouldSwitchAccount: true,
        retrySameAccount: { maxRetries: GLM_RATE_LIMIT_MAX_RETRIES },
        quotaKind: "PROVIDER_RATE_LIMIT",
        retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")),
        errorType: "GLM_RATE_LIMITED",
      }
    }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}
