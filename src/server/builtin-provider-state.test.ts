import { describe, expect, it } from "vitest"
import { createDatabase } from "./db"
import {
  BUILTIN_PROVIDER_STATES_KEY,
  getBuiltinProviderStates,
  isBuiltinProviderEnabled,
  setBuiltinProviderEnabled,
} from "./builtin-provider-state"

describe("builtin-provider-state", () => {
  it("无记录时默认全部启用", () => {
    const db = createDatabase(":memory:")
    expect(getBuiltinProviderStates(db)).toEqual({})
    expect(isBuiltinProviderEnabled("opencode-go", db)).toBe(true)
    expect(isBuiltinProviderEnabled("kimi-code", db)).toBe(true)
  })

  it("禁用后查询为 false，重新启用后恢复 true（往返）", () => {
    const db = createDatabase(":memory:")
    setBuiltinProviderEnabled("xai-grok", false, db)
    expect(isBuiltinProviderEnabled("xai-grok", db)).toBe(false)
    // 其它内置类型不受影响
    expect(isBuiltinProviderEnabled("openai", db)).toBe(true)

    const states = getBuiltinProviderStates(db)
    expect(states["xai-grok"]?.enabled).toBe(false)
    expect(typeof states["xai-grok"]?.updatedAt).toBe("string")

    setBuiltinProviderEnabled("xai-grok", true, db)
    expect(isBuiltinProviderEnabled("xai-grok", db)).toBe(true)
  })

  it("重复写入覆盖旧值（ON CONFLICT 更新而非报错）", () => {
    const db = createDatabase(":memory:")
    setBuiltinProviderEnabled("openai", false, db)
    setBuiltinProviderEnabled("kimi-code", false, db)
    setBuiltinProviderEnabled("openai", true, db)
    expect(isBuiltinProviderEnabled("openai", db)).toBe(true)
    expect(isBuiltinProviderEnabled("kimi-code", db)).toBe(false)
  })

  it("损坏的 JSON 容错返回 {}（全部默认启用）", () => {
    const db = createDatabase(":memory:")
    db.prepare("INSERT INTO system_settings(key, value_json, is_secret, updated_at) VALUES (?, ?, 0, ?)")
      .run(BUILTIN_PROVIDER_STATES_KEY, "{not-json", new Date().toISOString())
    expect(getBuiltinProviderStates(db)).toEqual({})
    expect(isBuiltinProviderEnabled("opencode-go", db)).toBe(true)
  })

  it("结构异常的条目被忽略", () => {
    const db = createDatabase(":memory:")
    db.prepare("INSERT INTO system_settings(key, value_json, is_secret, updated_at) VALUES (?, ?, 0, ?)")
      .run(
        BUILTIN_PROVIDER_STATES_KEY,
        JSON.stringify({ "openai": { enabled: false }, "bad-1": "nope", "bad-2": { enabled: "yes" } }),
        new Date().toISOString(),
      )
    expect(isBuiltinProviderEnabled("openai", db)).toBe(false)
    expect(isBuiltinProviderEnabled("bad-1", db)).toBe(true)
    expect(isBuiltinProviderEnabled("bad-2", db)).toBe(true)
  })

  it("custom:* 类型恒为 true，不受状态表影响", () => {
    const db = createDatabase(":memory:")
    expect(isBuiltinProviderEnabled("custom:abc-123", db)).toBe(true)
    // 即使状态表里被人为写入了 custom 条目也不生效
    setBuiltinProviderEnabled("custom:abc-123", false, db)
    expect(isBuiltinProviderEnabled("custom:abc-123", db)).toBe(true)
  })
})
