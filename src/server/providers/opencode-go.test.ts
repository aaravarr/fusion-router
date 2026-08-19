import { beforeEach, describe, expect, it } from "vitest"
import { ensureProvidersRegistered, tryGetProvider } from "./index"

describe("opencode-go supportedInterfaces（responses 白名单）", () => {
  beforeEach(() => { ensureProvidersRegistered() })

  const provider = () => tryGetProvider("opencode-go")!

  it("muse-spark-1.2-contributor：原生支持 responses（加入白名单后不再转 chat）", () => {
    const ifs = provider().supportedInterfaces!("muse-spark-1.2-contributor")
    expect(ifs).toContain("responses")
    expect(ifs).toContain("chat")
  })

  it("gpt-5.6-luna：仍原生支持 responses（白名单回归）", () => {
    expect(provider().supportedInterfaces!("gpt-5.6-luna")).toContain("responses")
  })

  it("未列入白名单的模型（deepseek-v4-flash）：不含 responses，只走 chat/messages", () => {
    const ifs = provider().supportedInterfaces!("deepseek-v4-flash")
    expect(ifs).not.toContain("responses")
    expect(ifs).toContain("chat")
    expect(ifs).toContain("messages")
  })

  it("未指定模型：返回默认 chat/messages，不含 responses", () => {
    const ifs = provider().supportedInterfaces!(undefined)
    expect(ifs).not.toContain("responses")
    expect(ifs).toEqual(["chat", "messages"])
  })
})
