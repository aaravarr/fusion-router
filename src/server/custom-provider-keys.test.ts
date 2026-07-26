import { describe, expect, it } from "vitest"
import { createCustomProviderKeyAccount } from "./custom-provider-keys"
import { CustomProviderRepository } from "./custom-providers"
import { createDatabase } from "./db"
import { AccountRepository, ProviderCredentialRepository } from "./repository"

const ownerUserId = "custom-key-owner"

function setup() {
  const db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
  const provider = new CustomProviderRepository(ownerUserId, db).create({
    name: "Custom",
    baseUrl: "https://api.example.com/v1",
    interfaceType: "chat",
  })
  return { db, provider }
}

describe("custom provider keys", () => {
  it("defaults to an auto-numbered name and unlimited concurrency", () => {
    const { db, provider } = setup()
    const account = createCustomProviderKeyAccount({ ownerUserId, poolType: provider.poolType, apiKey: "same-secret" }, db)
    expect(account).toMatchObject({ name: "API Key 001", maxConcurrency: 0 })
    expect(new ProviderCredentialRepository(ownerUserId, db).get(account.id)).toMatchObject({ token: "same-secret" })
    db.close()
  })

  it("can delete and add the same upstream key again with a high concurrency limit", () => {
    const { db, provider } = setup()
    const accounts = new AccountRepository(ownerUserId, db)
    const first = createCustomProviderKeyAccount({ ownerUserId, poolType: provider.poolType, apiKey: "reusable-secret" }, db)
    expect(accounts.delete(first.id)).toBe(true)

    const second = createCustomProviderKeyAccount({ ownerUserId, poolType: provider.poolType, apiKey: "reusable-secret", maxConcurrency: 200 }, db)
    expect(second.id).not.toBe(first.id)
    expect(second).toMatchObject({ name: "API Key 001", maxConcurrency: 200 })
    expect(new ProviderCredentialRepository(ownerUserId, db).get(second.id)).toMatchObject({ token: "reusable-secret" })
    db.close()
  })

  it("rolls back the account when credential persistence fails", () => {
    const { db, provider } = setup()
    db.exec("CREATE TRIGGER reject_custom_credential BEFORE INSERT ON provider_credentials BEGIN SELECT RAISE(ABORT, 'credential rejected'); END")
    expect(() => createCustomProviderKeyAccount({ ownerUserId, poolType: provider.poolType, apiKey: "will-fail" }, db)).toThrow(/credential rejected/)
    expect(db.prepare("SELECT COUNT(*) count FROM accounts WHERE owner_user_id=? AND pool_type=?").get(ownerUserId, provider.poolType)).toEqual({ count: 0 })
    db.close()
  })
})
