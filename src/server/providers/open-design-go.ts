/**
 * OpenDesign Go Provider
 * 凭据读写照抄 kimi-code 模式：provider_credentials 加密 JSON {runtimeKey,linkUrl,controlKey,apiUrl,email,plan,userId,workspaceId}
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
import type { AccountRecord, QuotaKind } from "../types"
import type { PoolType } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { apiFetch } from "../api-fetch"

const DEFAULT_API_URL = "https://amr-api.open-design.ai"
const DEFAULT_LINK_URL = "https://amr-link.open-design.ai"
const REQUEST_TIMEOUT_MS = 30000

export const OPEN_DESIGN_GO_DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "minimax-m2.7",
  "mimo-v2.5-pro",
] as const

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["MONTHLY"] as const

export interface OpenDesignGoCredentialData {
  runtimeKey: string
  linkUrl: string
  controlKey?: string
  apiUrl?: string
  email?: string
  plan?: string
  userId?: string
  workspaceId?: string
}

export function normalizeOpenDesignGoBaseUrl(linkUrl?: string | null): string {
  const raw = (linkUrl?.trim() || DEFAULT_LINK_URL).replace(/\/+$/, "")
  const trimmed = raw || DEFAULT_LINK_URL
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
}

export function normalizeOpenDesignGoApiUrl(apiUrl?: string | null): string {
  const raw = (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "")
  return raw || DEFAULT_API_URL
}

/** GET {apiUrl}/api/v1/billing/summary 的响应结构（字段均为上游实测）。 */
export interface OpenDesignBillingSummary {
  balanceUsd?: string | number
  creditsPerUsd?: number
  balances?: { subscriptionCredits?: string; rechargeCredits?: string; totalAvailableCredits?: string }
  membershipTier?: string
  billingInterval?: string
  subscriptionStatus?: string
  subscriptionCurrentPeriodStart?: string
  subscriptionCurrentPeriodEnd?: string
  totalRechargedUsd?: string | number
  totalConsumedUsd?: string | number
  todayConsumedUsd?: string | number
  rechargeCount?: number
  usageCount?: number
  updatedAt?: string
}

function toNumber(value: string | number | undefined): number {
  if (value == null) return Number.NaN
  return typeof value === "number" ? value : Number(value)
}

/**
 * 把 billing/summary 响应解析为 MONTHLY 额度窗口。
 * GO 为无限量订阅模型（不按 token 计费），usagePercent 仅作“累计消费 / 充值总额”的
 * 参考口径；核心展示是订阅周期（resetAt=subscriptionCurrentPeriodEnd）与钱包余额。
 * membershipTier / subscriptionStatus / todayConsumedUsd / usageCount 等放进 extra
 * 供管理端详情页展示。
 */
