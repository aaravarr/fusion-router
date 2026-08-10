import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearBootstrapCacheForTests, ensureMasterKey } from "../bootstrap"
import { createDatabase, getDatabase, type AppDatabase } from "../db"
import {
  getSystemSettings,
  initializeSystemSettings,
  matchOpenCodeGoMirrorRule,
  normalizeOfficialOpenCodeUpstreamUrl,
  resolveBodyPath,
  shouldUseOpenCodeGoMirror,
  updateSystemSettings,
  type OpenCodeGoMirrorFilter,
  type OpenCodeGoMirrorRule,
} from "../settings"
import type { AccountRecord } from "../types"
import { OpenCodeGoProvider } from "./opencode-go"

let directory: string
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase; __opencodeApiAccountSchemaVersion?: number }).__opencodeApiDb = value
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-go-"))
  process.env.DATA_DIR = directory
  clearBootstrapCacheForTests()
  ensureMasterKey()
  db = createDatabase(":memory:")
  initializeSystemSettings(db)
})

afterEach(() => {
  setGlobalDatabase(undefined)
  clearBootstrapCacheForTests()
  db.close()
  delete process.env.DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

describe("resolveBodyPath", () => {
  it("resolves dot paths and normalizes body['model'] shorthand", () => {
    expect(resolveBodyPath({ model: "grok-4.5" }, "model")).toBe("grok-4.5")
    expect(resolveBodyPath({ model: "grok-4.5" }, "body['model']")).toBe("grok-4.5")
    expect(resolveBodyPath({ model: "grok-4.5" }, 'body["model"]')).toBe("grok-4.5")
    expect(resolveBodyPath({ model: "grok-4.5" }, "body.model")).toBe("grok-4.5")
    expect(resolveBodyPath({ a: { b: "nested" } }, "a.b")).toBe("nested")
  })

  it("returns undefined for missing paths or non-object roots", () => {
    expect(resolveBodyPath({ model: "grok-4.5" }, "missing")).toBeUndefined()
    expect(resolveBodyPath({ a: { b: "nested" } }, "a.c")).toBeUndefined()
    expect(resolveBodyPath({ a: { b: "nested" } }, "a.b.c")).toBeUndefined()
    expect(resolveBodyPath("not-an-object", "model")).toBeUndefined()
    expect(resolveBodyPath(null, "model")).toBeUndefined()
  })
})

describe("matchOpenCodeGoMirrorRule", () => {
  it("contains is case-insensitive and OR over values", () => {
    expect(matchOpenCodeGoMirrorRule("grok-4.5", { path: "model", operator: "contains", values: ["Grok"] })).toBe(true)
    expect(matchOpenCodeGoMirrorRule("gpt-5.6-luna", { path: "model", operator: "contains", values: ["grok", "gpt"] })).toBe(true)
    expect(matchOpenCodeGoMirrorRule("deepseek-v4-flash", { path: "model", operator: "contains", values: ["gpt"] })).toBe(false)
  })

  it("equals is case-insensitive", () => {
    expect(matchOpenCodeGoMirrorRule("Grok-4.5", { path: "model", operator: "equals", values: ["grok-4.5"] })).toBe(true)
    expect(matchOpenCodeGoMirrorRule("grok-4.5-pro", { path: "model", operator: "equals", values: ["grok-4.5"] })).toBe(false)
  })

  it("startsWith matches a prefix", () => {
    expect(matchOpenCodeGoMirrorRule("grok-4.5", { path: "model", operator: "startsWith", values: ["grok"] })).toBe(true)
    expect(matchOpenCodeGoMirrorRule("grok-4.5", { path: "model", operator: "startsWith", values: ["k"] })).toBe(false)
  })

  it("regex uses the first value case-insensitively", () => {
    expect(matchOpenCodeGoMirrorRule("gpt-5.6-luna", { path: "model", operator: "regex", values: ["^GPT", "ignored"] })).toBe(true)
    expect(matchOpenCodeGoMirrorRule("deepseek-v4-flash", { path: "model", operator: "regex", values: ["^gpt"] })).toBe(false)
  })

  it("recursively matches any array element", () => {
    expect(matchOpenCodeGoMirrorRule(["deepseek-v4-flash", "gpt-5.6-luna"], { path: "model", operator: "contains", values: ["gpt"] })).toBe(true)
    expect(matchOpenCodeGoMirrorRule(["deepseek-v4-flash"], { path: "model", operator: "contains", values: ["gpt"] })).toBe(false)
  })

  it("returns false for non-string/array values", () => {
    expect(matchOpenCodeGoMirrorRule(123, { path: "model", operator: "contains", values: ["gpt"] })).toBe(false)
    expect(matchOpenCodeGoMirrorRule(null, { path: "model", operator: "equals", values: ["null"] })).toBe(false)
    expect(matchOpenCodeGoMirrorRule({ model: "gpt-5.6-luna" }, { path: "model", operator: "contains", values: ["gpt"] })).toBe(false)
  })
})

describe("shouldUseOpenCodeGoMirror", () => {
  const filter: OpenCodeGoMirrorFilter = {
    enabled: true,
    mirrorBaseUrl: "https://mirror.example.com/zen/go/v1",
    rules: [{ path: "model", operator: "contains", values: ["gpt"] }],
  }

  it("returns false when disabled", () => {
    expect(shouldUseOpenCodeGoMirror({ model: "gpt-5.6-luna" }, { ...filter, enabled: false })).toBe(false)
  })

  it("returns false when mirrorBaseUrl is empty", () => {
    expect(shouldUseOpenCodeGoMirror({ model: "gpt-5.6-luna" }, { ...filter, mirrorBaseUrl: "" })).toBe(false)
  })

  it("returns true for empty rules (everything goes to mirror)", () => {
    expect(shouldUseOpenCodeGoMirror({ model: "anything" }, { ...filter, rules: [] })).toBe(true)
  })

  it("matches when a rule hits and returns false when none do", () => {
    expect(shouldUseOpenCodeGoMirror({ model: "gpt-5.6-luna" }, filter)).toBe(true)
    expect(shouldUseOpenCodeGoMirror({ model: "deepseek-v4-flash" }, filter)).toBe(false)
    expect(shouldUseOpenCodeGoMirror(null, filter)).toBe(false)
    expect(shouldUseOpenCodeGoMirror({ input: "no model field" }, filter)).toBe(false)
  })
})

describe("updateSystemSettings mirror filter validation", () => {
  it("rejects empty or invalid mirrorBaseUrl when enabled", () => {
    expect(() => updateSystemSettings({ opencodeGoMirrorFilter: { enabled: true, mirrorBaseUrl: "", rules: [] } }, null, db)).toThrow()
    expect(() => updateSystemSettings({ opencodeGoMirrorFilter: { enabled: true, mirrorBaseUrl: "not a url", rules: [] } }, null, db)).toThrow()
    expect(() => updateSystemSettings({ opencodeGoMirrorFilter: { enabled: true, mirrorBaseUrl: "ftp://mirror.example.com/v1", rules: [] } }, null, db)).toThrow()
    expect(() => updateSystemSettings({ opencodeGoMirrorFilter: { enabled: true, mirrorBaseUrl: "https://user:pass@mirror.example.com/v1", rules: [] } }, null, db)).toThrow()
    expect(() => updateSystemSettings({ opencodeGoMirrorFilter: { enabled: true, mirrorBaseUrl: "https://mirror.example.com/v1?x=1", rules: [] } }, null, db)).toThrow()
    expect(() => updateSystemSettings({ opencodeGoMirrorFilter: { enabled: true, mirrorBaseUrl: "https://mirror.example.com/v1#frag", rules: [] } }, null, db)).toThrow()
  })

  it("allows empty mirrorBaseUrl when disabled and empty rules", () => {
    const updated = updateSystemSettings({ opencodeGoMirrorFilter: { enabled: false, mirrorBaseUrl: "", rules: [] } }, null, db)
    expect(updated.opencodeGoMirrorFilter).toEqual({ enabled: false, mirrorBaseUrl: "", rules: [] })
  })

  it("rejects invalid operator, empty path and empty values", () => {
    expect(() => updateSystemSettings({
      opencodeGoMirrorFilter: { enabled: false, mirrorBaseUrl: "", rules: [{ path: "model", operator: "notAnOperator" as never, values: ["gpt"] }] },
    }, null, db)).toThrow(/操作符/)
    expect(() => updateSystemSettings({
      opencodeGoMirrorFilter: { enabled: false, mirrorBaseUrl: "", rules: [{ path: "", operator: "contains", values: ["gpt"] }] },
    }, null, db)).toThrow(/path/)
    expect(() => updateSystemSettings({
      opencodeGoMirrorFilter: { enabled: false, mirrorBaseUrl: "", rules: [{ path: "model", operator: "contains", values: [] }] },
    }, null, db)).toThrow(/values/)
    expect(() => updateSystemSettings({
      opencodeGoMirrorFilter: { enabled: false, mirrorBaseUrl: "", rules: [{ path: "model", operator: "contains", values: ["  "] }] },
    }, null, db)).toThrow(/values/)
  })

  it("stores a valid filter, trims values/baseUrl and normalizes on read", () => {
    const updated = updateSystemSettings({
      opencodeGoMirrorFilter: {
        enabled: true,
        mirrorBaseUrl: "https://mirror.example.com/zen/go/v1/",
        rules: [{ path: "body['model']", operator: "contains", values: ["gpt", " grok "] }],
      },
    }, null, db)
    expect(updated.opencodeGoMirrorFilter).toEqual({
      enabled: true,
      mirrorBaseUrl: "https://mirror.example.com/zen/go/v1",
      rules: [{ path: "body['model']", operator: "contains", values: ["gpt", "grok"] }],
    })
    expect(getSystemSettings(db).opencodeGoMirrorFilter).toEqual(updated.opencodeGoMirrorFilter)
  })

  it("normalizes malformed stored values to safe defaults", () => {
    db.prepare("UPDATE system_settings SET value_json = ?, updated_at = ? WHERE key = 'opencode_go_mirror_filter'")
      .run(JSON.stringify({ enabled: true, mirrorBaseUrl: 123, rules: [
        { path: "model", operator: "bogus", values: ["gpt"] },
        { path: "model", operator: "contains", values: [] },
        { path: "model", operator: "contains", values: ["gpt"] },
      ] }), new Date().toISOString())
    expect(getSystemSettings(db).opencodeGoMirrorFilter).toEqual({
      enabled: true,
      mirrorBaseUrl: "",
      rules: [{ path: "model", operator: "contains", values: ["gpt"] }],
    })
  })
})

describe("OpenCodeGoProvider.buildForwardTarget mirror routing", () => {
  it("routes matching models to the mirror and others to the official upstream", () => {
    const mirrorBaseUrl = "https://mirror.example.com/zen/go/v1"
    updateSystemSettings({
      opencodeGoMirrorFilter: {
        enabled: true,
        mirrorBaseUrl,
        rules: [{ path: "model", operator: "contains", values: ["gpt"] }],
      },
    }, null, db)
    setGlobalDatabase(db)
    expect(getDatabase()).toBe(db)

    const provider = new OpenCodeGoProvider()
    const credential = { token: "sk-test", credentialVersion: 1 }
    const account = {} as AccountRecord

    const gptTarget = provider.buildForwardTarget({
      method: "POST",
      endpoint: "responses",
      model: "gpt-5.6-luna",
      upstreamModel: "gpt-5.6-luna",
      body: new TextEncoder().encode(JSON.stringify({ model: "gpt-5.6-luna", input: "hi" })),
      headers: new Headers(),
      signal: AbortSignal.timeout(1000),
    }, credential, account)
    expect(gptTarget.url).toBe(`${mirrorBaseUrl}/responses`)
    expect(gptTarget.url).toContain(mirrorBaseUrl)
    expect(gptTarget.url).not.toContain("opencode.ai")

    const officialBase = normalizeOfficialOpenCodeUpstreamUrl(getSystemSettings(db).upstreamBaseUrl)
    const deepseekTarget = provider.buildForwardTarget({
      method: "POST",
      endpoint: "responses",
      model: "deepseek-v4-flash",
      upstreamModel: "deepseek-v4-flash",
      body: new TextEncoder().encode(JSON.stringify({ model: "deepseek-v4-flash", input: "hi" })),
      headers: new Headers(),
      signal: AbortSignal.timeout(1000),
    }, credential, account)
    expect(deepseekTarget.url).toBe(`${officialBase}/responses`)
    expect(deepseekTarget.url).not.toContain(mirrorBaseUrl)
  })

  it("stays on the official upstream when the filter is disabled", () => {
    updateSystemSettings({
      opencodeGoMirrorFilter: { enabled: false, mirrorBaseUrl: "https://mirror.example.com/zen/go/v1", rules: [] },
    }, null, db)
    setGlobalDatabase(db)

    const provider = new OpenCodeGoProvider()
    const target = provider.buildForwardTarget({
      method: "POST",
      endpoint: "chat/completions",
      model: "gpt-5.6-luna",
      upstreamModel: "gpt-5.6-luna",
      body: new TextEncoder().encode(JSON.stringify({ model: "gpt-5.6-luna", input: "hi" })),
      headers: new Headers(),
      signal: AbortSignal.timeout(1000),
    }, { token: "sk-test", credentialVersion: 1 }, {} as AccountRecord)
    expect(target.url).toBe(`${normalizeOfficialOpenCodeUpstreamUrl(getSystemSettings(db).upstreamBaseUrl)}/chat/completions`)
    expect(target.url).not.toContain("mirror.example.com")
  })
})
