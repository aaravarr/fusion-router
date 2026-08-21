import { describe, expect, it } from "vitest"
import { listWindowColumns } from "./status-ui"

describe("listWindowColumns", () => {
  it("open-design-go 只渲染 MONTHLY 主窗口，无次窗口", () => {
    const [primary, secondary] = listWindowColumns("open-design-go")
    expect(primary).toEqual({ key: "monthly", label: "MONTH", header: "月度窗口" })
    expect(secondary).toBeNull()
  })

  it("opencode-go 保持 5H + WEEK 两档", () => {
    const [primary, secondary] = listWindowColumns("opencode-go")
    expect(primary).toMatchObject({ key: "fiveHour", label: "5H" })
    expect(secondary).toMatchObject({ key: "weekly", label: "WEEK" })
  })

  it("openai / kimi-code 保持 5H + WEEK 两档", () => {
    for (const poolType of ["openai", "kimi-code"]) {
      const [primary, secondary] = listWindowColumns(poolType)
      expect(primary?.key).toBe("fiveHour")
      expect(secondary?.key).toBe("weekly")
    }
  })

  it("xai-grok 只渲染滚动 24h 主窗口", () => {
    const [primary, secondary] = listWindowColumns("xai-grok")
    expect(primary).toMatchObject({ key: "rolling24h", label: "24H", header: "滚动 24 小时" })
    expect(secondary).toBeNull()
  })

  it("缺省 poolType 回退 opencode-go 口径", () => {
    const [primary] = listWindowColumns(undefined)
    expect(primary?.key).toBe("fiveHour")
    const [fallback] = listWindowColumns(null)
    expect(fallback?.key).toBe("fiveHour")
  })
})
