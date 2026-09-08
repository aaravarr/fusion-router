import { describe, expect, it } from "vitest"
import {
  commandCodeBillingExtra,
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
        kind: "MONTHLY",
        usagePercent: 0,
        unit: "credits",
        lastObservedAt: "2026-09-08T10:00:00.000Z",
        extra: {
          service: "command-code",
          periodBasis: "billing-period",
          totalCredits: 1.1409038200000001,
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

describe("command-code 账期累计展示（单 MONTHLY 信息窗）", () => {
  it("POOL_TYPE_META 注册 Command Code 显示名与 monthly 单窗", () => {
    expect(POOL_TYPE_META["command-code"]).toBeDefined()
    expect(POOL_TYPE_META["command-code"].label).toBe("Command Code")
    expect(POOL_TYPE_META["command-code"].quotaKinds).toEqual(["monthly"])
  })

  it("getPoolQuotaKinds 对齐后端 supportedQuotaKinds（MONTHLY）", () => {
    expect(getPoolQuotaKinds("command-code")).toEqual(["monthly"])
  })

  it("列表主/次列：主列占位、次列为账期累计 monthly 窗", () => {
    const [primary, secondary] = listWindowColumns("command-code")
    expect(primary).toBeNull()
    expect(secondary).toMatchObject({ key: "monthly", label: "MONTH" })
  })

  it("commandCodeBillingExtra 读取 MONTHLY extra 账期累计字段", () => {
    const billing = commandCodeBillingExtra(commandCodeAccount())
    // totalCredits 语义是账期累计消耗（非剩余额度）。
    expect(billing.totalCredits).toBeCloseTo(1.1409038200000001)
    expect(billing.totalCount).toBe(37)
    expect(billing.completedCount).toBe(37)
    expect(billing.failedCount).toBe(0)
    expect(billing.totalTokens).toBe(3284142)
    expect(billing.totalTokensIn).toBe(3263702)
    expect(billing.totalTokensOut).toBe(20440)
    expect(billing.periodBasis).toBe("billing-period")
    expect(billing.lastObservedAt).toBe("2026-09-08T10:00:00.000Z")
  })

  it("无 MONTHLY 窗时各字段为空（页面渲染「暂无数据」）", () => {
    const billing = commandCodeBillingExtra({ id: "cc-empty", poolType: "command-code", quotaWindows: [] })
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
