import { Script, createContext } from "node:vm"
import { apiFetchWithMirrorContext } from "../api-fetch"
import type { MirrorSelectionAccount } from "../api-fetch"
import { getCustomProviderByPoolType, type CustomProviderBalanceConfig, type CustomProviderInterface } from "../custom-providers"
import { getDatabase } from "../db"
import { ProviderCredentialRepository } from "../repository"
import { endpointForFormat, formatForEndpoint } from "../messages/route-decision"
import type { AccountRecord, PoolType, QuotaKind } from "../types"
import type { ForwardRequestInput, ForwardTarget, Provider, ProviderCredential, QuotaWindow, UpstreamErrorClassification } from "./types"

type BalanceKind = "permanent" | "5h" | "weekly" | "monthly" | "period"
type BalanceWindowResult = {
  type?: BalanceKind
  kind?: BalanceKind
  remaining: number
  total?: number
  resetAt?: string | null
  periodSeconds?: number | null
  unit?: string
}
type BalanceExtractorResult = BalanceWindowResult & { isValid?: boolean; windows?: BalanceWindowResult[] }

export class InvalidCustomProviderCredentialError extends Error {
  constructor() { super("余额接口返回凭据无效"); this.name = "InvalidCustomProviderCredentialError" }
}

const PASSTHROUGH_HEADERS = ["accept", "content-type", "user-agent", "openai-organization", "openai-project"]

function configFor(poolType: PoolType) {
  const config = getCustomProviderByPoolType(poolType)
  if (!config) throw new Error(`自定义 Provider 不存在: ${poolType}`)
  return config
}

export function parseModelList(value: unknown): string[] {
  const object = value && typeof value === "object" ? value as { data?: unknown; models?: unknown } : {}
  const rows = Array.isArray(value) ? value : Array.isArray(object.data) ? object.data : Array.isArray(object.models) ? object.models : []
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

function renderTemplate(value: string, baseUrl: string, apiKey: string): string {
  return value.replaceAll("{{baseUrl}}", baseUrl).replaceAll("{{apiKey}}", apiKey)
}

function renderValue(value: unknown, baseUrl: string, apiKey: string): unknown {
  if (typeof value === "string") return renderTemplate(value, baseUrl, apiKey)
  if (Array.isArray(value)) return value.map((item) => renderValue(item, baseUrl, apiKey))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, baseUrl, apiKey)]))
  return value
}

export function runBalanceExtractor(source: string, response: unknown): BalanceExtractorResult {
  if (source.length > 20_000) throw new Error("余额 extractor 不能超过 20KB")
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  const serialized = JSON.stringify(response) ?? "null"
  const script = new Script(`"use strict"; const response = JSON.parse(${JSON.stringify(serialized)}); const extractor = (${source}); if (typeof extractor !== "function") throw new Error("extractor 必须是函数"); extractor(response);`)
  const result = script.runInContext(context, { timeout: 100 }) as unknown
  if (!result || typeof result !== "object") throw new Error("extractor 必须返回对象")
  return structuredClone(result) as BalanceExtractorResult
}

function quotaKind(value: BalanceKind | undefined): QuotaKind {
  if (value === "5h") return "FIVE_HOUR"
  if (value === "weekly") return "WEEKLY"
  if (value === "monthly") return "MONTHLY"
  if (value === "period") return "CUSTOM_PERIOD"
  return "PERMANENT"
}

function balanceWindow(value: BalanceWindowResult, observedAt: string): QuotaWindow {
  const remaining = Number(value.remaining)
  const total = value.total == null ? null : Number(value.total)
  if (!Number.isFinite(remaining) || (total != null && (!Number.isFinite(total) || total < 0))) throw new Error("余额 remaining/total 必须是有限数字")
  const usagePercent = total && total > 0 ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : remaining > 0 ? 0 : 100
  let resetAt = typeof value.resetAt === "string" && Number.isFinite(Date.parse(value.resetAt)) ? new Date(value.resetAt).toISOString() : null
  if (!resetAt && value.periodSeconds && Number.isFinite(Number(value.periodSeconds)) && Number(value.periodSeconds) > 0) {
    resetAt = new Date(Date.parse(observedAt) + Number(value.periodSeconds) * 1000).toISOString()
  }
  return {
    kind: quotaKind(value.type ?? value.kind), usagePercent, resetAt,
    resetInSeconds: resetAt ? Math.max(0, Math.ceil((Date.parse(resetAt) - Date.parse(observedAt)) / 1000)) : null,
    lastObservedAt: observedAt, source: "API_PROBE", limitValue: total, remainingValue: remaining, unit: value.unit?.trim() || null,
  }
}

