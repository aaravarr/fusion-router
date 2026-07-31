import { CustomProviderRepository } from "@/server/custom-providers"
import type { AppDatabase } from "@/server/db"
import { getDatabase } from "@/server/db"
import { POOL_TYPE_METADATA } from "@/server/providers"

export interface PoolTypeOption {
  type: string
  label: string
  description?: string
  quotaKinds?: string[]
  credentialFields?: Array<{ key: string; label: string; required: boolean; type: string }>
}

export function listPoolTypeOptions(ownerUserId: string, db: AppDatabase = getDatabase()): PoolTypeOption[] {
  return [
    ...Object.keys(POOL_TYPE_METADATA).map((key): PoolTypeOption | null => {
      const meta = POOL_TYPE_METADATA[key as keyof typeof POOL_TYPE_METADATA]
      if (!meta) return null
      return {
        type: meta.type,
        label: meta.label,
        description: meta.description,
        quotaKinds: [...meta.quotaKinds],
        credentialFields: meta.credentialFields,
      }
    }).filter((option): option is PoolTypeOption => option !== null),
    ...new CustomProviderRepository(ownerUserId, db).list().map((provider) => ({
      type: provider.poolType,
      label: provider.name,
      description: provider.description || `${provider.interfaceType === "chat" ? "Chat Completions" : "Responses"} · ${provider.baseUrl}`,
      quotaKinds: provider.balanceConfig ? ["PERMANENT", "FIVE_HOUR", "WEEKLY", "MONTHLY", "CUSTOM_PERIOD"] : [],
      credentialFields: [{ key: "token", label: "API Key", required: true, type: "password" }],
    })),
  ]
}
