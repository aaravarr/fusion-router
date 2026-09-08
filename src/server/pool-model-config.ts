// 号池模型级配置（pool_model_config）。
//
// 结构上按 (owner_user_id, pool_type, model) 通用存储，当前仅 openai 池接入：
// fast 开关 → 转发 Codex 时按请求模型注入 service_tier:"priority"。
// 注意与 model_routing 区分：model_routing 只决定「选哪个池」，不触碰请求 body。
//
// 读取路径在推理热路径上（buildForwardTarget → normalizeCodexResponsesBody），
// 沿用镜像组 10s TTL 内存缓存模式（api-fetch.ts CACHE_TTL_MS），禁止每请求打库；
// 写接口成功后主动失效，配置变更即时生效。

import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"

export const POOL_MODEL_CONFIG_TTL_MS = 10_000

export interface PoolModelConfigRecord {
  id: string
  ownerUserId: string
  poolType: string
  model: string
  fastEnabled: boolean
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  owner_user_id: string
  pool_type: string
  model: string
  fast_enabled: number
  created_at: string
  updated_at: string
}

function rowToRecord(row: Row): PoolModelConfigRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    poolType: String(row.pool_type),
    model: String(row.model),
    fastEnabled: Boolean(row.fast_enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

const cachedFastByOwner = new Map<string, { models: Set<string>; expiry: number }>()

function readFastModels(ownerUserId: string): Set<string> {
  const now = Date.now()
  const cached = cachedFastByOwner.get(ownerUserId)
  if (cached && now < cached.expiry) return cached.models
  let models = new Set<string>()
  try {
    const rows = getDatabase().prepare(
      "SELECT model FROM pool_model_config WHERE owner_user_id = ? AND pool_type = 'openai' AND fast_enabled = 1",
    ).all(ownerUserId) as { model: string }[]
    models = new Set(rows.map((row) => String(row.model)))
  } catch { models = new Set() }
  cachedFastByOwner.set(ownerUserId, { models, expiry: now + POOL_MODEL_CONFIG_TTL_MS })
  return models
}

/**
 * openai 池该模型是否开启了 fast（TTL 缓存内直读内存）。
 * 未知池 / 无配置 → false。
 */
export function isPoolModelFastEnabled(ownerUserId: string, model: string): boolean {
  if (!ownerUserId || !model) return false
  return readFastModels(ownerUserId).has(model)
}

/** 写成功后调用（含删除），立即生效。 */
export function invalidatePoolModelConfigCache(ownerUserId?: string): void {
  if (ownerUserId) cachedFastByOwner.delete(ownerUserId)
  else cachedFastByOwner.clear()
}

export class PoolModelConfigRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }

  list(poolType?: string): PoolModelConfigRecord[] {
    const rows = poolType
      ? (this.db.prepare("SELECT * FROM pool_model_config WHERE owner_user_id = ? AND pool_type = ? ORDER BY pool_type, model").all(this.ownerUserId, poolType) as Row[])
      : (this.db.prepare("SELECT * FROM pool_model_config WHERE owner_user_id = ? ORDER BY pool_type, model").all(this.ownerUserId) as Row[])
    return rows.map(rowToRecord)
  }

  get(poolType: string, model: string): PoolModelConfigRecord | null {
    const row = this.db.prepare("SELECT * FROM pool_model_config WHERE owner_user_id = ? AND pool_type = ? AND model = ?")
      .get(this.ownerUserId, poolType, model) as Row | undefined
    return row ? rowToRecord(row) : null
  }

  /** UPSERT（唯一键 owner+pool_type+model）；返回写后的记录。 */
  set(poolType: string, model: string, fastEnabled: boolean): PoolModelConfigRecord {
    const existing = this.get(poolType, model)
    const ts = new Date().toISOString()
    if (existing) {
      this.db.prepare("UPDATE pool_model_config SET fast_enabled = ?, updated_at = ? WHERE id = ?")
        .run(fastEnabled ? 1 : 0, ts, existing.id)
      return { ...existing, fastEnabled, updatedAt: ts }
    }
    const id = randomUUID()
    this.db.prepare("INSERT INTO pool_model_config(id, owner_user_id, pool_type, model, fast_enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, this.ownerUserId, poolType, model, fastEnabled ? 1 : 0, ts, ts)
    return { id, ownerUserId: this.ownerUserId, poolType, model, fastEnabled, createdAt: ts, updatedAt: ts }
  }
}
