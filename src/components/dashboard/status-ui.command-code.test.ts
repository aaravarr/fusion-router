import { describe, expect, it } from "vitest"
import {
  commandCodeBillingExtra,
  commandCodeWindowExtra,
  formatCommandCodeCredits,
  getPoolQuotaKinds,
  listWindowColumns,
  POOL_TYPE_META,
} from "./status-ui"
import type { Account } from "./types"

function commandCodeAccount(): Account {
  return {
    id: "cc-1",
    poolType: "command-code",
    quotaWindows: [
      {
        kind: "FIVE_HOUR",
        usagePercent: 26.58,
        unit: "credits",
        limitValue: 14,
        remainingValue: 10.2795,
        resetAt: "2026-09-08T15:00:00.000Z",
        lastObservedAt: "2026-09-08T10:00:00.000Z",
        extra: { service: "command-code", used: 3.7205, cap: 14, exceeded: false, planId: "individual-goat" },
      },
      {
        kind: "WEEKLY",
        usagePercent: 10.63,
        unit: "credits",
        limitValue: 35,
        remainingValue: 31.2795,
        resetAt: "2026-09-15T00:00:00.000Z",
        lastObservedAt: "2026-09-08T10:00:00.000Z",
        extra: { service: "command-code", used: 3.7205, cap: 35, exceeded: false, planId: "individual-goat" },
      },
      {
        kind: "MONTHLY",
        usagePercent: 5.31,
        unit: "credits",
        limitValue: 70,
        remainingValue: 66.2795,
        resetAt: "2026-10-01T00:00:00.000Z",
        lastObservedAt: "2026-09-08T10:00:00.000Z",
        extra: {
          service: "command-code",
          remaining: 66.2795,
          purchased: 0,
          free: 0,
          cap: 70,
          planId: "individual-goat",
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-10-01T00:00:00.000Z",
          belowThreshold: false,
          periodBasis: "billing-period",
          totalCredits: 3.7205,
          totalCount: 37,
          completedCount: 37,
          failedCount: 0,
          totalTokens: 3284142,
          totalTokensIn: 3263702,
          totalTokensOut: 20440,
        },
      },
    ],
  }
}

describe("command-code 三窗展示（/alpha/billing/credits + subscriptions）", () => {
  it("POOL_TYPE_META 注册 Command Code 显示名与三窗", () => {
    expect(POOL_TYPE_META["command-code"]).toBeDefined()
    expect(POOL_TYPE_META["command-code"].label).toBe("Command Code")
    expect(POOL_TYPE_META["command-code"].quotaKinds).toEqual(["fiveHour", "weekly", "monthly"])
  })

  it("getPoolQuotaKinds 对齐后端 supportedQuotaKinds（三窗）", () => {
    expect(getPoolQuotaKinds("command-code")).toEqual(["fiveHour", "weekly", "monthly"])
  })

  it("列表主/次列：恢复双窗列（5H + WEEK）", () => {
    const [primary, secondary] = listWindowColumns("command-code")
    expect(primary).toMatchObject({ key: "fiveHour", label: "5H" })
    expect(secondary).toMatchObject({ key: "weekly", label: "WEEK" })
  })

  it("commandCodeWindowExtra 读取双窗 used/cap/exceeded", () => {
    const five = commandCodeWindowExtra(commandCodeAccount(), "fiveHour")
    expect(five.used).toBeCloseTo(3.7205)
    expect(five.cap).toBe(14)
    expect(five.exceeded).toBe(false)
    expect(five.planId).toBe("individual-goat")
    const weekly = commandCodeWindowExtra(commandCodeAccount(), "weekly")
    expect(weekly.used).toBeCloseTo(3.7205)
    expect(weekly.cap).toBe(35)
  })

  it("commandCodeBillingExtra 读取 MONTHLY 余额窗字段", () => {
    const billing = commandCodeBillingExtra(commandCodeAccount())
    expect(billing.remaining).toBeCloseTo(66.2795)
    expect(billing.cap).toBe(70)
    expect(billing.planId).toBe("individual-goat")
    expect(billing.periodEnd).toBe("2026-10-01T00:00:00.000Z")
    expect(billing.belowThreshold).toBe(false)
    // summary 对账字段仍保留。
    expect(billing.totalCredits).toBeCloseTo(3.7205)
    expect(billing.totalCount).toBe(37)
    expect(billing.completedCount).toBe(37)
    expect(billing.failedCount).toBe(0)
    expect(billing.totalTokens).toBe(3284142)
    expect(billing.totalTokensIn).toBe(3263702)
    expect(billing.totalTokensOut).toBe(20440)
    expect(billing.periodBasis).toBe("billing-period")
    expect(billing.lastObservedAt).toBe("2026-09-08T10:00:00.000Z")
  })

  it("兼容旧快照：只有 totalCredits 无 remaining 时余额字段为空、对账字段仍可读", () => {
    const legacy: Account = {
      id: "cc-old",
      poolType: "command-code",
      quotaWindows: [{
        kind: "MONTHLY",
        usagePercent: 0,
        unit: "credits",
        extra: { service: "command-code", periodBasis: "billing-period", totalCredits: 1.14, totalCount: 37 },
      }],
    }
    const billing = commandCodeBillingExtra(legacy)
    expect(billing.remaining).toBeNull()
    expect(billing.cap).toBeNull()
    expect(billing.totalCredits).toBeCloseTo(1.14)
    expect(billing.totalCount).toBe(37)
  })

  it("无 MONTHLY 窗时各字段为空（页面渲染「暂无数据」）", () => {
    const billing = commandCodeBillingExtra({ id: "cc-empty", poolType: "command-code", quotaWindows: [] })
    expect(billing.remaining).toBeNull()
    expect(billing.cap).toBeNull()
    expect(billing.totalCredits).toBeNull()
    expect(billing.totalCount).toBeNull()
    expect(billing.periodBasis).toBeNull()
  })

  it("formatCommandCodeCredits 保留 4 位小数、非法值显示占位", () => {
    expect(formatCommandCodeCredits(1.1409038200000001)).toBe("1.1409")
    expect(formatCommandCodeCredits(0)).toBe("0.0000")
    expect(formatCommandCodeCredits(null)).toBe("—")
    expect(formatCommandCodeCredits(undefined)).toBe("—")
  })

  it("glm-coding 仍保持 5h + weekly 双窗（本次只改 command-code）", () => {
    expect(getPoolQuotaKinds("glm-coding")).toEqual(["fiveHour", "weekly"])
    const [primary, secondary] = listWindowColumns("glm-coding")
    expect(primary).toMatchObject({ key: "fiveHour", label: "5H" })
    expect(secondary).toMatchObject({ key: "weekly", label: "WEEK" })
  })

  it("kimi-code / openai 仍保持 5h + weekly 双窗", () => {
    for (const poolType of ["kimi-code", "openai"]) {
      expect(getPoolQuotaKinds(poolType)).toEqual(["fiveHour", "weekly"])
    }
  })
})
