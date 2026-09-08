import { describe, expect, it } from "vitest"
import { listWindowColumns } from "./status-ui"

describe("listWindowColumns", () => {
  it("open-design-go 主列展示余额、次列展示月度周期用量", () => {
    const [primary, secondary] = listWindowColumns("open-design-go")
    expect(primary).toEqual({ key: "balance", label: "BALANCE", header: "余额" })
    expect(secondary).toEqual({ key: "monthly", label: "MONTH", header: "月" })
  })

  it("command-code 默认双列 5H + WEEK；triple 下为 5H/WEEK/MONTH 三列", () => {
    const [primary, secondary] = listWindowColumns("command-code")
    expect(primary).toMatchObject({ key: "fiveHour", label: "5H" })
    expect(secondary).toMatchObject({ key: "weekly", label: "WEEK" })
    const triple = listWindowColumns("command-code", true)
    expect(triple.map((column) => column?.key)).toEqual(["fiveHour", "weekly", "monthly"])
    expect(triple[2]).toMatchObject({ label: "MONTH", header: "月" })
  })

  it("opencode-go triple 下对齐 5H/WEEK/MONTH 三列；默认仍为双列", () => {
    const [primary, secondary] = listWindowColumns("opencode-go")
    expect(primary).toMatchObject({ key: "fiveHour", label: "5H" })
    expect(secondary).toMatchObject({ key: "weekly", label: "WEEK" })
    const triple = listWindowColumns("opencode-go", true)
    expect(triple.map((column) => column?.key)).toEqual(["fiveHour", "weekly", "monthly"])
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
