import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommandCodeProvider, parseWindowRateLimit, COMMAND_CODE_RATE_LIMIT_MAX_RETRIES } from "./command-code"
import { decideUpstreamRoute } from "../messages/route-decision"
import type { AccountRecord } from "../types"

// 隔离真实 dev DB（getDatabase 全局单例会读到 data/opencode-gateway.db 的
// provider_model_cache 陈旧缓存），缓存读取路径静默吞错 → 落 DEFAULT 引导目录。
vi.mock("../db", () => ({ getDatabase: () => { throw new Error("db disabled in unit test") } }))

const provider = new CommandCodeProvider()
const stubAccount = { id: "acct-test" } as AccountRecord

beforeEach(() => {
  // readCachedModels 吞掉一切异常返回 null，但内存 mock 计数可断言隔离生效。
  vi.clearAllMocks()
})

function forwardInput(endpoint: string, extraClientHeaders: Record<string, string> = {}, overrides: Partial<Parameters<typeof provider.buildForwardTarget>[0]> = {}) {
  return {
    method: "POST",
    endpoint,
    model: "claude-sonnet-5",
    upstreamModel: "claude-sonnet-5",
    body: new TextEncoder().encode("{}"),
    headers: new Headers({ "user-agent": "curl/8.0.1", ...extraClientHeaders }),
    signal: AbortSignal.timeout(1_000),
    ...overrides,
  }
}

const credential = { token: "user_test_key_abcdef", credentialVersion: 1 }

