import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { AccountRepository } from "./repository"
import { ensureProvidersRegistered, getProviderRegistry, tryGetProvider, type PoolType } from "./providers"
import { customPoolType } from "./custom-providers"

export type ProviderModelSource = "DEFAULT" | "REMOTE" | "MERGED"

export interface ProviderModelCatalog {
  poolType: PoolType
  label: string
  models: string[]
  source: ProviderModelSource
  accountId: string | null
  error: string | null
  fetchedAt: string | null
  updatedAt: string | null
  defaultModels: string[]
  remoteModels: string[] | null
}

const nowIso = () => new Date().toISOString()

function uniqueSorted(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function readCacheRow(db: AppDatabase, poolType: PoolType): {
  models_json: string
  source: string
  account_id: string | null
  error: string | null
  fetched_at: string | null
  updated_at: string
} | undefined {
  return db.prepare("SELECT models_json,source,account_id,error,fetched_at,updated_at FROM provider_model_cache WHERE pool_type=?")
    .get(poolType) as {
    models_json: string
    source: string
    account_id: string | null
    error: string | null
    fetched_at: string | null
    updated_at: string
  } | undefined
}

export function getDefaultModels(poolType: PoolType): string[] {
  ensureProvidersRegistered()
  const provider = tryGetProvider(poolType)
  if (!provider) return []
  const anyProvider = provider as { getDefaultModels?: () => string[] }
  if (typeof anyProvider.getDefaultModels === "function") return uniqueSorted(anyProvider.getDefaultModels())
  // Never fall back to getAvailableModels(): that method may already include cache.
  return []
}

export function readProviderModelCache(poolType: PoolType, db: AppDatabase = getDatabase()): string[] | null {
  const row = readCacheRow(db, poolType)
  if (!row?.models_json) return null
  try {
    const parsed = JSON.parse(row.models_json) as unknown
    if (!Array.isArray(parsed)) return null
    const models = uniqueSorted(parsed.filter((item): item is string => typeof item === "string"))
    return models.length ? models : null
  } catch {
    return null
  }
}

export function writeProviderModelCache(
  poolType: PoolType,
  models: string[],
  input: { source?: ProviderModelSource; accountId?: string | null; error?: string | null; fetchedAt?: string | null } = {},
  db: AppDatabase = getDatabase(),
): ProviderModelCatalog {
  const timestamp = nowIso()
  const normalized = uniqueSorted(models)
  db.prepare(`INSERT INTO provider_model_cache(pool_type,models_json,source,account_id,error,fetched_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(pool_type) DO UPDATE SET
      models_json=excluded.models_json,
      source=excluded.source,
      account_id=excluded.account_id,
      error=excluded.error,
      fetched_at=excluded.fetched_at,
      updated_at=excluded.updated_at`)
    .run(
      poolType,
      JSON.stringify(normalized),
      input.source ?? "REMOTE",
      input.accountId ?? null,
      input.error ?? null,
      input.fetchedAt ?? timestamp,
      timestamp,
    )
  return getProviderModelCatalog(poolType, db)
}

export function getProviderModelCatalog(poolType: PoolType, db: AppDatabase = getDatabase()): ProviderModelCatalog {
  ensureProvidersRegistered()
  const provider = tryGetProvider(poolType)
  const label = provider?.displayName ?? poolType
  const defaultModels = getDefaultModels(poolType)
  const row = readCacheRow(db, poolType)
  let cachedModels: string[] | null = null
  if (row?.models_json) {
    try {
      const parsed = JSON.parse(row.models_json) as unknown
      if (Array.isArray(parsed)) {
        const models = uniqueSorted(parsed.filter((item): item is string => typeof item === "string"))
        cachedModels = models.length ? models : null
      }
    } catch {
      cachedModels = null
    }
  }
  const models = uniqueSorted([...(cachedModels ?? []), ...defaultModels])
  const source = (row?.source as ProviderModelSource | undefined)
    ?? (cachedModels?.length ? "REMOTE" : "DEFAULT")
  return {
    poolType,
    label,
    models,
    source: cachedModels?.length && defaultModels.length && source !== "DEFAULT" ? "MERGED" : (cachedModels?.length ? source : "DEFAULT"),
    accountId: row?.account_id ?? null,
    error: row?.error ?? null,
    fetchedAt: row?.fetched_at ?? null,
    updatedAt: row?.updated_at ?? null,
    defaultModels,
    remoteModels: cachedModels,
  }
}

export function listProviderModelCatalogs(db: AppDatabase = getDatabase(), ownerUserId?: string | null): ProviderModelCatalog[] {
  ensureProvidersRegistered()
  const customRows = ownerUserId
    ? db.prepare("SELECT id FROM custom_providers WHERE enabled=1 AND owner_user_id=? ORDER BY created_at").all(ownerUserId)
    : db.prepare("SELECT id FROM custom_providers WHERE enabled=1 ORDER BY created_at").all()
  const custom = (customRows as { id: string }[]).map((row) => customPoolType(row.id))
  return [...getProviderRegistry().registeredPoolTypes(), ...custom].map((poolType) => getProviderModelCatalog(poolType, db))
}

function pickReadyAccount(ownerUserId: string | null, poolType: PoolType, preferredAccountId: string | null, db: AppDatabase) {
  const provider = tryGetProvider(poolType)
  if (ownerUserId) {
    const accounts = new AccountRepository(ownerUserId, db).listByPoolType(poolType)
    const ready = accounts.filter((account) => provider ? provider.isAccountReady(account) : account.adminState === "ENABLED" && account.authState === "VALID")
    if (preferredAccountId) {
      const preferred = ready.find((account) => account.id === preferredAccountId)
      if (preferred) return preferred
    }
    return ready[0] ?? null
  }

  // Startup / background path: pick any ready account across tenants.
  if (preferredAccountId) {
    const row = db.prepare("SELECT owner_user_id FROM accounts WHERE id=?").get(preferredAccountId) as { owner_user_id: string } | undefined
    if (row) {
      const account = new AccountRepository(row.owner_user_id, db).get(preferredAccountId)
      if (account && (!provider || provider.isAccountReady(account))) return account
    }
  }
  const candidates = db.prepare(`SELECT id, owner_user_id FROM accounts
    WHERE pool_type=? AND admin_state='ENABLED' AND auth_state='VALID'
    ORDER BY COALESCE(last_success_at, '') DESC, updated_at DESC LIMIT 20`).all(poolType) as { id: string; owner_user_id: string }[]
  for (const candidate of candidates) {
    const account = new AccountRepository(candidate.owner_user_id, db).get(candidate.id)
    if (account && (!provider || provider.isAccountReady(account))) return account
  }
  return null
}

export async function syncProviderModels(options: {
  poolType: PoolType
  ownerUserId?: string | null
  accountId?: string | null
  db?: AppDatabase
}): Promise<ProviderModelCatalog> {
  const db = options.db ?? getDatabase()
  ensureProvidersRegistered()
  const provider = tryGetProvider(options.poolType)
  if (!provider) throw new Error(`未知号池类型: ${options.poolType}`)
  const defaultModels = getDefaultModels(options.poolType)

  if (typeof provider.fetchRemoteModels !== "function") {
    return writeProviderModelCache(options.poolType, defaultModels, {
      source: "DEFAULT",
      accountId: null,
      error: "该 Provider 不支持远程模型目录拉取，已保留默认列表",
      fetchedAt: null,
    }, db)
  }

  const account = pickReadyAccount(options.ownerUserId ?? null, options.poolType, options.accountId ?? null, db)
  if (!account) {
    return writeProviderModelCache(options.poolType, defaultModels, {
      source: "DEFAULT",
      accountId: null,
      error: "没有可用账号，无法拉取远程模型目录",
      fetchedAt: null,
    }, db)
  }

  try {
    const remote = await provider.fetchRemoteModels(account)
    if (!remote || remote.length === 0) {
      return writeProviderModelCache(options.poolType, defaultModels, {
        source: "DEFAULT",
        accountId: account.id,
        error: "上游未返回模型列表，已保留默认列表",
        fetchedAt: nowIso(),
      }, db)
    }
    const merged = uniqueSorted([...defaultModels, ...remote])
    return writeProviderModelCache(options.poolType, merged, {
      source: "REMOTE",
      accountId: account.id,
      error: null,
      fetchedAt: nowIso(),
    }, db)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "拉取模型列表失败"
    const existing = readProviderModelCache(options.poolType, db) ?? defaultModels
    return writeProviderModelCache(options.poolType, existing, {
      source: existing === defaultModels ? "DEFAULT" : "REMOTE",
      accountId: account.id,
      error: message,
      fetchedAt: nowIso(),
    }, db)
  }
}

export async function syncAllProviderModels(options: {
  ownerUserId?: string | null
  db?: AppDatabase
} = {}): Promise<ProviderModelCatalog[]> {
  const db = options.db ?? getDatabase()
  ensureProvidersRegistered()
  const results: ProviderModelCatalog[] = []
  const custom = (db.prepare("SELECT id FROM custom_providers WHERE enabled=1 ORDER BY created_at").all() as { id: string }[]).map((row) => customPoolType(row.id))
  for (const poolType of [...getProviderRegistry().registeredPoolTypes(), ...custom]) {
    try {
      results.push(await syncProviderModels({ poolType, ownerUserId: options.ownerUserId ?? null, db }))
    } catch (cause) {
      const defaults = getDefaultModels(poolType)
      results.push(writeProviderModelCache(poolType, defaults, {
        source: "DEFAULT",
        error: cause instanceof Error ? cause.message : "同步失败",
        fetchedAt: null,
      }, db))
    }
  }
  return results
}

export async function syncProviderModelsForAccount(ownerUserId: string, accountId: string, db: AppDatabase = getDatabase()): Promise<ProviderModelCatalog | null> {
  const account = new AccountRepository(ownerUserId, db).get(accountId)
  if (!account) return null
  return syncProviderModels({ poolType: account.poolType, ownerUserId, accountId, db })
}
