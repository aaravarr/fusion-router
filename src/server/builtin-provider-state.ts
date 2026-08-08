import type { AppDatabase } from "@/server/db"
import { getDatabase } from "@/server/db"

/**
 * 内置 Provider（POOL_TYPES）的启用/禁用状态。
 *
 * 存储在 system_settings（key: builtin_provider_states，is_secret=0），
 * value_json 形如 { "<poolType>": { "enabled": boolean, "updatedAt": "<ISO>" } }。
 * 无记录或某 poolType 缺项 = 默认启用。禁用只是退出路由调度与账号池展示，
 * 账号数据保留，可随时重新启用恢复。
 *
 * 自定义 Provider（custom:*）有自己的 custom_providers.enabled 字段，这里一律视为启用。
 */

export const BUILTIN_PROVIDER_STATES_KEY = "builtin_provider_states"

export interface BuiltinProviderState {
  enabled: boolean
  updatedAt?: string
}

interface StateRow {
  value_json: string
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 读取全部内置 provider 状态；记录缺失或 JSON 损坏时返回 {}（即全部默认启用）。 */
export function getBuiltinProviderStates(db: AppDatabase = getDatabase()): Record<string, BuiltinProviderState> {
  const row = db
    .prepare("SELECT value_json FROM system_settings WHERE key = ? AND is_secret = 0")
    .get(BUILTIN_PROVIDER_STATES_KEY) as StateRow | undefined
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.value_json) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, BuiltinProviderState> = {}
    for (const [poolType, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      if (typeof record.enabled !== "boolean") continue
      out[poolType] = {
        enabled: record.enabled,
        ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
      }
    }
    return out
  } catch {
    // 损坏的记录忽略，按全部默认启用处理
    return {}
  }
}

/** 内置 provider 是否启用。custom:* 一律返回 true；内置类型缺项默认 true。 */
export function isBuiltinProviderEnabled(poolType: string, db: AppDatabase = getDatabase()): boolean {
  if (poolType.startsWith("custom:")) return true
  return getBuiltinProviderStates(db)[poolType]?.enabled !== false
}

export function setBuiltinProviderEnabled(poolType: string, enabled: boolean, db: AppDatabase = getDatabase()): void {
  const states = getBuiltinProviderStates(db)
  states[poolType] = { enabled, updatedAt: nowIso() }
  db.prepare(
    `INSERT INTO system_settings(key, value_json, is_secret, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(BUILTIN_PROVIDER_STATES_KEY, JSON.stringify(states), nowIso())
}
