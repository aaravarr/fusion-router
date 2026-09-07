import { beforeEach, describe, expect, it } from "vitest"
import { ensureProvidersRegistered, tryGetProvider } from "./index"
import { isMessagesUnsupportedModel, isMuseResponsesOnlyModel, MUSE_RATE_LIMIT_MAX_RETRIES, MUSE_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS, OpenCodeGoProvider, OPENCODE_GO_UPSTREAM_BASE_URL, PASSTHROUGH_HEADERS } from "./opencode-go"
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

// x-opencode-session 透传：上游 2026-09-07 起强制要求该头（缺失回 MissingSessionID 400）。
// 只透传不合成：客户端带就原样到达上游，没带就不带（网关不做任何会话识别/生成）。
describe("opencode-go x-opencode-session 透传", () => {
  const provider = new OpenCodeGoProvider()
  const account = { id: "a1", ownerUserId: "u1", poolType: "opencode-go" } as never
  const credential = { token: "go-key-1", credentialVersion: 1 }

  const build = (headers: Record<string, string>) =>
    provider.buildForwardTarget(
      {
        method: "POST",
        endpoint: "chat/completions",
        model: "kimi-k3",
        upstreamModel: "kimi-k3",
        body: new TextEncoder().encode("{}"),
        headers: new Headers(headers),
        signal: AbortSignal.timeout(1000),
      },
      credential,
      account,
    )

  it("客户端带 x-opencode-session：上游请求原样收到该头", () => {
    const target = build({ "x-opencode-session": "ses_abc123", "content-type": "application/json" })
    expect(target.headers.get("x-opencode-session")).toBe("ses_abc123")
    expect(target.headers.get("authorization")).toBe("Bearer go-key-1")
  })

  it("大小写变体同样命中（HTTP 头大小写不敏感）", () => {
    const target = build({ "X-Opencode-Session": "ses_UPPER" })
    expect(target.headers.get("x-opencode-session")).toBe("ses_UPPER")
  })

  it("客户端没带：不合成该头（证明没有会话生成逻辑），其余头不受影响", () => {
    const target = build({ "content-type": "application/json", "user-agent": "opencode/1.2.3" })
    expect(target.headers.get("x-opencode-session")).toBeNull()
    expect(target.headers.get("user-agent")).toBe("opencode/1.2.3")
    expect(target.headers.get("authorization")).toBe("Bearer go-key-1")
  })

  it("白名单两处一致：provider PASSTHROUGH_HEADERS 与 gateway UPSTREAM_PASSTHROUGH_HEADERS 完全相同", async () => {
    const { UPSTREAM_PASSTHROUGH_HEADERS } = await import("../gateway")
    expect(PASSTHROUGH_HEADERS).toContain("x-opencode-session")
    expect(UPSTREAM_PASSTHROUGH_HEADERS).toEqual(PASSTHROUGH_HEADERS)
  })
})

