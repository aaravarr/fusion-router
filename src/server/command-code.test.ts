import { describe, expect, it } from "vitest"
import {
  commandCodeExternalId,
  isValidCommandCodeApiKeyShape,
  parseCommandCodeModels,
  parseCommandCodeUsage,
  parseCommandCodeWhoami,
  windowsFromCommandCodeUsage,
} from "./command-code"

describe("parseCommandCodeWhoami（/alpha/whoami 契约待实测，宽容解析）", () => {
  it("扁平形态摘 userId/plan/email", () => {
    expect(parseCommandCodeWhoami({ user_id: "u_123", plan: "goat", email: "a@b.c" }))
      .toEqual({ userId: "u_123", plan: "goat", email: "a@b.c" })
  })

  it("data envelope 形态 + camelCase 键", () => {
    expect(parseCommandCodeWhoami({ data: { userId: "u_9", planType: "goat" } }))
      .toEqual({ userId: "u_9", plan: "goat", email: null })
  })

  it("id 兜底为 userId；缺 email/plan 不崩", () => {
    expect(parseCommandCodeWhoami({ id: "u_x" })).toEqual({ userId: "u_x", plan: "", email: null })
  })

  it("无用户标识或垃圾输入返回 null", () => {
    expect(parseCommandCodeWhoami(null)).toBeNull()
    expect(parseCommandCodeWhoami("str")).toBeNull()
    expect(parseCommandCodeWhoami([])).toBeNull()
    expect(parseCommandCodeWhoami({ plan: "goat" })).toBeNull()
    expect(parseCommandCodeWhoami({ data: "not-object" })).toBeNull()
  })
})

describe("parseCommandCodeUsage（/alpha/usage/summary 契约待实测，宽容解析）", () => {
  it("直键形态：fiveHour + weekly + plan", () => {
    const usage = parseCommandCodeUsage({
      plan: "goat",
      fiveHour: { used: 5, cap: 14, resetAt: "2026-09-07T15:00:00.000Z" },
      weekly: { used: 10, cap: 35, resetAt: "2026-09-14T00:00:00.000Z" },
    })
    expect(usage.plan).toBe("goat")
    expect(usage.fiveHour).toEqual({ used: 5, cap: 14, resetAt: "2026-09-07T15:00:00.000Z" })
    expect(usage.weekly).toEqual({ used: 10, cap: 35, resetAt: "2026-09-14T00:00:00.000Z" })
  })

  it("data envelope + 下划线键 + limit 别名 + 数字串字段", () => {
    const usage = parseCommandCodeUsage({
      data: {
        planType: "goat",
        five_hour: { used: "3", limit: "14", reset_at: "1788775200000" },
        week: { used: 1, cap: 35 },
      },
    })
    expect(usage.plan).toBe("goat")
    expect(usage.fiveHour).toEqual({ used: 3, cap: 14, resetAt: new Date(1788775200000).toISOString() })
    expect(usage.weekly).toEqual({ used: 1, cap: 35, resetAt: null })
  })

  it("秒时间戳（数字与字符串）也能解析为 resetAt", () => {
    const usage = parseCommandCodeUsage({ fiveHour: { used: 1, cap: 14, resetAt: 1788775200 } })
    expect(usage.fiveHour?.resetAt).toBe(new Date(1788775200 * 1000).toISOString())
  })

  it("数组形态：windows / usage.windows 按 window 标记分拣", () => {
    const byWindows = parseCommandCodeUsage({
      plan: "goat",
      windows: [
        { window: "fiveHour", used: 2, cap: 14, resetAt: "2026-09-07T15:00:00.000Z" },
        { window: "weekly", used: 8, cap: 35 },
      ],
    })
    expect(byWindows.fiveHour?.used).toBe(2)
    expect(byWindows.weekly?.cap).toBe(35)

    const byUsageWindows = parseCommandCodeUsage({
      usage: { windows: [{ name: "5h", used: 4, cap: 14 }, { kind: "week", used: 9, cap: 35 }] },
    })
    expect(byUsageWindows.fiveHour?.used).toBe(4)
    expect(byUsageWindows.weekly?.used).toBe(9)
  })

  it("缺字段/结构变化不崩：返回空窗而非抛错", () => {
    expect(parseCommandCodeUsage(null)).toEqual({ plan: "", fiveHour: null, weekly: null })
    expect(parseCommandCodeUsage([])).toEqual({ plan: "", fiveHour: null, weekly: null })
    expect(parseCommandCodeUsage("oops")).toEqual({ plan: "", fiveHour: null, weekly: null })
    expect(parseCommandCodeUsage({ plan: "goat" })).toEqual({ plan: "goat", fiveHour: null, weekly: null })
    // 窗口对象无 used/cap 视为不可解析。
    expect(parseCommandCodeUsage({ fiveHour: { resetAt: "x" } }).fiveHour).toBeNull()
    // 非法 resetAt 字符串落 null，不影响 used/cap。
    expect(parseCommandCodeUsage({ weekly: { used: 1, cap: 35, resetAt: "not-a-date" } }).weekly)
      .toEqual({ used: 1, cap: 35, resetAt: null })
  })
})

