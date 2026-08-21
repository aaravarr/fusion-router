import { describe, expect, it } from "vitest"
import { getPoolLabel, poolDisplayLabel } from "./status-ui"

describe("poolDisplayLabel", () => {
  it("shows provider name for custom pools when label is known", () => {
    const poolType = "custom:23b5e738-272b-44cf-8d59-13203aee01e4"
    expect(getPoolLabel(poolType, "DeepSeek Official")).toBe("DeepSeek Official")
    expect(poolDisplayLabel(poolType, "DeepSeek Official").title).toBe("DeepSeek Official")
  })

  it("never renders raw custom:<uuid> even when label falls back to the id", () => {
    const poolType = "custom:23b5e738-272b-44cf-8d59-13203aee01e4"
    expect(getPoolLabel(poolType, poolType)).toBe("custom-23b5e738")
    expect(getPoolLabel(poolType, null)).toBe("custom-23b5e738")
    expect(getPoolLabel(poolType)).not.toContain("custom:23b5e738-272b-44cf-8d59-13203aee01e4")
  })

  it("keeps builtin pool labels", () => {
    expect(getPoolLabel("opencode-go")).toBe("OpenCode Go")
    expect(getPoolLabel("openai", "OpenAI")).toBe("OpenAI")
  })

  it("shows OpenDesign Go label", () => {
    expect(getPoolLabel("open-design-go")).toBe("OpenDesign Go")
  })
})
