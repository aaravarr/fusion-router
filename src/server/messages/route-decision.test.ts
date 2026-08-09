import { describe, expect, it } from "vitest"
import { canServeInterface, decideUpstreamRoute, endpointForFormat, formatForEndpoint, type InterfaceFormat } from "./route-decision"

const ALL: InterfaceFormat[] = ["chat", "responses", "messages"]

describe("decideUpstreamRoute", () => {
  it("native hit passthrough for every inbound format", () => {
    for (const inbound of ALL) {
      const decision = decideUpstreamRoute(inbound, ALL)
      expect(decision).toMatchObject({ upstreamEndpoint: endpointForFormat(inbound), requestChain: [], responseChain: [], native: true })
    }
    expect(decideUpstreamRoute("messages", ["messages"])).toMatchObject({ native: true, reason: "messages_native" })
  })

  it("messages inbound falls back through the chat hub", () => {
    expect(decideUpstreamRoute("messages", ["chat"])).toEqual({
      upstreamEndpoint: "chat/completions",
      requestChain: ["messages->chat"],
      responseChain: ["chat->messages"],
      native: false,
      reason: "messages_to_chat",
    })
  })

  it("messages inbound relays messages->chat->responses when only responses is supported", () => {
    expect(decideUpstreamRoute("messages", ["responses"])).toEqual({
      upstreamEndpoint: "responses",
      requestChain: ["messages->chat", "chat->responses"],
      responseChain: ["responses->chat", "chat->messages"],
      native: false,
      reason: "messages_to_responses",
    })
  })

  it("chat inbound converts to responses when chat is unsupported", () => {
    expect(decideUpstreamRoute("chat", ["responses"])).toMatchObject({
      upstreamEndpoint: "responses",
      requestChain: ["chat->responses"],
      responseChain: ["responses->chat"],
      reason: "chat_to_responses",
    })
  })

  it("responses inbound converts to chat when responses is unsupported", () => {
    expect(decideUpstreamRoute("responses", ["chat"])).toMatchObject({
      upstreamEndpoint: "chat/completions",
      requestChain: ["responses->chat"],
      responseChain: ["chat->responses"],
      reason: "responses_to_chat",
    })
  })

  it("returns null when no conversion path exists", () => {
    expect(decideUpstreamRoute("chat", ["messages"])).toBeNull()
    expect(decideUpstreamRoute("responses", ["messages"])).toBeNull()
    expect(decideUpstreamRoute("messages", [])).toBeNull()
  })

  it("matches the confirmed built-in provider capabilities", () => {
    const capabilities: Record<string, InterfaceFormat[]> = {
      "opencode-go": ["chat", "messages"],
      "kimi-code": ["chat", "messages"],
      openai: ["responses"],
      "xai-grok": ["chat", "responses"],
    }
    // 入口×支持集合全组合：所有内置 provider 对三种入口都必须可达。
    for (const supported of Object.values(capabilities)) {
      for (const inbound of ALL) {
        expect(decideUpstreamRoute(inbound, supported), `${inbound} × [${supported}]`).not.toBeNull()
      }
    }
    expect(decideUpstreamRoute("messages", capabilities["xai-grok"])?.upstreamEndpoint).toBe("chat/completions")
    expect(decideUpstreamRoute("messages", capabilities.openai)?.upstreamEndpoint).toBe("responses")
    expect(decideUpstreamRoute("responses", capabilities["opencode-go"])?.upstreamEndpoint).toBe("chat/completions")
    expect(decideUpstreamRoute("responses", capabilities.openai)?.native).toBe(true)
  })
})

describe("canServeInterface", () => {
  it("treats unknown capability as servable and gates messages-only accounts", () => {
    expect(canServeInterface("messages", null)).toBe(true)
    expect(canServeInterface("messages", undefined)).toBe(true)
    expect(canServeInterface("messages", ["messages"])).toBe(true)
    expect(canServeInterface("chat", ["messages"])).toBe(false)
    expect(canServeInterface("responses", ["messages"])).toBe(false)
    expect(canServeInterface("messages", ["chat"])).toBe(true)
  })
})

describe("endpoint/format mapping", () => {
  it("round-trips between endpoints and formats", () => {
    expect(formatForEndpoint("chat/completions")).toBe("chat")
    expect(formatForEndpoint("/responses")).toBe("responses")
    expect(formatForEndpoint("messages")).toBe("messages")
    expect(formatForEndpoint("models")).toBeNull()
    expect(endpointForFormat("chat")).toBe("chat/completions")
  })
})
