import { describe, expect, it } from "vitest"
import { createDatabase } from "./db"
import { setBuiltinProviderEnabled } from "./builtin-provider-state"
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
})
