import { describe, expect, it } from "vitest"
import {
  commandCodeExternalId,
  isValidCommandCodeApiKeyShape,
  matchCommandCodeModel,
  parseCommandCodeModels,
  parseCommandCodeUsage,
  parseCommandCodeWhoami,
  windowsFromCommandCodeUsage,
} from "./command-code"

describe("parseCommandCodeWhoami（2026-09-08 持 key 实测结构）", () => {
  it("实测形态：{success, user: {id, name, email, userName}, org}", () => {
    // 摘自 2026-09-08 实测 GET /alpha/whoami 200（字段值脱敏）。
    expect(parseCommandCodeWhoami({
      success: true,
      user: { id: "e13b5659-ec80-4197-8cbd-80da433084d8", name: "someone", email: "someone@example.com", userName: "someone" },
      org: null,
    })).toEqual({ userId: "e13b5659-ec80-4197-8cbd-80da433084d8", plan: "", email: "someone@example.com" })
  })

  it("实测结构无 plan 字段：plan 恒为空串", () => {
    const whoami = parseCommandCodeWhoami({ success: true, user: { id: "u_1" }, org: null })
    expect(whoami?.plan).toBe("")
  })

  it("兼容扁平形态（user_id/userId/id 直键）", () => {
    expect(parseCommandCodeWhoami({ user_id: "u_123", plan: "goat", email: "a@b.c" }))
      .toEqual({ userId: "u_123", plan: "goat", email: "a@b.c" })
    expect(parseCommandCodeWhoami({ data: { userId: "u_9", planType: "goat" } }))
      .toEqual({ userId: "u_9", plan: "goat", email: null })
    expect(parseCommandCodeWhoami({ id: "u_x" })).toEqual({ userId: "u_x", plan: "", email: null })
  })

  it("无用户标识或垃圾输入返回 null", () => {
    expect(parseCommandCodeWhoami(null)).toBeNull()
    expect(parseCommandCodeWhoami("str")).toBeNull()
    expect(parseCommandCodeWhoami([])).toBeNull()
    expect(parseCommandCodeWhoami({ success: true })).toBeNull()
    expect(parseCommandCodeWhoami({ user: "not-object" })).toBeNull()
    expect(parseCommandCodeWhoami({ data: "not-object" })).toBeNull()
  })
})

describe("parseCommandCodeUsage（2026-09-08 持 key 实测：账期累计口径，无双窗）", () => {
  it("解析实测响应样例（periodBasis=billing-period）", () => {
    // 摘自 2026-09-08 实测 GET /alpha/usage/summary 200。
    const usage = parseCommandCodeUsage({
      totalCount: 37,
      totalCost: 1.1409038200000001,
      averageCost: 0.03083523837837838,
      successRate: 100,
      completedCount: 37,
      failedCount: 0,
      totalTokensIn: 3263702,
      totalTokensOut: 20440,
      totalTokens: 3284142,
      totalCredits: 1.1409038200000001,
      totalFreeCredits: 0,
      totalMonthlyCredits: 1.1409038200000001,
      totalPurchasedCredits: 0,
      periodBasis: "billing-period",
    })
    expect(usage.totalCount).toBe(37)
    expect(usage.completedCount).toBe(37)
    expect(usage.failedCount).toBe(0)
    expect(usage.totalCredits).toBeCloseTo(1.1409038200000001)
    expect(usage.totalFreeCredits).toBe(0)
    expect(usage.totalMonthlyCredits).toBeCloseTo(1.1409038200000001)
    expect(usage.totalPurchasedCredits).toBe(0)
    expect(usage.totalTokens).toBe(3284142)
    expect(usage.totalTokensIn).toBe(3263702)
    expect(usage.totalTokensOut).toBe(20440)
    expect(usage.periodBasis).toBe("billing-period")
  })

  it("data envelope / 字符串数值字段宽容解析", () => {
    const usage = parseCommandCodeUsage({
      data: { totalCredits: "12.5", totalCount: "9", periodBasis: "billing-period" },
    })
    expect(usage.totalCredits).toBe(12.5)
    expect(usage.totalCount).toBe(9)
    expect(usage.totalTokens).toBe(0)
    expect(usage.periodBasis).toBe("billing-period")
  })

  it("缺字段/垃圾输入不崩：全部数值落 0", () => {
    expect(parseCommandCodeUsage(null).totalCredits).toBe(0)
    expect(parseCommandCodeUsage([]).periodBasis).toBe("")
    expect(parseCommandCodeUsage("oops")).toEqual({
      totalCount: 0, completedCount: 0, failedCount: 0,
      totalCredits: 0, totalFreeCredits: 0, totalMonthlyCredits: 0, totalPurchasedCredits: 0,
      totalTokens: 0, totalTokensIn: 0, totalTokensOut: 0,
      periodBasis: "",
    })
  })
})

