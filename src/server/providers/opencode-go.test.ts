import { beforeEach, describe, expect, it } from "vitest"
import { ensureProvidersRegistered, tryGetProvider } from "./index"
import { isMessagesUnsupportedModel, isMuseResponsesOnlyModel, OpenCodeGoProvider, OPENCODE_GO_UPSTREAM_BASE_URL } from "./opencode-go"
import { decideUpstreamRoute } from "../messages/route-decision"
import { messagesRequestToChat } from "../messages/convert"

describe("opencode-go supportedInterfaces（responses 白名单 + muse 强制 responses）", () => {
  beforeEach(() => { ensureProvidersRegistered() })

  const provider = () => tryGetProvider("opencode-go")!

  it("muse-spark-1.2-contributor：只声明 responses（上游仅支持 /v1/responses，chat/messages 入口交给网关转换链）", () => {
    expect(provider().supportedInterfaces!("muse-spark-1.2-contributor")).toEqual(["responses"])
  })

  it("muse 前缀变体全部命中：muse-spark-1.2 / muse-spark-1.3-contributor / 大小写 / 未来型号", () => {
    for (const model of ["muse-spark-1.2", "muse-spark-1.3-contributor", "Muse-Spark-1.2", "MUSE-9.9-ultra", " muse-spark-1.2 "]) {
      expect(provider().supportedInterfaces!(model), model).toEqual(["responses"])
    }
  })

  it("非 muse 前缀不误伤：muse 无连字符 / 含 muse 子串 / 空串", () => {
    for (const model of ["muse", "musex-1", "not-muse-1", "glm-5.2", ""]) {
      expect(isMuseResponsesOnlyModel(model), model).toBe(false)
      expect(provider().supportedInterfaces!(model), model).toEqual(["chat", "messages"])
    }
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

// omen-alpha：上游 /messages 端点不支持（2026-09-04 生产实测 500，多账号一致）；
// 摘掉 messages 只声明 chat，messages 入口由网关 messages->chat 接力，chat 原生不受影响。
describe("opencode-go supportedInterfaces（omen-alpha 上游不支持 messages）", () => {
  beforeEach(() => { ensureProvidersRegistered() })

  const provider = () => tryGetProvider("opencode-go")!

  it("omen-alpha：只声明 chat，不含 messages / responses", () => {
    const ifs = provider().supportedInterfaces!("omen-alpha")
    expect(ifs).toEqual(["chat"])
    expect(ifs).not.toContain("messages")
    expect(ifs).not.toContain("responses")
  })

  it("精确匹配且大小写不敏感：omen-alpha 命中，omen-* 前缀不泛化", () => {
    for (const hit of ["omen-alpha", "Omen-Alpha", " OMEN-ALPHA "]) {
      expect(isMessagesUnsupportedModel(hit), hit).toBe(true)
      expect(provider().supportedInterfaces!(hit), hit).toEqual(["chat"])
    }
    // 无实测证据的 omen-* 变体不得误伤，仍保留 messages 原生
    for (const miss of ["omen-beta", "omen-alpha-2", "omen", "omen-alpha-x", "glm-5.2", "muse-spark-1.2"]) {
      expect(isMessagesUnsupportedModel(miss), miss).toBe(false)
    }
  })

  it("omen-alpha messages 入口：决策管线自动接力 messages->chat 上行至 chat/completions", () => {
    const route = decideUpstreamRoute("messages", provider().supportedInterfaces!("omen-alpha"))
    expect(route).toMatchObject({
      upstreamEndpoint: "chat/completions",
      requestChain: ["messages->chat"],
      native: false,
      reason: "messages_to_chat",
    })
  })

  it("omen-alpha messages 入口含 image 块：经 messages->chat 转换后图片保真为 image_url part", () => {
    const route = decideUpstreamRoute("messages", provider().supportedInterfaces!("omen-alpha"))!
    expect(route.requestChain).toEqual(["messages->chat"])
    const chatBody = messagesRequestToChat({
      model: "omen-alpha",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "描述这张图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
            { type: "image", source: { type: "url", url: "https://example.com/pic.jpg" } },
          ],
        },
      ],
    })
    const content = (chatBody.messages as Array<{ role: string; content: unknown }>)[0].content
    expect(content).toEqual([
      { type: "text", text: "描述这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      { type: "image_url", image_url: { url: "https://example.com/pic.jpg" } },
    ])
  })

  it("omen-alpha chat 入口：仍原生直通，不做转换", () => {
    const route = decideUpstreamRoute("chat", provider().supportedInterfaces!("omen-alpha"))
    expect(route).toMatchObject({ upstreamEndpoint: "chat/completions", requestChain: [], native: true, reason: "chat_native" })
  })

  it("omen-alpha responses 入口：维持非白名单既有行为，经 responses->chat 上行", () => {
    const route = decideUpstreamRoute("responses", provider().supportedInterfaces!("omen-alpha"))
    expect(route).toMatchObject({
      upstreamEndpoint: "chat/completions",
      requestChain: ["responses->chat"],
      native: false,
      reason: "responses_to_chat",
    })
  })

  it("其他模型回归不破：非 omen/muse 模型 messages 仍原生直通", () => {
    for (const model of ["kimi-k3", "glm-5.2", "deepseek-v4-flash"]) {
      expect(provider().supportedInterfaces!(model), model).toEqual(["chat", "messages"])
      const route = decideUpstreamRoute("messages", provider().supportedInterfaces!(model))!
      expect(route.native, model).toBe(true)
      expect(route.upstreamEndpoint, model).toBe("messages")
      expect(route.reason, model).toBe("messages_native")
    }
    // muse 案例不受影响：仍只声明 responses，messages 入口走 messages->chat->responses 接力
    expect(provider().supportedInterfaces!("muse-spark-1.3-contributor")).toEqual(["responses"])
    expect(decideUpstreamRoute("messages", provider().supportedInterfaces!("muse-spark-1.3-contributor")))
      .toMatchObject({ upstreamEndpoint: "responses", requestChain: ["messages->chat", "chat->responses"] })
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
