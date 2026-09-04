import { describe, expect, it } from "vitest"
import { PRESET_DOMAIN_SET, PROVIDER_DOMAIN_PRESETS } from "./domain-presets"

describe("glm-coding 域名镜像预设", () => {
  it("注册 GLM Coding Plan 组，覆盖 OAuth、推理/用量与 biz 兑换域名", () => {
    const group = PROVIDER_DOMAIN_PRESETS.find((item) => item.poolType === "glm-coding")
    expect(group).toBeDefined()
    expect(group?.label).toBe("GLM Coding Plan")
    expect(group?.domains.map((domain) => domain.domain)).toEqual([
      "zcode.z.ai",
      "open.bigmodel.cn",
      "bigmodel.cn",
      "api.z.ai",
    ])
  })

  it("GLM 域名全部进入预设集合（镜像下拉可选）", () => {
    for (const domain of ["zcode.z.ai", "open.bigmodel.cn", "bigmodel.cn", "api.z.ai"]) {
      expect(PRESET_DOMAIN_SET.has(domain)).toBe(true)
    }
  })

  it("全部预设域名不重复", () => {
    const all = PROVIDER_DOMAIN_PRESETS.flatMap((group) => group.domains.map((domain) => domain.domain))
    expect(new Set(all).size).toBe(all.length)
  })
})