// muse-* 429 自动重试：配额耗尽 vs 瞬时限流二分（对齐 kimi-code / glm-coding 风格）。
// 仅 muse 模型生效（classifyError 第 4 参 model）；其他模型与缺省 model 保持既有行为（429 → null）。
describe("opencode-go muse-* 429 二分（MUSE_QUOTA_EXHAUSTED / MUSE_RATE_LIMITED）", () => {
  const provider = new OpenCodeGoProvider()
  const MUSE = "muse-spark-1.3-contributor"

  it("重试参数定值：最多 3 次同号重试，总预算 60s", () => {
    expect(MUSE_RATE_LIMIT_MAX_RETRIES).toBe(3)
    expect(MUSE_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS).toBe(60_000)
  })

  describe.each([
    ["结构化 error.type=exceeded_current_quota_error", JSON.stringify({ error: { type: "exceeded_current_quota_error", message: "You exceeded your current quota" } })],
    ["结构化 error.code=insufficient_quota", JSON.stringify({ error: { code: "insufficient_quota", message: "quota ran out" } })],
    ["嵌套 error.error.code=quota_exceeded", JSON.stringify({ error: { error: { code: "quota_exceeded" } } })],
    ["纯文本 insufficient balance", "insufficient balance, please recharge"],
    ["纯文本 in arrears", "Your account is in arrears, please recharge"],
    ["中文 套餐额度已用完", "套餐额度已用完，请充值"],
    ["中文 余额不足", "余额不足"],
    ["中文 欠费", "账号已欠费"],
  ])("配额耗尽语义（直接切号，不在本账号空转）：%s", (_label, body) => {
    it("muse 模型 → MUSE_QUOTA_EXHAUSTED + 冷却 60s 默认", () => {
      const result = provider.classifyError(429, body, new Headers(), MUSE)
      expect(result).toMatchObject({
        shouldSwitchAccount: true,
        quotaKind: "UNKNOWN_GO_LIMIT",
        retryAfterSeconds: 60,
        errorType: "MUSE_QUOTA_EXHAUSTED",
      })
      expect(result?.retrySameAccount).toBeUndefined()
    })
  })

  describe.each([
    ["纯文本 rate limit", "rate limit exceeded, retry later"],
    ["纯文本 concurrent", "too many concurrent requests"],
    ["纯文本首字母大写", "Rate limit exceeded, please retry after a moment"],
    ["结构化 rate_limit_error", JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } })],
    ["结构化 429 状态码", JSON.stringify({ error: { type: "too_many_requests", message: "slow down" }, status: 429 })],
  ])("瞬时限流语义（同号退避重试再切号）：%s", (_label, body) => {
    it("muse 模型 → MUSE_RATE_LIMITED + retrySameAccount", () => {
      const result = provider.classifyError(429, body, new Headers(), MUSE)
      expect(result).toMatchObject({
        shouldSwitchAccount: true,
        retrySameAccount: { maxRetries: 3, maxTotalBackoffMs: 60_000 },
        quotaKind: "PROVIDER_RATE_LIMIT",
        errorType: "MUSE_RATE_LIMITED",
      })
    })
  })

  it("muse 大小写变体同样命中二分", () => {
    expect(provider.classifyError(429, "too many requests", new Headers(), "MUSE-Spark-9"))
      ?.toMatchObject({ errorType: "MUSE_RATE_LIMITED" })
    expect(provider.classifyError(429, "余额不足", new Headers(), " muse-spark-1.2 "))
      ?.toMatchObject({ errorType: "MUSE_QUOTA_EXHAUSTED" })
  })

  it("Retry-After 头被尊重：秒数与 HTTP-date 均解析", () => {
    expect(provider.classifyError(429, "too many requests", new Headers({ "retry-after": "17" }), MUSE)?.retryAfterSeconds).toBe(17)
    expect(provider.classifyError(429, "余额不足", new Headers({ "retry-after": "120" }), MUSE)?.retryAfterSeconds).toBe(120)
    const httpDate = new Date(Date.now() + 45_000).toUTCString()
    const parsed = provider.classifyError(429, "too many requests", new Headers({ "retry-after": httpDate }), MUSE)?.retryAfterSeconds
    expect(parsed).toBeGreaterThan(0)
    expect(parsed).toBeLessThanOrEqual(45)
  })

  it("GoUsageLimitError 结构仍优先（muse 与非 muse 一致，直接切号不重试）", () => {
    const body = JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "weekly" } })
    for (const model of [MUSE, "deepseek-v4-flash", undefined]) {
      const result = provider.classifyError(429, body, new Headers(), model)
      expect(result, String(model)).toMatchObject({
        shouldSwitchAccount: true,
        quotaKind: "WEEKLY",
        errorType: "GoUsageLimitError",
      })
      expect(result?.retrySameAccount, String(model)).toBeUndefined()
    }
  })

  it("非 muse 模型 429 行为不变（配额措辞/瞬时限流一律 null，不新增重试或切号）", () => {
    for (const model of ["deepseek-v4-flash", "kimi-k3", "gpt-5.6-luna"]) {
      expect(provider.classifyError(429, "too many concurrent requests", new Headers(), model), model).toBeNull()
      expect(provider.classifyError(429, "insufficient balance, please recharge", new Headers(), model), model).toBeNull()
    }
    // 旧调用（model 缺省）同样保持既有行为
    expect(provider.classifyError(429, "too many concurrent requests", new Headers())).toBeNull()
  })

  it("非 429 状态不受影响：muse 401/403 仍为 AuthenticationError，500 仍为 null", () => {
    expect(provider.classifyError(401, "unauthorized", new Headers(), MUSE))
      .toMatchObject({ shouldSwitchAccount: false, errorType: "AuthenticationError" })
    expect(provider.classifyError(403, "forbidden", new Headers(), MUSE))
      .toMatchObject({ shouldSwitchAccount: false, errorType: "AuthenticationError" })
    expect(provider.classifyError(500, "internal error", new Headers(), MUSE)).toBeNull()
  })
})