describe("CommandCodeProvider.buildForwardTarget：单 base URL 拼接与头注入", () => {
  it("chat/completions 与 messages 拼到 /provider/v1 下", () => {
    expect(provider.buildForwardTarget(forwardInput("chat/completions"), credential, stubAccount).url)
      .toBe("https://api.commandcode.ai/provider/v1/chat/completions")
    expect(provider.buildForwardTarget(forwardInput("messages"), credential, stubAccount).url)
      .toBe("https://api.commandcode.ai/provider/v1/messages")
  })

  it("带前导斜杠的 endpoint 规整", () => {
    expect(provider.buildForwardTarget(forwardInput("/chat/completions"), credential, stubAccount).url)
      .toBe("https://api.commandcode.ai/provider/v1/chat/completions")
  })

  it("Authorization Bearer 注入 + POST 带 content-type", () => {
    const target = provider.buildForwardTarget(forwardInput("messages"), credential, stubAccount)
    expect(target.headers.get("authorization")).toBe("Bearer user_test_key_abcdef")
    expect(target.headers.get("content-type")).toBe("application/json")
    expect(target.headers.get("accept")).toBe("application/json, text/event-stream")
  })

  it("白名单头透传（anthropic-version 等），客户端 UA 不透传、无指纹头", () => {
    const target = provider.buildForwardTarget(
      forwardInput("messages", { "anthropic-version": "2023-06-01", "anthropic-beta": "tools-2024-04-04", "accept-language": "zh-CN" }),
      credential,
      stubAccount,
    )
    expect(target.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(target.headers.get("anthropic-beta")).toBe("tools-2024-04-04")
    expect(target.headers.get("accept-language")).toBe("zh-CN")
    // 无指纹要求：不透传 UA 也不伪装固定 UA。
    expect(target.headers.get("user-agent")).toBeNull()
    expect(target.headers.get("x-device-mid")).toBeNull()
    const internalKeys = [...target.headers.keys()].filter((key) => key.startsWith("__"))
    expect(internalKeys).toEqual([])
  })

  it("裸名命中唯一后缀时：upstreamModel ≠ model → 上行 body 的 model 改写为全 ID", () => {
    const body = JSON.stringify({ model: "muse-spark-1.3-contributor", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    const target = provider.buildForwardTarget(
      forwardInput("chat/completions", {}, { model: "muse-spark-1.3-contributor", upstreamModel: "meta/muse-spark-1.3-contributor", body: new TextEncoder().encode(body) }),
      credential,
      stubAccount,
    )
    const parsed = JSON.parse(new TextDecoder().decode(target.body!)) as { model: string }
    expect(parsed.model).toBe("meta/muse-spark-1.3-contributor")
    expect(parsed.max_tokens).toBe(16)
  })

  it("upstreamModel 与 model 一致（全 ID 原样）时不重写 body；非 JSON body 不崩", () => {
    const same = provider.buildForwardTarget(forwardInput("chat/completions"), credential, stubAccount)
    expect(new TextDecoder().decode(same.body!)).toBe("{}")
    const garbage = provider.buildForwardTarget(
      forwardInput("chat/completions", {}, { model: "x", upstreamModel: "p/x", body: new TextEncoder().encode("not-json") }),
      credential,
      stubAccount,
    )
    expect(new TextDecoder().decode(garbage.body!)).toBe("not-json")
  })
})

describe("parseWindowRateLimit：rateLimit.window 结构化解析", () => {
  it("error 嵌套内的 fiveHour/weekly + resetAt", () => {
    expect(parseWindowRateLimit(JSON.stringify({
      success: false,
      error: { code: "RATE_LIMITED", rateLimit: { window: "fiveHour", resetAt: "2026-09-07T15:00:00.000Z" } },
    }))).toEqual({ window: "fiveHour", resetAt: "2026-09-07T15:00:00.000Z" })
    expect(parseWindowRateLimit(JSON.stringify({
      error: { rateLimit: { window: "weekly", resetAt: 1788775200000 } },
    }))).toEqual({ window: "weekly", resetAt: new Date(1788775200000).toISOString() })
  })

  it("顶层 rateLimit 也识别；未知 window 与非 JSON 返回 null", () => {
    expect(parseWindowRateLimit(JSON.stringify({ rateLimit: { window: "fiveHour" } })))
      .toEqual({ window: "fiveHour", resetAt: null })
    expect(parseWindowRateLimit(JSON.stringify({ rateLimit: { window: "monthly" } }))).toBeNull()
    expect(parseWindowRateLimit(JSON.stringify({ error: { message: "no rateLimit" } }))).toBeNull()
    expect(parseWindowRateLimit("plain text")).toBeNull()
    expect(parseWindowRateLimit("")).toBeNull()
  })
})

describe("CommandCodeProvider.classifyError（表驱动）", () => {
  const cases: Array<{
    name: string
    status: number
    body: string
    headers?: Headers
    expected: Record<string, unknown> | null
  }> = [
    {
      name: "401 UNAUTHORIZED 错误体 → AuthenticationError 不切号",
      status: 401,
      body: JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", status: 401 } }),
      expected: { shouldSwitchAccount: false, errorType: "AuthenticationError" },
    },
    {
      name: "403 普通禁止 → AuthenticationError",
      status: 403,
      body: "forbidden",
      expected: { shouldSwitchAccount: false, errorType: "AuthenticationError" },
    },
    {
      name: "403 MODEL_NOT_IN_PLAN（2026-09-08 实测 GOAT 不含 Claude）→ 切号不冷却不标记",
      status: 403,
      body: JSON.stringify({ type: "error", error: { type: "permission_error", message: "MODEL_NOT_IN_PLAN: Claude Sonnet 5 available in Pro and above plans or extra on demand usage" } }),
      expected: { shouldSwitchAccount: true, errorType: "COMMAND_CODE_MODEL_NOT_IN_PLAN" },
    },
    {
      name: "403 geo 限制措辞 → null（透传错误，不切号不标记）",
      status: 403,
      body: JSON.stringify({ error: { message: "Model is not available in your region" } }),
      expected: null,
    },
    {
      name: "429 带 rateLimit.window=fiveHour → 5h 窗耗尽，冷却到 resetAt",
      status: 429,
      body: JSON.stringify({ error: { code: "RATE_LIMITED", rateLimit: { window: "fiveHour", resetAt: new Date(Date.now() + 3600_000).toISOString() } } }),
      expected: { shouldSwitchAccount: true, quotaKind: "FIVE_HOUR", errorType: "COMMAND_CODE_WINDOW_EXHAUSTED" },
    },
    {
      name: "429 带 rateLimit.window=weekly → 周窗耗尽",
      status: 429,
      body: JSON.stringify({ error: { rateLimit: { window: "weekly", resetAt: new Date(Date.now() + 86400_000).toISOString() } } }),
      expected: { shouldSwitchAccount: true, quotaKind: "WEEKLY", errorType: "COMMAND_CODE_WINDOW_EXHAUSTED" },
    },
    {
      name: "400 declined 形态带窗口标记 → 同样按窗口耗尽处理",
      status: 400,
      body: JSON.stringify({ error: { type: "declined", rateLimit: { window: "fiveHour" } } }),
      expected: { shouldSwitchAccount: true, quotaKind: "FIVE_HOUR", errorType: "COMMAND_CODE_WINDOW_EXHAUSTED" },
    },
    {
      name: "402 无窗口标记 → 套餐/配额类切号",
      status: 402,
      body: "payment required",
      expected: { shouldSwitchAccount: true, quotaKind: "WEEKLY", errorType: "COMMAND_CODE_QUOTA_EXCEEDED" },
    },
    {
      name: "429 无窗口标记 → 瞬时限流同号退避",
      status: 429,
      body: "too many requests",
      expected: {
        shouldSwitchAccount: true,
        retrySameAccount: { maxRetries: COMMAND_CODE_RATE_LIMIT_MAX_RETRIES },
        quotaKind: "PROVIDER_RATE_LIMIT",
        errorType: "COMMAND_CODE_RATE_LIMITED",
      },
    },
    {
      name: "500 → null",
      status: 500,
      body: "oops",
      expected: null,
    },
    {
      name: "200 → null",
      status: 200,
      body: "ok",
      expected: null,
    },
  ]

  for (const { name, status, body, headers, expected } of cases) {
    it(name, () => {
      const result = provider.classifyError(status, body, headers ?? new Headers())
      if (expected === null) {
        expect(result).toBeNull()
      } else {
        expect(result).toMatchObject(expected)
      }
    })
  }

  it("MODEL_NOT_IN_PLAN 不携带 quotaKind（不落任何冷却窗口）", () => {
    const result = provider.classifyError(
      403,
      JSON.stringify({ error: { type: "permission_error", message: "MODEL_NOT_IN_PLAN: Claude Sonnet 5 available in Pro and above plans" } }),
      new Headers(),
    )
    expect(result?.quotaKind).toBeUndefined()
    expect(result?.retrySameAccount).toBeUndefined()
  })

  it("超窗冷却时间由 resetAt 决定（≈1 小时后重置 → ≈3600s）", () => {
    const resetAt = new Date(Date.now() + 3600_000).toISOString()
    const result = provider.classifyError(429, JSON.stringify({ error: { rateLimit: { window: "fiveHour", resetAt } } }), new Headers())
    expect(result?.retryAfterSeconds).toBeGreaterThan(3500)
    expect(result?.retryAfterSeconds).toBeLessThanOrEqual(3600)
  })

  it("超窗缺 resetAt 时回落 retry-after 头，再兜底 60s", () => {
    const withHeader = provider.classifyError(
      429,
      JSON.stringify({ error: { rateLimit: { window: "weekly" } } }),
      new Headers({ "retry-after": "17" }),
    )
    expect(withHeader?.retryAfterSeconds).toBe(17)
    const fallback = provider.classifyError(429, JSON.stringify({ error: { rateLimit: { window: "weekly" } } }), new Headers())
    expect(fallback?.retryAfterSeconds).toBe(60)
  })

  it("瞬时 429 透传 retry-after 头", () => {
    const result = provider.classifyError(429, "rate limited", new Headers({ "retry-after": "9" }))
    expect(result?.retryAfterSeconds).toBe(9)
  })
})

describe("CommandCodeProvider 接口与模型", () => {
  it("supportedInterfaces 摘掉 messages（实测 messages 端点只收 Claude 系、GOAT 套餐无 Claude 会 403）统一只声明 chat", () => {
    for (const model of [
      "meta/muse-spark-1.3-contributor",
      "deepseek/deepseek-v4-flash",
      "moonshotai/Kimi-K3",
      "claude-sonnet-5",
      "Claude-Opus-4-8",
    ]) {
      expect(provider.supportedInterfaces(model), model).toEqual(["chat"])
    }
    // /responses 404 不存在、messages 已摘：任何模型都不声明 messages / responses。
    for (const model of ["claude-sonnet-5", "meta/muse-spark-1.3-contributor"]) {
      expect(provider.supportedInterfaces(model)).not.toContain("responses")
      expect(provider.supportedInterfaces(model)).not.toContain("messages")
    }
  })

  it("messages 入口：决策管线自动接力 messages->chat 上行至 chat/completions", () => {
    const route = decideUpstreamRoute("messages", provider.supportedInterfaces("meta/muse-spark-1.3-contributor"))!
    expect(route).toMatchObject({
      upstreamEndpoint: "chat/completions",
      requestChain: ["messages->chat"],
      native: false,
      reason: "messages_to_chat",
    })
    // chat 入口仍原生直通，不做转换（对齐 1eb8a43 的 omen-alpha 语义）。
    const chatRoute = decideUpstreamRoute("chat", provider.supportedInterfaces("meta/muse-spark-1.3-contributor"))!
    expect(chatRoute).toMatchObject({ upstreamEndpoint: "chat/completions", requestChain: [], native: true, reason: "chat_native" })
    // responses 入口：上游 404 不存在 → 经 responses->chat 上行。
    const responsesRoute = decideUpstreamRoute("responses", provider.supportedInterfaces("meta/muse-spark-1.3-contributor"))!
    expect(responsesRoute).toMatchObject({ upstreamEndpoint: "chat/completions", requestChain: ["responses->chat"], native: false, reason: "responses_to_chat" })
  })

  it("quota kinds = FIVE_HOUR + WEEKLY + MONTHLY（三窗：双窗 + 余额窗）", () => {
    expect(provider.supportedQuotaKinds()).toEqual(["FIVE_HOUR", "WEEKLY", "MONTHLY"])
  })

  it("默认引导目录（REMOTE 同步前，含实测可用的 muse）", () => {
    const models = provider.getDefaultModels()
    expect(models).toEqual(expect.arrayContaining([
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "deepseek/deepseek-v4-pro",
      "meta/muse-spark-1.3-contributor",
    ]))
  })

  it("resolveModel：精确命中原样透传（含带斜杠 ID）", () => {
    expect(provider.resolveModel(stubAccount, "deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash")
    expect(provider.resolveModel(stubAccount, "moonshotai/Kimi-K3")).toBe("moonshotai/Kimi-K3")
  })

  it("resolveModel：裸名唯一后缀命中 → 全 ID（引导目录含 muse）", () => {
    expect(provider.resolveModel(stubAccount, "muse-spark-1.3-contributor")).toBe("meta/muse-spark-1.3-contributor")
    expect(provider.resolveModel(stubAccount, "deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro")
  })

  it("resolveModel：未知裸名 → 原样透传（目录缺项时交给上游兜底校验）", () => {
    expect(provider.resolveModel(stubAccount, "brand-new-model")).toBe("brand-new-model")
    expect(provider.resolveModel(stubAccount, "unknown/model-x")).toBe("unknown/model-x")
    expect(provider.resolveModel(stubAccount, "")).toBe("")
  })

  it("getUpstreamBaseUrl 返回单 base", () => {
    expect(provider.getUpstreamBaseUrl(stubAccount)).toBe("https://api.commandcode.ai/provider/v1")
  })
})
