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
