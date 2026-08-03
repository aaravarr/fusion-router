import { randomUUID } from "node:crypto"
import { slugifyProviderName } from "./slug"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import type { PoolType } from "./types"

export type CustomProviderInterface = "chat" | "responses"

export interface BalanceRequestConfig {
  url: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: unknown
}

export interface CustomProviderBalanceConfig {
  request: BalanceRequestConfig
  extractor: string
}

export interface CustomProviderRecord {
  id: string
  ownerUserId: string
  poolType: PoolType
  name: string
  slug: string
  description: string
  baseUrl: string
  interfaceType: CustomProviderInterface
  models: string[] | null
  balanceConfig: CustomProviderBalanceConfig | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

type ProviderRow = {
  id: string; owner_user_id: string; name: string; slug: string; description: string; base_url: string
  interface_type: CustomProviderInterface; models_json: string | null; balance_config_json: string | null
  enabled: number; created_at: string; updated_at: string
}

const nowIso = () => new Date().toISOString()
export const customPoolType = (id: string): PoolType => `custom:${id}`
export const customProviderId = (poolType: string): string | null => poolType.startsWith("custom:") ? poolType.slice(7) || null : null

const customProviderCacheGlobal = globalThis as typeof globalThis & { __customProviderConfigCache?: Map<string, { expiresAt: number; value: CustomProviderRecord | null }> }
const CUSTOM_PROVIDER_CACHE_MS = 5_000
export function invalidateCustomProviderCache(id?: string): void {
  const cache = customProviderCacheGlobal.__customProviderConfigCache
  if (id) cache?.delete(id); else cache?.clear()
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  try { return JSON.parse(value) as T } catch { return null }
}

function fromRow(row: ProviderRow): CustomProviderRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    poolType: customPoolType(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    baseUrl: row.base_url,
    interfaceType: row.interface_type,
    models: parseJson<string[]>(row.models_json),
    balanceConfig: parseJson<CustomProviderBalanceConfig>(row.balance_config_json),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl 仅支持 HTTP/HTTPS")
  if (url.username || url.password) throw new Error("baseUrl 不能包含用户名或密码")
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

function normalizeModels(models: string[] | null | undefined): string[] | null {
  if (!models?.length) return null
  const values = [...new Set(models.map((model) => model.trim()).filter(Boolean))]
  return values.length ? values : null
}

export class CustomProviderRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }

  list(): CustomProviderRecord[] {
    return (this.db.prepare("SELECT * FROM custom_providers WHERE owner_user_id=? ORDER BY created_at").all(this.ownerUserId) as ProviderRow[]).map(fromRow)
  }

  get(id: string): CustomProviderRecord | null {
    const row = this.db.prepare("SELECT * FROM custom_providers WHERE id=? AND owner_user_id=?").get(id, this.ownerUserId) as ProviderRow | undefined
    return row ? fromRow(row) : null
  }

  create(input: { name: string; description?: string; baseUrl: string; interfaceType: CustomProviderInterface; models?: string[] | null; balanceConfig?: CustomProviderBalanceConfig | null; enabled?: boolean }): CustomProviderRecord {
    const id = randomUUID()
    const timestamp = nowIso()
    const name = input.name.trim()
    const slug = this.uniqueSlug(name)
    this.db.prepare(`INSERT INTO custom_providers(id,owner_user_id,name,slug,description,base_url,interface_type,models_json,balance_config_json,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, this.ownerUserId, name, slug, input.description?.trim() ?? "", normalizeBaseUrl(input.baseUrl), input.interfaceType,
      JSON.stringify(normalizeModels(input.models)), input.balanceConfig ? JSON.stringify(input.balanceConfig) : null,
      Number(input.enabled ?? true), timestamp, timestamp,
    )
    invalidateCustomProviderCache(id)
    return this.get(id)!
  }

  /** Resolve a unique slug for a provider name under this owner, throwing on conflict. */
  private uniqueSlug(name: string, excludeId?: string): string {
    const slug = slugifyProviderName(name)
    const conflict = this.db.prepare("SELECT 1 FROM custom_providers WHERE owner_user_id=? AND slug=? AND (? IS NULL OR id<>?)")
      .get(this.ownerUserId, slug, excludeId ?? null, excludeId ?? null)
    if (conflict) {
      throw new Error(`slug_conflict: 名称 "${name}" 生成的唯一键 "${slug}" 已被其他 Provider 使用，请更换名称`)
    }
    return slug
  }

  update(id: string, input: Partial<{ name: string; description: string; baseUrl: string; interfaceType: CustomProviderInterface; models: string[] | null; balanceConfig: CustomProviderBalanceConfig | null; enabled: boolean }>): CustomProviderRecord | null {
    const entries: Array<[string, unknown]> = []
    if (input.name !== undefined) {
      const name = input.name.trim()
      entries.push(["name", name])
      entries.push(["slug", this.uniqueSlug(name, id)])
    }
    if (input.description !== undefined) entries.push(["description", input.description.trim()])
    if (input.baseUrl !== undefined) entries.push(["base_url", normalizeBaseUrl(input.baseUrl)])
    if (input.interfaceType !== undefined) entries.push(["interface_type", input.interfaceType])
    if (input.models !== undefined) entries.push(["models_json", JSON.stringify(normalizeModels(input.models))])
    if (input.balanceConfig !== undefined) entries.push(["balance_config_json", input.balanceConfig ? JSON.stringify(input.balanceConfig) : null])
    if (input.enabled !== undefined) entries.push(["enabled", Number(input.enabled)])
    if (entries.length) {
      this.db.prepare(`UPDATE custom_providers SET ${entries.map(([name]) => `${name}=?`).join(",")},updated_at=? WHERE id=? AND owner_user_id=?`)
        .run(...entries.map(([, value]) => value), nowIso(), id, this.ownerUserId)
      invalidateCustomProviderCache(id)
      if (input.models !== undefined || input.baseUrl !== undefined) {
        this.db.prepare("DELETE FROM provider_model_cache WHERE pool_type=?").run(customPoolType(id))
      }
    }
    return this.get(id)
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false
    return this.db.transaction(() => {
      const poolType = customPoolType(id)
      this.db.prepare("DELETE FROM accounts WHERE owner_user_id=? AND pool_type=?").run(this.ownerUserId, poolType)
      this.db.prepare("DELETE FROM provider_model_cache WHERE pool_type=?").run(poolType)
      const deleted = this.db.prepare("DELETE FROM custom_providers WHERE id=? AND owner_user_id=?").run(id, this.ownerUserId).changes === 1
      invalidateCustomProviderCache(id)
      return deleted
    }).immediate()
  }
}

export function getCustomProviderByPoolType(poolType: string, db: AppDatabase = getDatabase()): CustomProviderRecord | null {
  const id = customProviderId(poolType)
  if (!id) return null
  const cache = (customProviderCacheGlobal.__customProviderConfigCache ??= new Map())
  const cached = cache.get(id)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const row = db.prepare("SELECT * FROM custom_providers WHERE id=?").get(id) as ProviderRow | undefined
  const value = row ? fromRow(row) : null
  cache.set(id, { expiresAt: Date.now() + CUSTOM_PROVIDER_CACHE_MS, value })
  return value
}
