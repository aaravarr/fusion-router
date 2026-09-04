import { describe, expect, it } from "vitest"
import { GlmCodingProvider } from "./glm-coding"
import { createZcodeIdentityHeaders, parseGlmQuotaPayload, windowsFromGlmQuota, glmBaseForEndpoint, type GlmRegion } from "../glm-coding"
import type { AccountRecord } from "../types"

const provider = new GlmCodingProvider()
const stubAccount = { id: "acct-test" } as AccountRecord

function forwardInput(endpoint: string, extraClientHeaders: Record<string, string> = {}) {
  return {
    method: "POST",
    endpoint,
    model: "glm-5.3",
    upstreamModel: "glm-5.3",
    body: new TextEncoder().encode("{}"),
    headers: new Headers({ "user-agent": "curl/8.0.1", ...extraClientHeaders }),
    signal: AbortSignal.timeout(1_000),
  }
}

function credential(region: GlmRegion, deviceMid = "a".repeat(32)) {
  return {
    token: "key-id.secret-value",
    extraHeaders: { __glmRegion: region, __glmDeviceMid: deviceMid },
    credentialVersion: 1,
  }
}

describe("GlmCodingProvider.buildForwardTarget：三 endpoint × cn/global base_url 映射", () => {
  const cases: Array<{ endpoint: string; cn: string; global: string }> = [
    {
      endpoint: "chat/completions",
      cn: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
      global: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    },
    {
      // responses 不在 coding 路径下（2026-09-04 实测）。
      endpoint: "responses",
      cn: "https://open.bigmodel.cn/api/v1/responses",
      global: "https://api.z.ai/api/v1/responses",
    },
    {
      endpoint: "messages",
      cn: "https://open.bigmodel.cn/api/anthropic/v1/messages",
      global: "https://api.z.ai/api/anthropic/v1/messages",
    },
  ]

  for (const { endpoint, cn, global } of cases) {
    it(`maps ${endpoint} for cn`, () => {
      const target = provider.buildForwardTarget(forwardInput(endpoint), credential("cn"), stubAccount)
      expect(target.url).toBe(cn)
    })
    it(`maps ${endpoint} for global`, () => {
      const target = provider.buildForwardTarget(forwardInput(endpoint), credential("global"), stubAccount)
      expect(target.url).toBe(global)
    })
  }

  it("Authorization uses Bearer credential token on every endpoint", () => {
    for (const endpoint of ["chat/completions", "responses", "messages"]) {
      const target = provider.buildForwardTarget(forwardInput(endpoint), credential("cn"), stubAccount)
      expect(target.headers.get("authorization")).toBe("Bearer key-id.secret-value")
    }
  })

  it("未知 endpoint 退回 chat 主址", () => {
    const target = provider.buildForwardTarget(forwardInput("some/other"), credential("cn"), stubAccount)
    expect(target.url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/some/other")
  })
})

describe("GlmCodingProvider.buildForwardTarget：ZCode 指纹头注入且覆盖客户端 UA", () => {
  const target = provider.buildForwardTarget(
    forwardInput("chat/completions", { "anthropic-version": "2023-06-01", "accept-language": "en-US" }),
    credential("cn", "deadbeef".repeat(4)),
    stubAccount,
  )
  const headers = target.headers

  it("注入 ZCode 3.9.1 全套指纹头", () => {
    expect(headers.get("user-agent")).toBe("ZCode/3.9.1")
    expect(headers.get("http-referer")).toBe("https://zcode.z.ai")
    expect(headers.get("x-title")).toBe("Z Code@electron")
    expect(headers.get("x-zcode-app-version")).toBe("3.9.1")
    expect(headers.get("x-platform")).toBe("win32-x64")
    expect(headers.get("x-os-category")).toBe("windows")
    expect(headers.get("x-release-channel")).toBe("production")
    expect(headers.get("x-client-language")).toBe("zh-CN")
    expect(headers.get("x-client-timezone")).toMatch(/^(?:[A-Za-z_]+\/[A-Za-z_+\-]+|UTC[+-]\d+)$/)
    expect(headers.get("x-device-mid")).toBe("deadbeef".repeat(4))
    expect(headers.get("x-session-id")).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("覆盖客户端 UA（不透传 curl UA）", () => {
    expect(headers.get("user-agent")).not.toBe("curl/8.0.1")
  })

  it("passthrough anthropic-version/accept-language 但不改写指纹", () => {
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("accept-language")).toBe("en-US")
    expect(headers.get("user-agent")).toBe("ZCode/3.9.1")
  })

  it("x-request-id 每请求唯一", () => {
    const first = provider.buildForwardTarget(forwardInput("chat/completions"), credential("cn"), stubAccount)
    const second = provider.buildForwardTarget(forwardInput("chat/completions"), credential("cn"), stubAccount)
    expect(first.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"))
  })

  it("内部透传键（__glmRegion 等）不会出现在上游请求头中", () => {
    const internalKeys = [...headers.keys()].filter((key) => key.startsWith("__"))
    expect(internalKeys).toEqual([])
  })
})

describe("GlmCodingProvider.classifyError", () => {
  it("maps 401/403 to AuthenticationError without switching", () => {
    expect(provider.classifyError(401, "invalid api key", new Headers()))
      .toMatchObject({ shouldSwitchAccount: false, errorType: "AuthenticationError" })
    expect(provider.classifyError(403, "forbidden", new Headers()))
      .toMatchObject({ shouldSwitchAccount: false, errorType: "AuthenticationError" })
  })

  it("maps 402 to GLM_QUOTA_EXCEEDED (billing/plan class)", () => {
    expect(provider.classifyError(402, "payment required", new Headers()))
      .toMatchObject({ shouldSwitchAccount: true, quotaKind: "WEEKLY", errorType: "GLM_QUOTA_EXCEEDED" })
  })

  it("maps 429 with quota/billing wording to GLM_QUOTA_EXCEEDED", () => {
    expect(provider.classifyError(429, JSON.stringify({
      error: { code: "1113", message: "insufficient balance, please recharge" },
    }), new Headers())).toMatchObject({ shouldSwitchAccount: true, errorType: "GLM_QUOTA_EXCEEDED" })
    expect(provider.classifyError(429, "Your account is in arrears", new Headers()))
      .toMatchObject({ errorType: "GLM_QUOTA_EXCEEDED" })
    expect(provider.classifyError(429, "套餐额度已用完", new Headers()))
      .toMatchObject({ errorType: "GLM_QUOTA_EXCEEDED" })
  })

  it("keeps plain 429 as transient concurrency rate limit with same-account retries", () => {
    const result = provider.classifyError(429, "too many concurrent requests", new Headers())
    expect(result).toMatchObject({
      shouldSwitchAccount: true,
      retrySameAccount: { maxRetries: 6 },
      quotaKind: "PROVIDER_RATE_LIMIT",
      errorType: "GLM_RATE_LIMITED",
    })
  })

  it("honors retry-after header on 429", () => {
    const result = provider.classifyError(429, "rate limited", new Headers({ "retry-after": "17" }))
    expect(result?.retryAfterSeconds).toBe(17)
  })

  it("returns null for unrelated statuses", () => {
    expect(provider.classifyError(500, "oops", new Headers())).toBeNull()
    expect(provider.classifyError(200, "ok", new Headers())).toBeNull()
    expect(provider.classifyError(400, "bad request", new Headers())).toBeNull()
  })
})

describe("GlmCodingProvider 接口与模型", () => {
  it("三接口格式全原生声明", () => {
    expect(provider.supportedInterfaces()).toEqual(["chat", "messages", "responses"])
  })

  it("默认模型目录含 glm-5.3 系与 [1m] 变体", () => {
    expect(provider.getDefaultModels()).toEqual(
      expect.arrayContaining(["glm-5.3", "glm-5.3-flash", "glm-5.3[1m]", "glm-5.3-flash[1m]"]),
    )
  })

  it("quota kinds = 5h + weekly", () => {
    expect(provider.supportedQuotaKinds()).toEqual(["FIVE_HOUR", "WEEKLY"])
  })
})

describe("GLM quota 映射（实测响应样例 2026-09-04）", () => {
  // GET /api/monitor/usage/quota/limit 真实响应（脱敏）。
  const payload = parseGlmQuotaPayload({
    code: 200,
    data: {
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 4422, remaining: 7577, percentage: 36, nextResetTime: 1788504305572 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 10155, remaining: 49844, percentage: 16, nextResetTime: 1788923564994 },
      ],
      level: "pro",
    },
    success: true,
  })

  it("解析 limits 与 level", () => {
    expect(payload).not.toBeNull()
    expect(payload!.limits).toHaveLength(2)
    expect(payload!.level).toBe("pro")
  })

  it("unit=3 → FIVE_HOUR、unit=6 → WEEKLY；percentage → usagePercent；nextResetTime → resetAt", () => {
    const now = 1788400000000
    const windows = windowsFromGlmQuota(payload!, now)
    expect(windows).toHaveLength(2)
    const fiveHour = windows.find((w) => w.kind === "FIVE_HOUR")
    const weekly = windows.find((w) => w.kind === "WEEKLY")
    expect(fiveHour).toMatchObject({
      usagePercent: 36,
      limitValue: 12000,
      remainingValue: 7577,
      resetAt: new Date(1788504305572).toISOString(),
      source: "API_PROBE",
    })
    expect(weekly).toMatchObject({ usagePercent: 16, limitValue: 60000, remainingValue: 49844 })
    // percentage 语义与网关阻塞口径（usage_percent >= 100 阻塞）同向。
    expect(fiveHour!.usagePercent).toBeLessThan(100)
    // level 挂 extra 透传。
    expect(fiveHour!.extra).toEqual({ level: "pro" })
  })

  it("未知 unit 的窗口被忽略", () => {
    const windows = windowsFromGlmQuota({
      level: "",
      limits: [{ type: "CREDIT_LIMIT", unit: 9, number: 1, usage: 1, currentValue: 0, remaining: 1, percentage: 0, nextResetTime: 1788504305572 }],
    })
    expect(windows).toEqual([])
  })

  it("重复 unit 只保留首个窗口", () => {
    const windows = windowsFromGlmQuota({
      level: "",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 50, remaining: 50, percentage: 50, nextResetTime: 1788504305572 },
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 90, remaining: 10, percentage: 90, nextResetTime: 1788504305572 },
      ],
    })
    expect(windows).toHaveLength(1)
    expect(windows[0].usagePercent).toBe(50)
  })
})

describe("createZcodeIdentityHeaders", () => {
  it("deviceMid 缺省时省略 X-Device-Mid", () => {
    const headers = createZcodeIdentityHeaders({})
    expect(headers["X-Device-Mid"]).toBeUndefined()
    expect(headers["User-Agent"]).toBe("ZCode/3.9.1")
  })

  it("同一进程内 X-Session-Id 稳定（进程级 session）", () => {
    const a = createZcodeIdentityHeaders({ sessionId: null })
    const b = createZcodeIdentityHeaders({})
    expect(a["X-Session-Id"]).toBeTruthy()
    expect(a["X-Session-Id"]).toBe(b["X-Session-Id"])
  })
})

describe("glmBaseForEndpoint", () => {
  it("未知 endpoint 返回 null", () => {
    expect(glmBaseForEndpoint("models", "cn")).toBeNull()
  })
  it("带前导斜杠的 endpoint 也能映射", () => {
    expect(glmBaseForEndpoint("/responses", "cn")).toBe("https://open.bigmodel.cn/api/v1")
  })
})