describe("windowsFromCommandCodeUsage（双窗 → quota_windows）", () => {
  it("5h/weekly → FIVE_HOUR/WEEKLY；plan 挂 extra 透传", () => {
    const now = Date.parse("2026-09-07T10:00:00.000Z")
    const windows = windowsFromCommandCodeUsage({
      plan: "goat",
      fiveHour: { used: 7, cap: 14, resetAt: "2026-09-07T15:00:00.000Z" },
      weekly: { used: 7, cap: 35, resetAt: "2026-09-14T00:00:00.000Z" },
    }, now)
    expect(windows).toHaveLength(2)
    const fiveHour = windows.find((w) => w.kind === "FIVE_HOUR")
    const weekly = windows.find((w) => w.kind === "WEEKLY")
    expect(fiveHour).toMatchObject({
      usagePercent: 50,
      limitValue: 14,
      remainingValue: 7,
      resetAt: "2026-09-07T15:00:00.000Z",
      source: "API_PROBE",
    })
    expect(fiveHour?.extra).toMatchObject({ plan: "goat" })
    expect(weekly).toMatchObject({ usagePercent: 20, limitValue: 35, remainingValue: 28 })
    // resetInSeconds 与 resetAt 一致（5 小时后）。
    expect(fiveHour?.resetInSeconds).toBe(5 * 3600)
  })

  it("usagePercent 钳制到 [0,100]；cap=0 不除零", () => {
    const windows = windowsFromCommandCodeUsage({
      plan: "",
      fiveHour: { used: 20, cap: 14, resetAt: null },
      weekly: { used: 0, cap: 0, resetAt: null },
    })
    expect(windows.find((w) => w.kind === "FIVE_HOUR")?.usagePercent).toBe(100)
    const weekly = windows.find((w) => w.kind === "WEEKLY")
    expect(weekly?.usagePercent).toBe(0)
    expect(weekly?.limitValue).toBeNull()
    expect(weekly?.remainingValue).toBeNull()
  })

  it("无窗口时返回空数组", () => {
    expect(windowsFromCommandCodeUsage({ plan: "goat", fiveHour: null, weekly: null })).toEqual([])
  })
})

describe("parseCommandCodeModels（/provider/v1/models 免 key，2026-09-07 实测结构）", () => {
  it("解析实测响应样例（OpenAI list 形，含带斜杠 ID）", () => {
    // 摘自 2026-09-07 实测 GET https://api.commandcode.ai/provider/v1/models（免 key 200）。
    const sample = JSON.stringify({
      object: "list",
      data: [
        { id: "claude-sonnet-5", object: "model", created: 1788775172, owned_by: "command-code", name: "Claude Sonnet 5", context_length: 1000000 },
        { id: "deepseek/deepseek-v4-flash", object: "model", created: 1788775172, owned_by: "command-code", name: "DeepSeek V4 Flash (latest)", context_length: 1000000 },
        { id: "moonshotai/Kimi-K3", object: "model", created: 1788775172, owned_by: "command-code", name: "Kimi K3", context_length: 1000000 },
        { id: "zai-org/GLM-5.3", object: "model", created: 1788775172, owned_by: "command-code", name: "GLM-5.3", context_length: 1000000 },
      ],
    })
    const models = parseCommandCodeModels(sample)
    expect(models).toContain("claude-sonnet-5")
    expect(models).toContain("deepseek/deepseek-v4-flash")
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
