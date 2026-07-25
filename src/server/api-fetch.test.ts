import { describe, expect, it } from "vitest"
import { applyMirrorTarget, selectDomainMirror, selectDomainMirrorGroup, selectMirrorGroupTarget } from "./api-fetch"
import type { DomainMirrorConfig, DomainMirrorGroup } from "./settings"

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

  it("applies group rules across multiple mirrors before hash sharding", () => {
    const group: DomainMirrorGroup = {
      id: "group-a", name: "Group A", enabled: true,
      domains: ["api.example.com"], accountIds: ["prod-account"],
      mirrors: config.mirrors, rules: config.rules,
    }
    expect(selectMirrorGroupTarget(group, { account: { id: "prod-account" } })?.id).toBe("b")
    const first = selectMirrorGroupTarget(group, { account: { id: "other" } })
    expect(selectMirrorGroupTarget(group, { account: { id: "other" } })?.id).toBe(first?.id)
  })

  it("selects an account-specific group before a domain-wide fallback", () => {
    const fallback: DomainMirrorGroup = { id: "fallback", name: "Fallback", enabled: true, domains: ["api.example.com"], accountIds: [], mirrors: config.mirrors, rules: [] }
    const selected: DomainMirrorGroup = { ...fallback, id: "selected", name: "Selected", accountIds: ["account-a"] }
    expect(selectDomainMirrorGroup([fallback, selected], "api.example.com", "account-a")?.id).toBe("selected")
    expect(selectDomainMirrorGroup([fallback, selected], "api.example.com", "other")?.id).toBe("fallback")
    expect(selectDomainMirrorGroup([selected], "api.example.com", "other")).toBeNull()
  })

  it("rewrites host and preserves the mirror path prefix, request path and query", () => {
    expect(applyMirrorTarget("https://api.example.com/v1/models?limit=10", { id: "m", name: "M", url: "https://mirror.example.com/proxy", enabled: true }))
      .toBe("https://mirror.example.com/proxy/v1/models?limit=10")
  })

  it("expands $host to the original host before appending the request path", () => {
    expect(applyMirrorTarget("https://api.x.ai/v1/models?limit=10", { id: "m", name: "M", url: "https://mirror.ahao1.tech/$host", enabled: true }))
      .toBe("https://mirror.ahao1.tech/api.x.ai/v1/models?limit=10")
  })
})
