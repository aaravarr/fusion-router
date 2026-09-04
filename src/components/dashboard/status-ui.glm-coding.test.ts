import { describe, expect, it } from "vitest"
import { getPoolQuotaKinds, listWindowColumns, POOL_TYPE_META, poolDisplayLabel } from "./status-ui"

describe("glm-coding 前端号池注册", () => {
  it("POOL_TYPE_META 注册 GLM Coding Plan 显示名与 5h + weekly 额度口径", () => {
    expect(POOL_TYPE_META["glm-coding"]).toBeDefined()
    expect(POOL_TYPE_META["glm-coding"].label).toBe("GLM Coding Plan")
    expect(POOL_TYPE_META["glm-coding"].quotaKinds).toEqual(["fiveHour", "weekly"])
  })

  it("getPoolQuotaKinds 对齐后端 supportedQuotaKinds（FIVE_HOUR/WEEKLY）", () => {
    expect(getPoolQuotaKinds("glm-coding")).toEqual(["fiveHour", "weekly"])
  })

  it("账号列表主/次额度列渲染 5H + WEEK 两档（与 kimi-code 同口径）", () => {
    const [primary, secondary] = listWindowColumns("glm-coding")
    expect(primary).toMatchObject({ key: "fiveHour", label: "5H" })
    expect(secondary).toMatchObject({ key: "weekly", label: "WEEK" })
  })

  it("无 poolLabel 时回退显示注册名", () => {
    expect(poolDisplayLabel("glm-coding", null).text).toBe("GLM Coding Plan")
    // poolLabel 只在非 custom 池上原样透传。
    expect(poolDisplayLabel("glm-coding", "自定义别名").text).toBe("自定义别名")
  })
})
