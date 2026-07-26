import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { AccountRepository, ProviderCredentialRepository } from "./repository"
import type { AccountRecord, PoolType } from "./types"

export const UNLIMITED_CONCURRENCY = 0

function generatedKeyName(ownerUserId: string, poolType: PoolType, db: AppDatabase): string {
  const rows = db.prepare("SELECT name FROM accounts WHERE owner_user_id=? AND pool_type=?").all(ownerUserId, poolType) as { name: string }[]
  const used = new Set(rows.flatMap(({ name }) => {
    const match = /^API Key (\d+)$/.exec(name)
    return match ? [Number(match[1])] : []
  }))
  let number = 1
  while (used.has(number)) number += 1
  return `API Key ${String(number).padStart(3, "0")}`
}

export function createCustomProviderKeyAccount(input: {
  ownerUserId: string
  poolType: PoolType
  apiKey: string
  name?: string
  maxConcurrency?: number | null
  extraHeaders?: Record<string, string>
}, db: AppDatabase = getDatabase()): AccountRecord {
  const accounts = new AccountRepository(input.ownerUserId, db)
  const credentials = new ProviderCredentialRepository(input.ownerUserId, db)
  return db.transaction(() => {
    const account = accounts.createProviderAccount({
      name: input.name?.trim() || generatedKeyName(input.ownerUserId, input.poolType, db),
      poolType: input.poolType,
    })
    credentials.upsert({
      accountId: account.id,
      poolType: input.poolType,
      credentialData: {
        token: input.apiKey,
        ...(input.extraHeaders ? { extraHeaders: JSON.stringify(input.extraHeaders) } : {}),
      },
    })
    return accounts.updateState(account.id, {
      maxConcurrency: input.maxConcurrency ?? UNLIMITED_CONCURRENCY,
    })!
  }).immediate()
}