describe("windowsFromCommandCodeUsage（账期累计 → 单 MONTHLY 信息窗）", () => {
  it("MONTHLY 单窗：usagePercent 固定 0（绝不落 100 误触发路由拉黑），credits/tokens 挂 extra", () => {
    const now = Date.parse("2026-09-08T10:00:00.000Z")
    const windows = windowsFromCommandCodeUsage({
      totalCount: 37,
      completedCount: 37,
      failedCount: 0,
      totalCredits: 1.14,
      totalFreeCredits: 0,
      totalMonthlyCredits: 1.14,
      totalPurchasedCredits: 0,
      totalTokens: 3284142,
      totalTokensIn: 3263702,
      totalTokensOut: 20440,
      periodBasis: "billing-period",
    }, now)
    expect(windows).toHaveLength(1)
    const window = windows[0]
    expect(window.kind).toBe("MONTHLY")
    expect(window.usagePercent).toBe(0)
    expect(window.limitValue).toBeNull()
    expect(window.remainingValue).toBeNull()
    expect(window.resetAt).toBeNull()
    expect(window.resetInSeconds).toBeNull()
    expect(window.source).toBe("API_PROBE")
    expect(window.unit).toBe("credits")
    expect(window.extra).toMatchObject({
      service: "command-code",
      periodBasis: "billing-period",
      totalCredits: 1.14,
      totalCount: 37,
      totalTokens: 3284142,
    })
    expect(window.lastObservedAt).toBe("2026-09-08T10:00:00.000Z")
  })

  it("零用量账号也产出窗口（信息性展示）", () => {
    const windows = windowsFromCommandCodeUsage({
      totalCount: 0, completedCount: 0, failedCount: 0,
      totalCredits: 0, totalFreeCredits: 0, totalMonthlyCredits: 0, totalPurchasedCredits: 0,
      totalTokens: 0, totalTokensIn: 0, totalTokensOut: 0,
      periodBasis: "",
    })
    expect(windows).toHaveLength(1)
    expect(windows[0].usagePercent).toBe(0)
  })
})

