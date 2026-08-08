import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import {
  parseKimiUsagePayload,
  startKimiOAuthSession,
  pollKimiOAuthSession,
  cancelKimiOAuthSession,
  kimiExternalId,
} from "./kimi-oauth"

describe("parseKimiUsagePayload", () => {
  it("parses weekly summary and 5h limit windows", () => {
    const parsed = parseKimiUsagePayload({
      usage: { name: "Weekly limit", used: 40, limit: 1000, resetAt: "2099-01-01T00:00:00Z" },
      limits: [
        { detail: { used: 10, limit: 100, name: "5h limit" }, window: { duration: 5, timeUnit: "HOUR" } },
        { detail: { used: 40, limit: 1000, name: "Weekly limit" }, window: { duration: 7, timeUnit: "DAY" } },
      ],
    })
    expect(parsed.summary).toMatchObject({ label: "Weekly limit", used: 40, limit: 1000 })
    expect(parsed.limits).toHaveLength(2)
    expect(parsed.limits[0]?.label).toMatch(/5h|limit/i)
  })

  it("handles remaining-based usage", () => {
    const parsed = parseKimiUsagePayload({
      usage: { remaining: 20, limit: 100, name: "Weekly" },
    })
    expect(parsed.summary).toMatchObject({ used: 80, limit: 100 })
  })

  it("parses official boosterWallet payload (string numbers + fixed-point amounts)", () => {
    // 结构对齐官方 kimi-code packages/oauth/src/managed-usage.ts 的 /usages 响应。
    const parsed = parseKimiUsagePayload({
      usage: { used: "40", limit: "1000", resetTime: "2026-08-03T05:20:51Z" },
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: "1", limit: "100", resetTime: "2026-08-03T05:20:51Z" } },
      ],
      boosterWallet: {
        balance: { type: "BOOSTER", amount: "1000000000", amountLeft: "800000000" },
        monthlyChargeLimit: { priceInCents: 10000, currency: "USD" },
        monthlyUsed: { priceInCents: 1234, currency: "USD" },
        monthlyChargeLimitEnabled: true,
      },
    })
    expect(parsed.summary).toMatchObject({ used: 40, limit: 1000 })
    expect(parsed.limits[0]?.label).toMatch(/5h/i)
    // amount ÷ 1_000_000 → cents：1000000000 → 1000¢ = $10；amountLeft → 800¢ = $8
    expect(parsed.wallet).toEqual({
      balanceCents: 800,
      totalCents: 1000,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 10000,
      monthlyUsedCents: 1234,
      currency: "USD",
    })
  })

  it("returns wallet=null when boosterWallet is absent or not BOOSTER type", () => {
    expect(parseKimiUsagePayload({ usage: { used: 1, limit: 10 } }).wallet).toBeNull()
    const nonBooster = parseKimiUsagePayload({
      usage: { used: 1, limit: 10 },
      boosterWallet: { balance: { type: "PAYG", amount: "100", amountLeft: "50" } },
    })
    expect(nonBooster.wallet).toBeNull()
  })
})

describe("kimiExternalId", () => {
  it("is stable for same subject", () => {
    expect(kimiExternalId("user-1", "rt-a")).toBe(kimiExternalId("user-1", "rt-b"))
    expect(kimiExternalId("user-1", "rt-a")).not.toBe(kimiExternalId("user-2", "rt-a"))
  })
})

describe("kimi oauth session flow", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("starts device authorization and completes after poll success", async () => {
    let stage = 0
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/device_authorization")) {
        return new Response(JSON.stringify({
          user_code: "ABCD-EFGH",
          device_code: "device-1",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("/api/oauth/token")) {
        const body = String(init?.body || "")
        if (body.includes("device_code")) {
          stage += 1
          if (stage === 1) {
            return new Response(JSON.stringify({ error: "authorization_pending" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            })
          }
          return new Response(JSON.stringify({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid",
          }), { status: 200, headers: { "content-type": "application/json" } })
        }
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const started = await startKimiOAuthSession("user-1")
    expect(started.userCode).toBe("ABCD-EFGH")
    expect(started.sessionId).toBeTruthy()

    const pending = await pollKimiOAuthSession("user-1", started.sessionId)
    expect(pending.status).toBe("pending")

    // advance past interval throttle
    await vi.advanceTimersByTimeAsync(1000)
    const success = await pollKimiOAuthSession("user-1", started.sessionId)
    expect(success).toMatchObject({
      status: "success",
      token: { accessToken: "access-1", refreshToken: "refresh-1" },
    })
  })

  it("rejects foreign session ownership", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      user_code: "CODE",
      device_code: "device-x",
      verification_uri: "https://auth.kimi.com/device",
      verification_uri_complete: "https://auth.kimi.com/device?user_code=CODE",
      expires_in: 600,
      interval: 5,
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch

    const started = await startKimiOAuthSession("owner-a")
    await expect(pollKimiOAuthSession("owner-b", started.sessionId)).rejects.toThrow(/missing or expired/i)
    cancelKimiOAuthSession("owner-a", started.sessionId)
  })
})