export function parseOpenDesignBillingSummary(body: string, nowMs: number = Date.now()): QuotaWindow[] {
  let parsed: OpenDesignBillingSummary
  try {
    parsed = JSON.parse(body) as OpenDesignBillingSummary
  } catch { return [] }
  const balanceUsd = toNumber(parsed.balanceUsd)
  if (!Number.isFinite(balanceUsd)) return []
  const totalConsumedUsd = toNumber(parsed.totalConsumedUsd)
  const totalRechargedUsd = toNumber(parsed.totalRechargedUsd)
  const todayConsumedUsd = toNumber(parsed.todayConsumedUsd)
  const consumed = Number.isFinite(totalConsumedUsd) ? totalConsumedUsd : 0
  const recharged = Number.isFinite(totalRechargedUsd) ? totalRechargedUsd : 0
  // 消耗占比：优先“累计消费 / 充值总额”；无充值记录时用“消费 / (消费+余额)”兜底。
  const denominator = recharged > 0 ? recharged : consumed + balanceUsd
  const usagePercent = denominator > 0 ? Math.round((consumed / denominator) * 10000) / 100 : 0
  const balanceCents = Math.max(0, Math.round(balanceUsd * 100))
  const totalCents = Math.max(0, Math.round((recharged > 0 ? recharged : consumed + balanceUsd) * 100))
  const periodEndMs = parsed.subscriptionCurrentPeriodEnd ? Date.parse(parsed.subscriptionCurrentPeriodEnd) : Number.NaN
  const resetAt = Number.isNaN(periodEndMs) ? null : parsed.subscriptionCurrentPeriodEnd ?? null
  const resetInSeconds = Number.isNaN(periodEndMs) ? null : Math.max(0, Math.ceil((periodEndMs - nowMs) / 1000))
  const extra: Record<string, unknown> = {}
  if (parsed.membershipTier != null) extra.membershipTier = parsed.membershipTier
  if (parsed.subscriptionStatus != null) extra.subscriptionStatus = parsed.subscriptionStatus
  if (parsed.billingInterval != null) extra.billingInterval = parsed.billingInterval
  if (parsed.subscriptionCurrentPeriodStart != null) extra.subscriptionPeriodStart = parsed.subscriptionCurrentPeriodStart
  if (resetAt) extra.subscriptionPeriodEnd = resetAt
  if (Number.isFinite(todayConsumedUsd)) extra.todayConsumedUsd = todayConsumedUsd
  if (Number.isFinite(totalConsumedUsd)) extra.totalConsumedUsd = totalConsumedUsd
  if (Number.isFinite(totalRechargedUsd)) extra.totalRechargedUsd = totalRechargedUsd
  if (parsed.usageCount != null) extra.usageCount = parsed.usageCount
  if (parsed.rechargeCount != null) extra.rechargeCount = parsed.rechargeCount
  return [{
    kind: "MONTHLY",
    usagePercent,
    limitValue: null,
    remainingValue: null,
    resetAt,
    resetInSeconds,
    lastObservedAt: new Date(nowMs).toISOString(),
    source: "API_PROBE",
    wallet: { balanceCents, totalCents, monthlyChargeLimitEnabled: false, monthlyChargeLimitCents: 0, monthlyUsedCents: Math.max(0, Math.round(consumed * 100)), currency: "USD" },
    extra,
  }]
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
}

// 推理面：干净 id
export function parseOpenDesignLinkModels(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: unknown }
    const rows = Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : []
    const models = new Set<string>()
    for (const row of rows as unknown[]) {
      if (typeof row === "string" && row.trim()) models.add(row.trim())
      else if (row && typeof row === "object") {
        const id = (row as { id?: unknown }).id
        if (typeof id === "string" && id.trim()) models.add(id.trim())
      }
    }
    return [...models].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// 控制面：name 优先于 id，并剥掉 public_model_ 前缀
export function parseOpenDesignControlModels(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: unknown }
    const rows = Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : []
    const models = new Set<string>()
    for (const row of rows as unknown[]) {
      if (typeof row === "string") {
        let candidate = row.trim()
        if (!candidate) continue
        if (candidate.startsWith("public_model_")) candidate = candidate.slice("public_model_".length)
        if (candidate) models.add(candidate)
        continue
      }
      if (row && typeof row === "object") {
        const r = row as { id?: unknown; name?: unknown; slug?: unknown }
        let candidate: string | undefined
        if (typeof r.name === "string" && r.name.trim()) candidate = r.name.trim()
        else if (typeof r.slug === "string" && r.slug.trim()) candidate = r.slug.trim()
        else if (typeof r.id === "string" && r.id.trim()) candidate = r.id.trim()
        if (!candidate) continue
        if (candidate.startsWith("public_model_")) candidate = candidate.slice("public_model_".length)
        if (candidate) models.add(candidate)
      }
    }
    return [...models].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// 兼容旧名：默认用 link 解析（干净 id）
export function parseOpenDesignModels(body: string): string[] {
  return parseOpenDesignLinkModels(body)
}

export class OpenDesignGoProvider implements Provider {
  readonly poolType: PoolType = "open-design-go"
  readonly displayName = "OpenDesign Go"
  private readonly vault = new SecretVault()

