import { beforeEach, describe, expect, it } from "vitest"
import { SecretVault } from "./crypto"
import { CustomProviderRepository, customPoolType } from "./custom-providers"
import { createDatabase } from "./db"
import { runBalanceExtractor } from "./providers/custom"
import { AccountRepository, ProviderCredentialRepository } from "./repository"

const ownerUserId = "owner-1"
const encryptionKey = Buffer.alloc(32, 7).toString("base64")

function database() {
  const db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
  return db
}

describe("custom providers", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("creates and updates a provider while normalizing its base URL and models", () => {
    const db = database()
    const repository = new CustomProviderRepository(ownerUserId, db)
    const created = repository.create({
      name: "Internal OpenAI",
      baseUrl: "https://gateway.example.com/v1/",
      interfaceType: "chat",
      models: ["gpt-a", "gpt-a", " gpt-b "],
    })
    expect(created.baseUrl).toBe("https://gateway.example.com/v1")
    expect(created.poolType).toBe(customPoolType(created.id))
    expect(created.models).toEqual(["gpt-a", "gpt-b"])

    expect(repository.update(created.id, { interfaceType: "responses", models: null })).toMatchObject({ interfaceType: "responses", models: null })
    db.close()
  })

  it("deletes provider accounts and their encrypted credentials transactionally", () => {
    const db = database()
    const providers = new CustomProviderRepository(ownerUserId, db)
    const provider = providers.create({ name: "Delete me", baseUrl: "https://api.example.com/v1", interfaceType: "responses" })
    const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
    const account = accounts.createProviderAccount({ name: "key one", poolType: provider.poolType })
    new ProviderCredentialRepository(ownerUserId, db, new SecretVault(encryptionKey)).upsert({ accountId: account.id, poolType: provider.poolType, credentialData: { token: "secret" } })

    expect(providers.delete(provider.id)).toBe(true)
    expect(accounts.get(account.id)).toBeNull()
    expect(db.prepare("SELECT COUNT(*) count FROM provider_credentials").get()).toEqual({ count: 0 })
    db.close()
  })

  it("runs the documented balance extractor shape in a time-limited VM", () => {
    const result = runBalanceExtractor(`function(response) {
      return { isValid: response.is_active, remaining: response.balance, total: 100, type: "monthly", unit: "USD" };
    }`, { is_active: true, balance: 42 })
    expect(result).toEqual({ isValid: true, remaining: 42, total: 100, type: "monthly", unit: "USD" })
    expect(() => runBalanceExtractor("function() { while (true) {} }", {})).toThrow(/timed out/i)
  })
})