describe("matchCommandCodeModel（裸名 → 全 ID 三态匹配）", () => {
  const catalog = [
    "claude-sonnet-5",
    "claude-opus-5",
    "gpt-5.6-sol",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "meta/muse-spark-1.3-contributor",
    "moonshotai/Kimi-K3",
    "zai-org/GLM-5.3",
  ]

  it("EXACT：带斜杠全 ID 原样命中（返回目录内原始大小写）", () => {
    expect(matchCommandCodeModel("deepseek/deepseek-v4-flash", catalog))
      .toEqual({ kind: "EXACT", matched: "deepseek/deepseek-v4-flash" })
    expect(matchCommandCodeModel("meta/muse-spark-1.3-contributor", catalog))
      .toEqual({ kind: "EXACT", matched: "meta/muse-spark-1.3-contributor" })
  })

  it("EXACT：不带前缀的全 ID（目录中本就无斜杠的模型）也算精确命中", () => {
    expect(matchCommandCodeModel("claude-sonnet-5", catalog))
      .toEqual({ kind: "EXACT", matched: "claude-sonnet-5" })
  })

  it("EXACT：大小写不敏感（目录观测到混合大小写，如 moonshotai/Kimi-K3）", () => {
    expect(matchCommandCodeModel("moonshotai/kimi-k3", catalog))
      .toEqual({ kind: "EXACT", matched: "moonshotai/Kimi-K3" })
    expect(matchCommandCodeModel("Deepseek/Deepseek-V4-Flash", catalog))
      .toEqual({ kind: "EXACT", matched: "deepseek/deepseek-v4-flash" })
  })

  it("UNIQUE_SUFFIX：裸名唯一命中 → 映射到全 ID（muse-spark-1.3-contributor → meta/...）", () => {
    expect(matchCommandCodeModel("muse-spark-1.3-contributor", catalog))
      .toEqual({ kind: "UNIQUE_SUFFIX", matched: "meta/muse-spark-1.3-contributor" })
    expect(matchCommandCodeModel("deepseek-v4-pro", catalog))
      .toEqual({ kind: "UNIQUE_SUFFIX", matched: "deepseek/deepseek-v4-pro" })
    expect(matchCommandCodeModel("KIMI-K3", catalog))
      .toEqual({ kind: "UNIQUE_SUFFIX", matched: "moonshotai/Kimi-K3" })
  })

  it("UNIQUE_SUFFIX：变体模型不抢基座裸名（deepseek-v4-flash 唯一同段后缀命中，-vision-exp/-fast 是不同段）", () => {
    // 2026-09-08 实测目录：deepseek/deepseek-v4-flash{-vision-exp,-fast} 三个变体并存，
    // 但裸名 "deepseek-v4-flash" 的「/」完整段后缀只有一个候选 → 唯一命中基座。
    const variants = [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4-flash-fast",
    ]
    expect(matchCommandCodeModel("deepseek-v4-flash", variants))
      .toEqual({ kind: "UNIQUE_SUFFIX", matched: "deepseek/deepseek-v4-flash" })
  })

  it("AMBIGUOUS：多个 {provider}/{真同名} 候选（不同 provider 前缀、同段同名）", () => {
    const ambiguousCatalog = [
      "z-ai/glm-5.3-flash",
      "foo/glm-5.3-flash",
      "zai-org/GLM-5.3",
      "deepseek/deepseek-v4-pro",
    ]
    expect(matchCommandCodeModel("glm-5.3-flash", ambiguousCatalog))
      .toEqual({
        kind: "AMBIGUOUS",
        matched: null,
        candidates: ["foo/glm-5.3-flash", "z-ai/glm-5.3-flash"],
      })
  })

  it("MISS：带斜杠但目录无此 ID 不做后缀匹配；裸名零候选；空串", () => {
    expect(matchCommandCodeModel("nope/model-x", catalog))
      .toEqual({ kind: "MISS", matched: null, candidates: [] })
    expect(matchCommandCodeModel("totally-unknown", catalog))
      .toEqual({ kind: "MISS", matched: null, candidates: [] })
    expect(matchCommandCodeModel("", catalog))
      .toEqual({ kind: "MISS", matched: null, candidates: [] })
    expect(matchCommandCodeModel("  ", catalog).kind).toBe("MISS")
  })

  it("后缀匹配按完整段（不认子串），忽略无斜杠目录项", () => {
    const tricky = ["gpt-5.6-sol", "meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor", "weird/trailing-/"]
    // "muse-spark-1.3" 不得命中 "meta/muse-spark-1.3-contributor"（子串≠后缀）。
    expect(matchCommandCodeModel("muse-spark-1.3", tricky))
      .toEqual({ kind: "UNIQUE_SUFFIX", matched: "meta/muse-spark-1.3" })
    expect(matchCommandCodeModel("", tricky).kind).toBe("MISS")
  })

  it("空目录：带斜杠与裸名均只能 MISS（无目录无法做后缀判断）", () => {
    expect(matchCommandCodeModel("meta/muse-spark-1.3-contributor", []))
      .toEqual({ kind: "MISS", matched: null, candidates: [] })
    expect(matchCommandCodeModel("muse-spark-1.3-contributor", []).kind).toBe("MISS")
  })
})

