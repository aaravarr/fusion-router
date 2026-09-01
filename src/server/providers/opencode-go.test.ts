import { beforeEach, describe, expect, it } from "vitest"
import { ensureProvidersRegistered, tryGetProvider } from "./index"
import { OpenCodeGoProvider, OPENCODE_GO_UPSTREAM_BASE_URL } from "./opencode-go"

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

// UA 透传是封号红线：opencode-go 上游要求客户端原始 User-Agent 原样到达，
// 网关不得伪装/改写。客户端没带 UA 时不伪造特定客户端，保持 fetch 默认值兜底。
describe("opencode-go User-Agent 透传", () => {
  const provider = new OpenCodeGoProvider()
  const account = { id: "a1", ownerUserId: "u1", poolType: "opencode-go" } as never
  const credential = { token: "go-key-1", credentialVersion: 1 }

  const build = (endpoint: string, headers: Record<string, string>) =>
    provider.buildForwardTarget(
      {
        method: "POST",
        endpoint,
        model: "kimi-k3",
        upstreamModel: "kimi-k3",
        body: new TextEncoder().encode("{}"),
        headers: new Headers(headers),
        signal: AbortSignal.timeout(1000),
      },
      credential,
      account,
    )

  it("客户端带 UA（chat/completions）：上游请求原样携带该 UA", () => {
    const target = build("chat/completions", {
      "user-agent": "claude-cli/2.1.63 (external, cli)",
      "content-type": "application/json",
    })
    expect(target.url).toBe(`${OPENCODE_GO_UPSTREAM_BASE_URL}/chat/completions`)
    expect(target.headers.get("user-agent")).toBe("claude-cli/2.1.63 (external, cli)")
    // 认证与其他 header 逻辑不受影响
    expect(target.headers.get("authorization")).toBe("Bearer go-key-1")
    expect(target.headers.get("x-api-key")).toBeNull()
  })

  it("客户端带 UA（messages）：UA 透传且走 x-api-key 认证", () => {
    const target = build("messages", {
      "user-agent": "opencode/1.2.3",
      "anthropic-version": "2023-06-01",
    })
    expect(target.headers.get("user-agent")).toBe("opencode/1.2.3")
    expect(target.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(target.headers.get("x-api-key")).toBe("go-key-1")
    expect(target.headers.get("authorization")).toBeNull()
  })

  it("客户端不带 UA：不伪造 UA（保持 fetch 默认值兜底），content-type 兜底为 application/json", () => {
    const target = build("chat/completions", {})
    expect(target.headers.get("user-agent")).toBeNull()
    expect(target.headers.get("content-type")).toBe("application/json")
    expect(target.headers.get("authorization")).toBe("Bearer go-key-1")
  })
})