async function queryBalance(config: CustomProviderBalanceConfig, baseUrl: string, apiKey: string, account: MirrorSelectionAccount): Promise<{ valid: boolean; windows: QuotaWindow[] }> {
  const request = config.request
  const headers = new Headers(renderValue(request.headers ?? {}, baseUrl, apiKey) as Record<string, string>)
  const bodyValue = renderValue(request.body, baseUrl, apiKey)
  const method = request.method ?? "GET"
  // GET/HEAD requests cannot carry a body; ignore configured body instead of
  // letting fetch reject the request (e.g. DeepSeek balance is a GET with no body).
  const sendBody = method !== "GET" && bodyValue != null
  const response = await apiFetchWithMirrorContext(renderTemplate(request.url, baseUrl, apiKey), {
    method, headers,
    body: sendBody ? (typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue)) : undefined,
    signal: AbortSignal.timeout(20_000), redirect: "error",
  }, { account })
  const text = await response.text()
  let payload: unknown = text
  try { payload = JSON.parse(text) } catch { /* extractor may intentionally consume text */ }
  if (!response.ok) throw new Error(`余额接口请求失败（HTTP ${response.status}）: ${text.slice(0, 200)}`)
  const extracted = runBalanceExtractor(config.extractor, payload)
  const values = extracted.windows?.length ? extracted.windows : [extracted]
  const observedAt = new Date().toISOString()
  return { valid: extracted.isValid !== false, windows: values.map((item) => balanceWindow(item, observedAt)) }
}

export class CustomProvider implements Provider {
  constructor(readonly poolType: PoolType) {}
  get displayName(): string { return configFor(this.poolType).name }
  get interfaceTypes(): CustomProviderInterface[] { return configFor(this.poolType).interfaceTypes }
  supportedInterfaces(): readonly CustomProviderInterface[] { return configFor(this.poolType).interfaceTypes }
  supportedQuotaKinds(): readonly QuotaKind[] { return ["PERMANENT", "FIVE_HOUR", "WEEKLY", "MONTHLY", "CUSTOM_PERIOD"] }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    const config = configFor(this.poolType)
    if (!config.balanceConfig) return []
    const credential = await this.getCredential(account)
    const result = await queryBalance(config.balanceConfig, config.baseUrl, credential.token, account)
    if (!result.valid) throw new InvalidCustomProviderCredentialError()
    return result.windows
  }

  getAvailableModels(): string[] {
    const config = configFor(this.poolType)
    if (config.models?.length) return [...config.models]
    try {
      const row = getDatabase().prepare("SELECT models_json FROM provider_model_cache WHERE pool_type=?").get(this.poolType) as { models_json: string } | undefined
      const models = row ? JSON.parse(row.models_json) as unknown : null
      return Array.isArray(models) ? models.filter((value): value is string => typeof value === "string") : []
    } catch { return [] }
  }
  getDefaultModels(): string[] { return configFor(this.poolType).models ?? [] }
  supportsModel(model: string): boolean { const models = this.getAvailableModels(); return models.length === 0 || models.includes(model) }
  resolveModel(_account: AccountRecord, requestedModel: string): string { return requestedModel }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    const config = configFor(this.poolType)
    if (config.models?.length) return [...config.models]
    const credential = await this.getCredential(account)
    const response = await apiFetchWithMirrorContext(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${credential.token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) }, { account })
    const text = await response.text()
    if (!response.ok) throw new Error(`/models 拉取失败（HTTP ${response.status}）: ${text.slice(0, 200)}`)
    return parseModelList(JSON.parse(text))
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const data = new ProviderCredentialRepository(account.ownerUserId).get(account.id)
    if (!data?.token) throw new Error(`账号 ${account.id} 没有 API Key`)
    return { token: data.token, extraHeaders: data.extraHeaders ? JSON.parse(data.extraHeaders) as Record<string, string> : undefined, credentialVersion: account.credentialVersion }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean }> {
    try {
      const config = configFor(this.poolType)
      const credential = await this.getCredential(account)
      if (config.balanceConfig) return { valid: (await queryBalance(config.balanceConfig, config.baseUrl, credential.token, account)).valid }
      const response = await apiFetchWithMirrorContext(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(20_000) }, { account })
      return { valid: response.ok }
    } catch { return { valid: false } }
  }

  getUpstreamBaseUrl(): string { return configFor(this.poolType).baseUrl }
  buildForwardTarget(input: ForwardRequestInput, credential: ProviderCredential): ForwardTarget {
    const config = configFor(this.poolType)
    const headers = new Headers()
    for (const name of PASSTHROUGH_HEADERS) { const value = input.headers.get(name); if (value) headers.set(name, value) }
    headers.set("authorization", `Bearer ${credential.token}`)
    if (!headers.has("content-type") && input.method !== "GET") headers.set("content-type", "application/json")
    for (const [key, value] of Object.entries(credential.extraHeaders ?? {})) headers.set(key, value)
    let body = input.body
    if (body?.length && input.upstreamModel) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
        parsed.model = input.upstreamModel
        body = new TextEncoder().encode(JSON.stringify(parsed))
      } catch { /* upstream will validate malformed JSON */ }
    }
    // 尊重 Gateway 决策后传入的端点（原生优先）；不在支持集合内时回退到
    // 首选格式。probe/test-connection 不走这里，不受影响。
    const supported = config.interfaceTypes
    const inputFormat = formatForEndpoint(input.endpoint)
    const endpoint = inputFormat && supported.includes(inputFormat) ? input.endpoint.replace(/^\/+/, "") : endpointForFormat(supported[0])
    return { url: `${config.baseUrl}/${endpoint}`, headers, body }
  }

  classifyError(status: number, _body: string, headers: Headers): UpstreamErrorClassification | null {
    if (status === 401) return { shouldSwitchAccount: true, permanentlyDisableAccount: true, errorType: "AuthenticationError" }
    if (status === 429) {
      const retry = Number(headers.get("retry-after"))
      return { shouldSwitchAccount: true, quotaKind: "PROVIDER_RATE_LIMIT", retryAfterSeconds: Number.isFinite(retry) ? retry : 60, errorType: "RateLimitError" }
    }
    if (status >= 500) return { shouldSwitchAccount: true, quotaKind: "PROVIDER_RATE_LIMIT", retryAfterSeconds: 30, errorType: "UpstreamError" }
    return null
  }
  isAccountReady(account: AccountRecord): boolean {
    const config = getCustomProviderByPoolType(this.poolType)
    return Boolean(config?.enabled) && account.adminState === "ENABLED" && account.authState === "VALID" && account.subscriptionState === "ACTIVE"
  }
}

