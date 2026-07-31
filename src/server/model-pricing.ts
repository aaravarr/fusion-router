/**
 * OpenRouter model pricing cache.
 *
 * Pricing is fetched from https://openrouter.ai/api/v1/models once at startup
 * (and on demand via admin refresh); https://models.dev/api.json is used as a
 * fallback for models OpenRouter does not cover. Values are USD per token
 * (prompt / completion / optional input_cache_read).
 */

import { apiFetch } from "./api-fetch"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_ID = "openrouter"
const REQUEST_TIMEOUT_MS = 30_000

interface AuthoritativePrice {
  id: string
  name: string
  prompt: number
  completion: number
  cacheRead: number | null
}

interface AuthoritativeIndex {
  exact: Map<string, AuthoritativePrice>
  short: Map<string, AuthoritativePrice>
}

// Official provider prices (USD per 1M tokens) from models.dev. OpenRouter is
// the primary source; models.dev only fills models OpenRouter lacks.
function parseModelsDevAuthoritative(payload: unknown): AuthoritativeIndex {
  const exact = new Map<string, AuthoritativePrice>()
  const short = new Map<string, AuthoritativePrice>()
  const shortKeyConflict = new Set<string>()
  const shortKeyOwner = new Map<string, string>()
  if (!payload || typeof payload !== "object") return { exact, short }
  for (const [providerId, provider] of Object.entries(payload as Record<string, unknown>)) {
    if (providerId === "openrouter") continue
    if (!provider || typeof provider !== "object") continue
    const models = (provider as { models?: unknown }).models
    if (!models || typeof models !== "object") continue
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") continue
      const cost = (model as { cost?: unknown }).cost
      if (!cost || typeof cost !== "object") continue
      const costRec = cost as Record<string, unknown>
      const prompt = toNumber(costRec.input)
      const completion = toNumber(costRec.output)
      if (prompt == null && completion == null) continue
      const cacheRead = toNumber(costRec.cache_read)
      const price: AuthoritativePrice = {
        id: `${providerId}/${modelId}`,
        name: typeof (model as { name?: unknown }).name === "string" ? String((model as { name: string }).name) : modelId,
        prompt: (prompt ?? 0) / 1_000_000,
        completion: (completion ?? 0) / 1_000_000,
        cacheRead: cacheRead == null ? null : cacheRead / 1_000_000,
      }
      const exactKey = normalizeKey(`${providerId}/${modelId}`)
      exact.set(exactKey, price)
      const shortKey = normalizeKey(modelId)
      const owner = shortKeyOwner.get(shortKey)
      if (owner === undefined) {
        shortKeyOwner.set(shortKey, providerId)
        short.set(shortKey, price)
      } else if (owner !== providerId) {
        shortKeyConflict.add(shortKey)
        short.delete(shortKey)
      }
    }
  }
  for (const key of shortKeyConflict) short.delete(key)
  return { exact, short }
}

// Keep OpenRouter entries as the primary catalog; append models.dev entries
// only for models OpenRouter does not cover (by id or by base short id).
function mergeModelPricing(openRouterModels: ModelPrice[], authoritative: AuthoritativeIndex): ModelPrice[] {
  const result = [...openRouterModels]
  const seenIds = new Set(result.map((model) => normalizeKey(model.id)))
  const seenBaseIds = new Set(result.map((model) => normalizeKey(baseId(model.id))))
  for (const price of authoritative.exact.values()) {
    const idKey = normalizeKey(price.id)
    const baseKey = normalizeKey(baseId(price.id))
    if (seenIds.has(idKey) || seenBaseIds.has(baseKey)) continue
    seenIds.add(idKey)
    seenBaseIds.add(baseKey)
    result.push({
      id: price.id,
      name: price.name,
      prompt: price.prompt,
      completion: price.completion,
      cacheRead: price.cacheRead,
    })
  }
  return result
}

export interface ModelPrice {
  id: string
  name: string
  /** USD per input token */
  prompt: number
  /** USD per output token */
  completion: number
  /** USD per cached input token when provided */
  cacheRead: number | null
  /** OpenRouter model catalog creation time in unix seconds (when available) */
  created?: number
}

