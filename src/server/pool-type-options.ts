import { CustomProviderRepository } from "@/server/custom-providers"
import type { AppDatabase } from "@/server/db"
import { getDatabase } from "@/server/db"
import { isBuiltinProviderEnabled } from "@/server/builtin-provider-state"
import { POOL_TYPE_METADATA } from "@/server/providers"

export interface PoolTypeOption {
  type: string
  label: string
  description?: string
  quotaKinds?: string[]
  credentialFields?: Array<{ key: string; label: string; required: boolean; type: string }>
}

function listBuiltinPoolTypeOptions(db: AppDatabase, includeDisabled: boolean): PoolTypeOption[] {
  return Object.keys(POOL_TYPE_METADATA).map((key): PoolTypeOption | null => {
    const meta = POOL_TYPE_METADATA[key as keyof typeof POOL_TYPE_METADATA]
    if (!meta) return null
    if (!includeDisabled && !isBuiltinProviderEnabled(meta.type, db)) return null
    return {
      type: meta.type,
      label: meta.label,
      description: meta.description,
      quotaKinds: [...meta.quotaKinds],
      credentialFields: meta.credentialFields,
    }
  }).filter((option): option is PoolTypeOption => option !== null)
}

const INTERFACE_LABELS: Record<string, string> = { chat: "Chat Completions", responses: "Responses", messages: "Anthropic Messages" }

function listCustomPoolTypeOptions(ownerUserId: string, db: AppDatabase, includeDisabled: boolean): PoolTypeOption[] {
  return new CustomProviderRepository(ownerUserId, db).list().filter((provider) => includeDisabled || provider.enabled).map((provider) => ({
    type: provider.poolType,
    label: provider.name,
    description: provider.description || `${provider.interfaceTypes.map((format) => INTERFACE_LABELS[format] ?? format).join(" / ")} · ${provider.baseUrl}`,
    quotaKinds: provider.balanceConfig ? ["PERMANENT", "FIVE_HOUR", "WEEKLY", "MONTHLY", "CUSTOM_PERIOD"] : [],
    credentialFields: [{ key: "token", label: "API Key", required: true, type: "password" }],
  }))
}

export function listPoolTypeOptions(ownerUserId: string, db: AppDatabase = getDatabase()): PoolTypeOption[] {
  return [
    ...listBuiltinPoolTypeOptions(db, false),
    ...listCustomPoolTypeOptions(ownerUserId, db, false),
  ]
}

export function listPoolTypeLabelMap(ownerUserId: string, db: AppDatabase = getDatabase()): Map<string, string> {
  // Label map must stay complete even for disabled providers, otherwise
  // existing accounts of a disabled pool would lose their human-readable label.
  return new Map([
    ...listBuiltinPoolTypeOptions(db, true),
    ...listCustomPoolTypeOptions(ownerUserId, db, true),
  ].map((option) => [option.type, option.label]))
}

/** Resolve a human-readable provider/pool name. Never returns raw custom:<uuid>. */
export function resolvePoolTypeLabel(
  poolType: string,
  ownerUserId: string,
  db: AppDatabase = getDatabase(),
  preferred?: string | null,
  labels?: Map<string, string>,
): string | null {
  if (preferred && preferred !== poolType && !preferred.startsWith("custom:")) return preferred
  return (labels ?? listPoolTypeLabelMap(ownerUserId, db)).get(poolType) ?? null
}