  private readCredentialData(account: AccountRecord): OpenDesignGoCredentialData | null {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?").get(account.id) as { credential_data_ciphertext: string } | undefined
      if (!row?.credential_data_ciphertext) return null
      return JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as OpenDesignGoCredentialData
    } catch {
      return null
    }
  }

  supportedQuotaKinds(): readonly QuotaKind[] { return SUPPORTED_QUOTA_KINDS }
  supportedInterfaces(): readonly import("../messages/route-decision").InterfaceFormat[] { return ["chat"] as const }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    try {
      const data = this.readCredentialData(account)
      if (!data?.controlKey) return []
      const apiUrl = normalizeOpenDesignGoApiUrl(data.apiUrl)
      const resp = await apiFetch(`${apiUrl}/api/v1/billing/summary`, {
        method: "GET",
        headers: { authorization: `Bearer ${data.controlKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await resp.text()
      if (!resp.ok) return []
      return parseOpenDesignBillingSummary(body)
    } catch { return [] }
  }

  getAvailableModels(_accounts: AccountRecord[]): string[] { return this.readCachedModels() ?? [...OPEN_DESIGN_GO_DEFAULT_MODELS] }
  getDefaultModels(): string[] { return [...OPEN_DESIGN_GO_DEFAULT_MODELS] }
  supportsModel(model: string): boolean { return this.getAvailableModels([]).includes(model) }

  async fetchRemoteModels(account: AccountRecord): Promise<string[] | null> {
    const data = this.readCredentialData(account)
    if (!data) throw new Error("OpenDesign Go 凭据不存在")
    // 优先 runtimeKey -> 推理面干净 id
    if (data.runtimeKey) {
      const linkBase = normalizeOpenDesignGoBaseUrl(data.linkUrl)
      try {
        const resp = await apiFetch(`${linkBase}/models`, {
          method: "GET",
          headers: { authorization: `Bearer ${data.runtimeKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const body = await resp.text()
        if (resp.ok) {
          const models = parseOpenDesignLinkModels(body)
          return models
        }
        // 非 ok 且有 controlKey 兜底，则继续尝试控制面
        if (!data.controlKey) {
          throw new Error(`OpenDesign Go /models 拉取失败（HTTP ${resp.status}）: ${body.slice(0, 200)}`)
        }
      } catch (e) {
        if (!data.controlKey) throw e
        // 有 controlKey 兜底，继续
      }
    }
    // 兜底：controlKey -> 控制面（name 优先，剥前缀）
    if (data.controlKey) {
      const apiUrl = normalizeOpenDesignGoApiUrl(data.apiUrl)
      const resp = await apiFetch(`${apiUrl}/api/v1/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${data.controlKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await resp.text()
      if (!resp.ok) throw new Error(`OpenDesign Go /api/v1/models 拉取失败（HTTP ${resp.status}）: ${body.slice(0, 200)}`)
      return parseOpenDesignControlModels(body)
    }
    throw new Error("OpenDesign Go 凭据缺少 runtimeKey 与 controlKey")
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
    } catch { return null }
  }

  resolveModel(_account: AccountRecord, requestedModel: string): string { return requestedModel }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?").get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new Error(`No provider credentials found for account ${account.id}`)
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as OpenDesignGoCredentialData
    if (!data.runtimeKey) throw new Error(`OpenDesign Go 凭据缺少 runtimeKey（account ${account.id}）`)
    return { token: data.runtimeKey, credentialVersion: row.credential_version }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    const data = this.readCredentialData(account)
    if (!data) return { valid: false }
    // 优先 runtimeKey 校验推理面
    if (data.runtimeKey) {
      const linkBase = normalizeOpenDesignGoBaseUrl(data.linkUrl)
      try {
        const resp = await apiFetch(`${linkBase}/models`, {
          method: "GET",
          headers: { authorization: `Bearer ${data.runtimeKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const body = await resp.text()
        if (resp.ok) {
          const models = parseOpenDesignLinkModels(body)
          return { valid: true, email: data.email, planType: data.plan, extra: { modelCount: models.length, linkBase, via: "runtimeKey" } }
        }
        if (resp.status === 401 || resp.status === 403) {
          // 若有 controlKey 兜底，尝试控制面
          if (!data.controlKey) return { valid: false }
        } else {
          if (!data.controlKey) {
            const lower = body.toLowerCase()
            if (lower.includes("unauthorized") || lower.includes("invalid") || lower.includes("forbidden")) return { valid: false }
            return { valid: true }
          }
        }
      } catch (e) {
        if (!data.controlKey) {
          const msg = e instanceof Error ? e.message : String(e)
          if (/\b(401|403)\b/.test(msg)) return { valid: false }
          return { valid: true }
        }
        // 有 controlKey 兜底，继续
      }
    }
    if (data.controlKey) {
      const apiUrl = normalizeOpenDesignGoApiUrl(data.apiUrl)
      try {
        const resp = await apiFetch(`${apiUrl}/api/v1/models`, {
          method: "GET",
          headers: { authorization: `Bearer ${data.controlKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const body = await resp.text()
        if (resp.ok) {
          const models = parseOpenDesignControlModels(body)
          return { valid: true, email: data.email, planType: data.plan, extra: { modelCount: models.length, apiUrl, via: "controlKey" } }
        }
        if (resp.status === 401 || resp.status === 403) return { valid: false }
        const lower = body.toLowerCase()
        if (lower.includes("unauthorized") || lower.includes("invalid") || lower.includes("forbidden")) return { valid: false }
        return { valid: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/\b(401|403)\b/.test(msg)) return { valid: false }
        return { valid: true }
      }
    }
    return { valid: false }
  }

  getUpstreamBaseUrl(account: AccountRecord): string {
    const data = this.readCredentialData(account)
    const linkUrl = data?.linkUrl?.trim() || DEFAULT_LINK_URL
    return normalizeOpenDesignGoBaseUrl(linkUrl)
  }

  buildForwardTarget(input: ForwardRequestInput, credential: ProviderCredential, account: AccountRecord): ForwardTarget {
    const data = this.readCredentialData(account)
    const linkUrl = data?.linkUrl?.trim() || DEFAULT_LINK_URL
    const baseUrl = normalizeOpenDesignGoBaseUrl(linkUrl)
    const headers = new Headers()
    const passthrough = ["accept", "accept-language", "content-type", "user-agent"] as const
    for (const name of passthrough) {
      const v = input.headers.get(name)
      if (v) headers.set(name, v)
    }
    if (!headers.has("content-type") && input.method.toUpperCase() !== "GET") headers.set("content-type", "application/json")
    headers.set("authorization", `Bearer ${credential.token}`)
    headers.set("accept", "application/json, text/event-stream")
    headers.set("X-AMR-Client-Source", "vela")
    if (data?.workspaceId) {
      headers.set("x-vela-workspace-id", data.workspaceId)
      headers.set("X-Open-Design-Workspace-Id", data.workspaceId)
    }
    headers.set("X-Open-Design-Run-Id", randomUUID())
    headers.set("X-Open-Design-Session-Id", randomUUID())
    return { url: `${baseUrl}/chat/completions`, headers, body: input.body }
  }

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    const lower = (body || "").toLowerCase()
    if (status === 401 || status === 403) return { shouldSwitchAccount: false, errorType: "AuthenticationError" }
    if (status === 402 || lower.includes("insufficient") || lower.includes("amr_insufficient_balance")) {
      return { shouldSwitchAccount: true, quotaKind: "MONTHLY", retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")) ?? null, errorType: "BalanceExhausted" }
    }
    if (lower.includes("tier_upgrade") || lower.includes("not_entitled")) return { shouldSwitchAccount: true, errorType: "ModelError" }
    if (status === 400) {
      if (lower.includes("model") && (lower.includes("not supported") || lower.includes("unsupported") || lower.includes("not_entitled") || lower.includes("tier_upgrade"))) return { shouldSwitchAccount: true, errorType: "ModelError" }
      if (lower.includes("unsupported model") || lower.includes("model_not_supported")) return { shouldSwitchAccount: true, errorType: "ModelError" }
    }
    if (status === 429) {
      return { shouldSwitchAccount: true, quotaKind: "PROVIDER_RATE_LIMIT", retryAfterSeconds: retryAfterSeconds(headers.get("retry-after")), errorType: "RateLimit", retrySameAccount: { maxRetries: 3 } }
    }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    if (account.adminState !== "ENABLED") return false
    const data = this.readCredentialData(account)
    if (data) return Boolean(data.runtimeKey)
    return account.authState === "VALID"
  }
}