describe("parseCommandCodeModels（/provider/v1/models 免 key，2026-09-08 实测结构）", () => {
  it("解析实测响应样例（OpenAI list 形，含带斜杠 ID）", () => {
    // 摘自 2026-09-08 实测 GET https://api.commandcode.ai/provider/v1/models（免 key 200）。
    const sample = JSON.stringify({
      object: "list",
      data: [
        { id: "claude-sonnet-5", object: "model", created: 1788775172, owned_by: "command-code", name: "Claude Sonnet 5", context_length: 1000000 },
        { id: "deepseek/deepseek-v4-flash", object: "model", created: 1788775172, owned_by: "command-code", name: "DeepSeek V4 Flash (latest)", context_length: 1000000 },
        { id: "meta/muse-spark-1.3-contributor", object: "model", created: 1788832408, owned_by: "command-code", name: "Muse Spark 1.3 Contributor", context_length: 1000000 },
        { id: "moonshotai/Kimi-K3", object: "model", created: 1788775172, owned_by: "command-code", name: "Kimi K3", context_length: 1000000 },
        { id: "zai-org/GLM-5.3", object: "model", created: 1788775172, owned_by: "command-code", name: "GLM-5.3", context_length: 1000000 },
      ],
    })
    const models = parseCommandCodeModels(sample)
    expect(models).toContain("claude-sonnet-5")
    expect(models).toContain("deepseek/deepseek-v4-flash")
    expect(models).toContain("meta/muse-spark-1.3-contributor")
    expect(models).toContain("moonshotai/Kimi-K3")
    expect(models).toContain("zai-org/GLM-5.3")
    // 排序输出（uniqueSorted 语义）。
    expect([...models].sort((a, b) => a.localeCompare(b))).toEqual(models)
  })

  it("数组形态 / models 键 / 字符串元素 / name 兜底 均接受", () => {
    expect(parseCommandCodeModels(JSON.stringify(["a", "b"]))).toEqual(["a", "b"])
    expect(parseCommandCodeModels(JSON.stringify({ models: [{ id: "x" }] }))).toEqual(["x"])
    expect(parseCommandCodeModels(JSON.stringify({ data: [{ name: "no-id" }] }))).toEqual(["no-id"])
  })

  it("去重且忽略空/非法元素；非 JSON 返回 []", () => {
    expect(parseCommandCodeModels(JSON.stringify({ data: [{ id: "a" }, { id: "a" }, { id: " " }, 42, null, {}] }))).toEqual(["a"])
    expect(parseCommandCodeModels("not json")).toEqual([])
    expect(parseCommandCodeModels("")).toEqual([])
    expect(parseCommandCodeModels(JSON.stringify({ data: {} }))).toEqual([])
  })
})

describe("isValidCommandCodeApiKeyShape / commandCodeExternalId", () => {
  it("user_ 形态与一般长 token 均通过；过短/非法字符拒绝", () => {
    expect(isValidCommandCodeApiKeyShape("user_abcdef123456")).toBe(true)
    expect(isValidCommandCodeApiKeyShape("abcd1234efgh5678")).toBe(true)
    expect(isValidCommandCodeApiKeyShape("short")).toBe(false)
    expect(isValidCommandCodeApiKeyShape("bad key with spaces")).toBe(false)
    expect(isValidCommandCodeApiKeyShape("")).toBe(false)
  })

  it("externalId 为稳定 24 位 hex 且按 key 区分", () => {
    const a = commandCodeExternalId("user_abc123456789")
    expect(a).toMatch(/^[0-9a-f]{24}$/)
    expect(commandCodeExternalId("user_abc123456789")).toBe(a)
    expect(commandCodeExternalId("user_xyz987654321")).not.toBe(a)
  })
})