export interface ModelPricingStatus {
  source: "openrouter"
  modelCount: number
  fetchedAt: string | null
  updatedAt: string | null
  error: string | null
  stale: boolean
}

export interface UsageCostInput {
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  cachedTokens?: number | null
}

export interface UsageCostResult {
  costUsd: number | null
  matchedModelId: string | null
  pricing: ModelPrice | null
  breakdown: UsageCostBreakdown | null
}

export interface UsageCostBreakdown {
  uncachedPromptTokens: number
  cachedTokens: number
  completionTokens: number
  promptRate: number
  cacheRate: number
  completionRate: number
}

type PriceIndex = {
  byExact: Map<string, ModelPrice>
  byShort: Map<string, ModelPrice>
  list: ModelPrice[]
  fetchedAt: string | null
  updatedAt: string | null
  error: string | null
}

const globalPricing = globalThis as typeof globalThis & {
  __opencodeModelPricing?: PriceIndex
}

function emptyIndex(): PriceIndex {
  return {
    byExact: new Map(),
    byShort: new Map(),
    list: [],
    fetchedAt: null,
    updatedAt: null,
    error: null,
  }
}

function ensureTable(db: AppDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS model_pricing_cache (
    id TEXT PRIMARY KEY,
    models_json TEXT NOT NULL,
    fetched_at TEXT,
    updated_at TEXT NOT NULL,
    error TEXT
  )`)
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-")
}

function shortId(id: string): string {
  const cleaned = id.replace(/:free$/i, "").replace(/^~/, "")
  const slash = cleaned.lastIndexOf("/")
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned
}

// Strip trailing version/date suffixes so all variants of a model share one
// base short id (e.g. deepseek-v4-flash-0731 -> deepseek-v4-flash).
function baseId(id: string): string {
  return shortId(id)
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
}

function indexPrices(models: ModelPrice[], meta: { fetchedAt: string | null; updatedAt: string | null; error: string | null }): PriceIndex {
  const byExact = new Map<string, ModelPrice>()
  const byShort = new Map<string, ModelPrice>()
  for (const model of models) {
    byExact.set(normalizeKey(model.id), model)
    const base = normalizeKey(baseId(model.id))
    // Ignore version/date suffixes and prefer the newest variant.
    const existing = byShort.get(base)
    const created = model.created ?? 0
    const existingCreated = existing?.created ?? 0
    if (!existing || created > existingCreated || (created === existingCreated && existing.prompt === 0 && existing.completion === 0 && (model.prompt > 0 || model.completion > 0))) {
      byShort.set(base, model)
    }
    // Also index name-like keys when unique-ish.
    const nameKey = normalizeKey(model.name)
    if (nameKey && !byExact.has(nameKey)) byExact.set(nameKey, model)
  }
  return {
    byExact,
    byShort,
    list: models,
    fetchedAt: meta.fetchedAt,
    updatedAt: meta.updatedAt,
    error: meta.error,
  }
}

function parseOpenRouterModels(payload: unknown): ModelPrice[] {
  if (!payload || typeof payload !== "object") return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const out: ModelPrice[] = []
  for (const row of data) {
    if (!row || typeof row !== "object") continue
    const rec = row as Record<string, unknown>
    const id = typeof rec.id === "string" ? rec.id.trim() : ""
    if (!id) continue
    const pricing = rec.pricing && typeof rec.pricing === "object" ? (rec.pricing as Record<string, unknown>) : {}
    const prompt = toNumber(pricing.prompt) ?? 0
    const completion = toNumber(pricing.completion) ?? 0
    const cacheRead = toNumber(pricing.input_cache_read)
    const created = toNumber(rec.created)
    out.push({
      id,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id,
      prompt,
      completion,
      cacheRead,
      ...(created == null ? {} : { created }),
    })
  }
  return out
}

function loadFromDb(db: AppDatabase): PriceIndex {
  ensureTable(db)
  const row = db.prepare("SELECT models_json,fetched_at,updated_at,error FROM model_pricing_cache WHERE id=?").get(CACHE_ID) as
    | { models_json: string; fetched_at: string | null; updated_at: string; error: string | null }
    | undefined
  if (!row?.models_json) return emptyIndex()
  try {
    const parsed = JSON.parse(row.models_json) as unknown
    const models = Array.isArray(parsed) ? (parsed as ModelPrice[]) : []
    return indexPrices(models.filter((m) => m && typeof m.id === "string"), {
      fetchedAt: row.fetched_at,
      updatedAt: row.updated_at,
      error: row.error,
    })
  } catch {
    return emptyIndex()
  }
}

function saveToDb(db: AppDatabase, models: ModelPrice[], error: string | null): PriceIndex {
  ensureTable(db)
  const now = new Date().toISOString()
  const fetchedAt = error ? null : now
  db.prepare(`INSERT INTO model_pricing_cache(id,models_json,fetched_at,updated_at,error)
    VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      models_json=excluded.models_json,
      fetched_at=COALESCE(excluded.fetched_at, model_pricing_cache.fetched_at),
      updated_at=excluded.updated_at,
      error=excluded.error`).run(CACHE_ID, JSON.stringify(models), fetchedAt, now, error)
  const index = indexPrices(models, { fetchedAt: fetchedAt ?? loadFromDb(db).fetchedAt, updatedAt: now, error })
  globalPricing.__opencodeModelPricing = index
  return index
}

export function getModelPricingIndex(db: AppDatabase = getDatabase()): PriceIndex {
  if (globalPricing.__opencodeModelPricing && globalPricing.__opencodeModelPricing.list.length > 0) {
    return globalPricing.__opencodeModelPricing
  }
  const loaded = loadFromDb(db)
  globalPricing.__opencodeModelPricing = loaded
  return loaded
}

export function getModelPricingStatus(db: AppDatabase = getDatabase()): ModelPricingStatus {
  const index = getModelPricingIndex(db)
  return {
    source: "openrouter",
    modelCount: index.list.length,
    fetchedAt: index.fetchedAt,
    updatedAt: index.updatedAt,
    error: index.error,
    stale: index.list.length === 0,
  }
}

function candidateKeys(model: string): string[] {
  const raw = model.trim()
  if (!raw) return []
  const key = normalizeKey(raw)
  const short = normalizeKey(shortId(raw))
  const keys = new Set<string>([key, short])
  // k3-256k → k3, kimi-k3
  if (/^k3(-|$)/.test(short)) {
    keys.add("k3")
    keys.add("kimi-k3")
  }
  // claude-sonnet-4-5 → claude-sonnet-4.5
  keys.add(short.replace(/-(\d)-(\d)$/, "-$1.$2"))
  keys.add(short.replace(/\.(\d)/g, "-$1"))
  return [...keys]
}

export function findModelPrice(model: string | null | undefined, db: AppDatabase = getDatabase()): ModelPrice | null {
  if (!model?.trim()) return null
  const index = getModelPricingIndex(db)
  if (!index.list.length) return null
  for (const key of candidateKeys(model)) {
    const exact = index.byExact.get(key)
    if (exact) {
      // Even an exact id match should prefer the newest variant of the same
      // base model (e.g. deepseek/deepseek-v4-flash -> -0731).
      const latest = index.byShort.get(normalizeKey(baseId(key)))
      if (latest && latest.id !== exact.id && (latest.created ?? 0) > (exact.created ?? 0)) return latest
      return exact
    }
    const short = index.byShort.get(key)
    if (short) return short
  }
  // suffix / contains best effort for close ids
  const needle = normalizeKey(shortId(model))
  let best: ModelPrice | null = null
  let bestScore = 0
  for (const price of index.list) {
    const short = normalizeKey(shortId(price.id))
    if (short === needle) return price
    if (short.endsWith(needle) || needle.endsWith(short)) {
      const score = Math.min(short.length, needle.length)
      if (score > bestScore) {
        best = price
        bestScore = score
      }
    }
  }
  // Require reasonably long match to avoid false positives like "o3" vs random
  return bestScore >= 5 ? best : null
}

export function estimateUsageCost(input: UsageCostInput, db: AppDatabase = getDatabase()): UsageCostResult {
  const pricing = findModelPrice(input.model, db)
  if (!pricing) return { costUsd: null, matchedModelId: null, pricing: null, breakdown: null }
  const promptTokens = Math.max(0, Number(input.promptTokens ?? 0) || 0)
  const completionTokens = Math.max(0, Number(input.completionTokens ?? 0) || 0)
  const cachedTokens = Math.max(0, Math.min(promptTokens, Number(input.cachedTokens ?? 0) || 0))
  const uncachedPrompt = Math.max(0, promptTokens - cachedTokens)
  const cacheRate = pricing.cacheRead != null && pricing.cacheRead >= 0 ? pricing.cacheRead : pricing.prompt
  const breakdown = {
    uncachedPromptTokens: uncachedPrompt,
    cachedTokens,
    completionTokens,
    promptRate: pricing.prompt,
    cacheRate,
    completionRate: pricing.completion,
  }
  const costUsd = uncachedPrompt * pricing.prompt + cachedTokens * cacheRate + completionTokens * pricing.completion
  if (!Number.isFinite(costUsd)) return { costUsd: null, matchedModelId: pricing.id, pricing, breakdown: null }
  return { costUsd, matchedModelId: pricing.id, pricing, breakdown }
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  const abs = Math.abs(value)
  if (abs < 0.0001) return `$${value.toExponential(2)}`
  if (abs < 0.01) return `$${value.toFixed(4)}`
  if (abs < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export async function refreshModelPricing(db: AppDatabase = getDatabase()): Promise<ModelPricingStatus> {
  ensureTable(db)
  try {
    const [openRouterResult, modelsDevResult] = await Promise.allSettled([
      apiFetch(OPENROUTER_MODELS_URL, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then(async (response) => {
        const body = await response.text()
        if (!response.ok) throw new Error(`OpenRouter /models failed (HTTP ${response.status}): ${body.slice(0, 200)}`)
        const models = parseOpenRouterModels(JSON.parse(body) as unknown)
        if (!models.length) throw new Error("OpenRouter /models returned empty catalog")
        return models
      }),
      apiFetch(MODELS_DEV_URL, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then(async (response) => {
        const body = await response.text()
        if (!response.ok) throw new Error(`models.dev failed (HTTP ${response.status})`)
        return parseModelsDevAuthoritative(JSON.parse(body) as unknown)
      }),
    ])
    const emptyAuthoritative: AuthoritativeIndex = { exact: new Map(), short: new Map() }
    const authoritative = modelsDevResult.status === "fulfilled" ? modelsDevResult.value : emptyAuthoritative
    if (openRouterResult.status === "rejected" && authoritative.exact.size === 0) throw openRouterResult.reason
    const openRouterModels = openRouterResult.status === "fulfilled" ? openRouterResult.value : []
    const merged = mergeModelPricing(openRouterModels, authoritative)
    if (!merged.length) throw new Error("No model pricing available")
    saveToDb(db, merged, null)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const existing = loadFromDb(db)
    // Keep previous catalog if present; still record error.
    if (existing.list.length) {
      const now = new Date().toISOString()
      db.prepare("UPDATE model_pricing_cache SET error=?, updated_at=? WHERE id=?").run(message, now, CACHE_ID)
      globalPricing.__opencodeModelPricing = { ...existing, error: message, updatedAt: now }
    } else {
      saveToDb(db, [], message)
    }
  }
  return getModelPricingStatus(db)
}

/** Startup / best-effort warm: use DB cache if fresh-ish, otherwise fetch. */
export async function ensureModelPricingLoaded(db: AppDatabase = getDatabase()): Promise<void> {
  ensureTable(db)
  const current = loadFromDb(db)
  globalPricing.__opencodeModelPricing = current
  if (current.list.length > 0) return
  await refreshModelPricing(db)
}

export function __resetModelPricingCacheForTests(): void {
  globalPricing.__opencodeModelPricing = undefined
}
