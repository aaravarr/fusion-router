import { describe, expect, it } from "vitest"
import { configSchema } from "./route"

describe("mcp tool config schema", () => {
  it("接受 deepseek_web_search 的 provider 字段（回归：曾被静默剥离）", () => {
    const parsed = configSchema.parse({
      provider: "custom:deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
      temperature: 0.3,
    })
    expect(parsed.provider).toBe("custom:deepseek-official")
    expect(parsed.model).toBe("deepseek-v4-flash")
  })

  it("provider 可设为 null", () => {
    const parsed = configSchema.parse({ provider: null })
    expect(parsed.provider).toBeNull()
  })

  it("接受 describe_image 的既有字段", () => {
    const parsed = configSchema.parse({
      poolType: "",
      model: "minimax-m3",
      prompt: "",
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEnabled: false,
      reasoningEffort: null,
    })
    expect(parsed.model).toBe("minimax-m3")
  })

  it("接受 deepseek_web_search 的思考强度与最大工具调用次数", () => {
    const parsed = configSchema.parse({
      provider: "custom:deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEffort: "high",
      maxToolCalls: 5,
    })
    expect(parsed.reasoningEffort).toBe("high")
    expect(parsed.maxToolCalls).toBe(5)
  })

  it("接受 reasoningEffort=none/max", () => {
    expect(configSchema.parse({ reasoningEffort: "none" }).reasoningEffort).toBe("none")
    expect(configSchema.parse({ reasoningEffort: "max" }).reasoningEffort).toBe("max")
  })

  it("strict：未知字段直接报错，防止配置被静默丢弃", () => {
    expect(() => configSchema.parse({ provider: "custom:abc", unknownField: 1 })).toThrow()
    expect(() => configSchema.parse({ model: "x", providerTypo: "custom:abc" })).toThrow()
  })
})
