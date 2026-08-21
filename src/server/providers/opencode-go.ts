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
// 上游原生支持 /v1/responses 的模型白名单（实测确认，含 muse 家族）。
// 不在白名单的模型只走 chat/messages；responses 请求则经网关转 chat 兼容链路。
const OPENCODE_GO_RESPONSES_MODELS = new Set(["gpt-5.6-luna", "muse-spark-1.2-contributor"])

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

  classifyError(status: number, body: string, _headers: Headers): UpstreamErrorClassification | null {
    const limit = classifyGoUsageLimit(status, body)
    if (limit) return limit
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
