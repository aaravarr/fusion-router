import { describe, expect, it } from "vitest"
import { applyMirrorTarget, selectDomainMirror } from "./api-fetch"
import type { DomainMirrorConfig } from "./settings"

const config: DomainMirrorConfig = {
  mirrors: [
    { id: "a", name: "A", url: "https://a.example.com", enabled: true },
    { id: "b", name: "B", url: "https://b.example.com", enabled: true },
    { id: "off", name: "Off", url: "https://off.example.com", enabled: false },
  ],
  accountAssignments: { assigned: "b", disabled: "off" },
  rules: [
    { id: "rule-a", pattern: "@example\\.com", mirrorId: "a", enabled: true },
    { id: "rule-b", pattern: "^prod-", mirrorId: "b", enabled: true },
  ],
}

describe("domain mirror selection", () => {
  it("uses explicit account assignment before regex rules", () => {
    expect(selectDomainMirror(config, { account: { id: "assigned", email: "user@example.com" } })?.id).toBe("b")
  })

  it("uses the first matching enabled regex rule", () => {
    expect(selectDomainMirror(config, { account: { id: "other", email: "user@example.com" } })?.id).toBe("a")
    expect(selectDomainMirror(config, { account: { id: "prod-key" } })?.id).toBe("b")
  })

  it("falls back to stable hash sharding and ignores disabled mirrors", () => {
    const first = selectDomainMirror(config, { account: { id: "stable-account" } })
    const second = selectDomainMirror(config, { account: { id: "stable-account" } })
    expect(second?.id).toBe(first?.id)
    expect(first?.id).not.toBe("off")
    expect(selectDomainMirror(config, { account: { id: "disabled" } })?.id).not.toBe("off")
  })

  it("rewrites host and preserves the mirror path prefix, request path and query", () => {
    expect(applyMirrorTarget("https://api.example.com/v1/models?limit=10", { id: "m", name: "M", url: "https://mirror.example.com/proxy", enabled: true }))
      .toBe("https://mirror.example.com/proxy/v1/models?limit=10")
  })
})
