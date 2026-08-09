import { beforeEach, describe, expect, it } from "vitest"
import { SecretVault } from "./crypto"
import { CustomProviderRepository, customPoolType, invalidateCustomProviderCache } from "./custom-providers"
import { createDatabase, ensureCustomProviderInterfaceTypesColumn } from "./db"
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
      interfaceTypes: ["chat"],
      models: ["gpt-a", "gpt-a", " gpt-b "],
    })
    expect(created.baseUrl).toBe("https://gateway.example.com/v1")
    expect(created.poolType).toBe(customPoolType(created.id))
    expect(created.models).toEqual(["gpt-a", "gpt-b"])

    expect(repository.update(created.id, { interfaceTypes: ["responses"], models: null })).toMatchObject({ interfaceTypes: ["responses"], models: null })
    db.close()
  })

  it("stores multiple interface types while keeping the legacy column CHECK-compatible", () => {
    const db = database()
    const repository = new CustomProviderRepository(ownerUserId, db)
    const created = repository.create({ name: "Multi", baseUrl: "https://api.example.com/v1", interfaceTypes: ["messages", "chat", "chat"] })
    expect(created.interfaceTypes).toEqual(["messages", "chat"])
    // 旧列 CHECK 只允许 chat/responses，写入兼容填充值；真实数据源是新列。
    const row = db.prepare("SELECT interface_type, interface_types_json FROM custom_providers WHERE id=?").get(created.id) as { interface_type: string; interface_types_json: string }
    expect(row.interface_type).toBe("chat")
    expect(JSON.parse(row.interface_types_json)).toEqual(["messages", "chat"])

    expect(repository.update(created.id, { interfaceTypes: ["responses", "messages"] })?.interfaceTypes).toEqual(["responses", "messages"])
    expect(() => repository.update(created.id, { interfaceTypes: [] })).toThrow(/至少选择一种接口类型/)
    expect(() => repository.create({ name: "Empty", baseUrl: "https://api.example.com/v1", interfaceTypes: [] })).toThrow(/至少选择一种接口类型/)
    db.close()
  })

  it("falls back to the legacy column when interface_types_json is null", () => {
    const db = database()
    const repository = new CustomProviderRepository(ownerUserId, db)
    const created = repository.create({ name: "Legacy", baseUrl: "https://api.example.com/v1", interfaceTypes: ["responses"] })
    db.prepare("UPDATE custom_providers SET interface_types_json=NULL WHERE id=?").run(created.id)
    invalidateCustomProviderCache(created.id)
    expect(repository.get(created.id)?.interfaceTypes).toEqual(["responses"])
    db.close()
  })

  it("backfills interface_types_json from legacy rows during migration, idempotently", () => {
    const db = database()
    // 模拟迁移前的老库：新列不存在，只有 interface_type 单选。
    db.exec("ALTER TABLE custom_providers DROP COLUMN interface_types_json")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO custom_providers(id,owner_user_id,name,base_url,interface_type,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
      .run("legacy-1", ownerUserId, "Old", "https://api.example.com/v1", "chat", timestamp, timestamp)
    ensureCustomProviderInterfaceTypesColumn(db)
    const row = db.prepare("SELECT interface_types_json FROM custom_providers WHERE id='legacy-1'").get() as { interface_types_json: string }
    expect(JSON.parse(row.interface_types_json)).toEqual(["chat"])
    ensureCustomProviderInterfaceTypesColumn(db)
    expect(new CustomProviderRepository(ownerUserId, db).get("legacy-1")?.interfaceTypes).toEqual(["chat"])
    db.close()
  })

  it("deletes provider accounts and their encrypted credentials transactionally", () => {
    const db = database()
    const providers = new CustomProviderRepository(ownerUserId, db)
    const provider = providers.create({ name: "Delete me", baseUrl: "https://api.example.com/v1", interfaceTypes: ["responses"] })
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
