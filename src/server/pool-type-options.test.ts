import { describe, expect, it } from "vitest"
import { createDatabase } from "./db"
import { setBuiltinProviderEnabled } from "./builtin-provider-state"
import { CustomProviderRepository } from "./custom-providers"
import { listPoolTypeLabelMap, listPoolTypeOptions } from "./pool-type-options"

const ownerUserId = "owner"

describe("pool-type-options", () => {
  it("默认包含全部内置 provider", () => {
    const db = createDatabase(":memory:")
    const types = listPoolTypeOptions(ownerUserId, db).map((option) => option.type)
    expect(types).toEqual(expect.arrayContaining(["opencode-go", "openai", "xai-grok", "kimi-code"]))
  })

  it("options 过滤被禁用的内置 provider，labelMap 保持全量", () => {
    const db = createDatabase(":memory:")
    setBuiltinProviderEnabled("xai-grok", false, db)

    const types = listPoolTypeOptions(ownerUserId, db).map((option) => option.type)
    expect(types).not.toContain("xai-grok")
    expect(types).toEqual(expect.arrayContaining(["opencode-go", "openai", "kimi-code"]))

    // labelMap 不过滤：被禁 provider 的既有账号仍要有可读 label
    const labels = listPoolTypeLabelMap(ownerUserId, db)
    expect(labels.get("xai-grok")).toBe("xAI Grok")
    expect(labels.get("opencode-go")).toBe("OpenCode Go")

    // 重新启用后 options 恢复
    setBuiltinProviderEnabled("xai-grok", true, db)
    expect(listPoolTypeOptions(ownerUserId, db).map((option) => option.type)).toContain("xai-grok")
  })

  it("停用的自定义 provider 不进 options，labelMap 保持全量", () => {
    const db = createDatabase(":memory:")
    const now = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", now, now)
    const repo = new CustomProviderRepository(ownerUserId, db)
    repo.create({ name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", interfaceType: "chat" })
    const provider = repo.create({ name: "Disabled Up", baseUrl: "https://example.com/v1", interfaceType: "chat", enabled: false })

    const types = listPoolTypeOptions(ownerUserId, db).map((option) => option.type)
    expect(types).toContain(repo.list()[0].poolType)
    expect(types).not.toContain(provider.poolType)

    const labels = listPoolTypeLabelMap(ownerUserId, db)
    expect(labels.get(provider.poolType)).toBe("Disabled Up")
  })
})