interface CustomProviderModelsProbeResult {
  ok: boolean
  status?: number
  durationMs: number
  models: string[]
  error?: string
}

interface CustomProviderBalanceProbeResult {
  ok: boolean
  status?: number
  durationMs: number
  valid: boolean
  windows: Array<{ kind: string; remaining: number; total: number | null; unit: string | null }>
  error?: string
}

export interface CustomProviderProbeResult {
  ok: boolean
  durationMs: number
  models: CustomProviderModelsProbeResult | null
  balance: CustomProviderBalanceProbeResult | null
}

export async function probeCustomProvider(input: {
  baseUrl: string
  apiKey?: string | null
  extraHeaders?: Record<string, string>
  balanceConfig?: CustomProviderBalanceConfig | null
}): Promise<CustomProviderProbeResult> {
  const { baseUrl, apiKey, extraHeaders, balanceConfig } = input
  const probeAccount: MirrorSelectionAccount = { id: "custom-provider-probe", poolType: "custom:probe" }
  const startedAt = Date.now()

  const modelsPromise = (async (): Promise<CustomProviderModelsProbeResult> => {
    const requestStartedAt = Date.now()
    try {
      const headers = new Headers(extraHeaders ?? {})
      if (apiKey) headers.set("authorization", `Bearer ${apiKey}`)
      headers.set("accept", "application/json")
      const response = await apiFetchWithMirrorContext(`${baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      }, { account: probeAccount })
      const text = await response.text()
      if (!response.ok) return { ok: false, status: response.status, durationMs: Date.now() - requestStartedAt, models: [], error: `/models 拉取失败（HTTP ${response.status}）: ${text.slice(0, 200)}` }
      return { ok: true, status: response.status, durationMs: Date.now() - requestStartedAt, models: parseModelList(JSON.parse(text)) }
    } catch (cause) {
      return { ok: false, durationMs: Date.now() - requestStartedAt, models: [], error: cause instanceof Error ? cause.message : "未知错误" }
    }
  })()

  const balancePromise = balanceConfig ? (async (): Promise<CustomProviderBalanceProbeResult> => {
    const requestStartedAt = Date.now()
    try {
      const result = await queryBalance(balanceConfig, baseUrl, apiKey ?? "", probeAccount)
      return {
        ok: true,
        durationMs: Date.now() - requestStartedAt,
        valid: result.valid,
        windows: result.windows.map((window) => ({ kind: window.kind, remaining: window.remainingValue ?? 0, total: window.limitValue ?? null, unit: window.unit ?? null })),
      }
    } catch (cause) {
      return { ok: false, durationMs: Date.now() - requestStartedAt, valid: false, windows: [], error: cause instanceof Error ? cause.message : "未知错误" }
    }
  })() : null

  const [modelsResult, balanceResult] = await Promise.all([modelsPromise, balancePromise ?? Promise.resolve(null)])
  return {
    ok: modelsResult.ok && (balanceResult === null || balanceResult.ok),
    durationMs: Date.now() - startedAt,
    models: modelsResult,
    balance: balanceResult,
  }
}
