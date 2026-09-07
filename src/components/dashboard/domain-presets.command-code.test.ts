import { describe, expect, it } from "vitest"
import { PRESET_DOMAIN_SET, PROVIDER_DOMAIN_PRESETS } from "./domain-presets"

describe("command-code 域名镜像预设", () => {
  it("注册 Command Code 组，覆盖推理/用量与官网域名", () => {
    const group = PROVIDER_DOMAIN_PRESETS.find((item) => item.poolType === "command-code")
    expect(group).toBeDefined()
    expect(group?.label).toBe("Command Code")
    expect(group?.domains.map((domain) => domain.domain)).toEqual([
      "api.commandcode.ai",
      "commandcode.ai",
    ])
  })

  it("Command Code 域名全部进入预设集合（镜像下拉可选）", () => {
    for (const domain of ["api.commandcode.ai", "commandcode.ai"]) {
      expect(PRESET_DOMAIN_SET.has(domain)).toBe(true)
    }
  })

  it("全部预设域名不重复", () => {
    const all = PROVIDER_DOMAIN_PRESETS.flatMap((group) => group.domains.map((domain) => domain.domain))
    expect(new Set(all).size).toBe(all.length)
  })
})
