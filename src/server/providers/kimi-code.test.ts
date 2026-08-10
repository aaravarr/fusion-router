import { describe, expect, it } from "vitest"
import { KimiCodeProvider } from "./kimi-code"

const provider = new KimiCodeProvider()

describe("KimiCodeProvider.classifyError", () => {
  it("maps structured 429 quota exhaustion (error.type=exceeded_current_quota_error) to KIMI_QUOTA_EXCEEDED", () => {
    const result = provider.classifyError(429, JSON.stringify({
      error: { type: "exceeded_current_quota_error", message: "You exceeded your current quota" },
    }), new Headers())
    expect(result).toMatchObject({
      shouldSwitchAccount: true,
      quotaKind: "WEEKLY",
      errorType: "KIMI_QUOTA_EXCEEDED",
    })
  })

  it("maps 429 with billing wording to KIMI_QUOTA_EXCEEDED (non-JSON body)", () => {
    // 官方 kimi-errors.ts 的 message 模式：insufficient balance / recharge / in arrears
    expect(provider.classifyError(429, "Your account is in arrears, please recharge", new Headers()))
      .toMatchObject({ errorType: "KIMI_QUOTA_EXCEEDED" })
    expect(provider.classifyError(429, "insufficient balance", new Headers()))
      .toMatchObject({ errorType: "KIMI_QUOTA_EXCEEDED" })
  })

  it("keeps plain 429 as transient rate limit", () => {
    const result = provider.classifyError(429, "rate limit exceeded, retry later", new Headers())
    expect(result).toMatchObject({
      shouldSwitchAccount: true,
      retrySameAccount: { maxRetries: 10 },
      quotaKind: "PROVIDER_RATE_LIMIT",
      errorType: "KIMI_RATE_LIMITED",
    })
  })

  it("maps 402 to quota/account-level switch (membership/billing class)", () => {
    expect(provider.classifyError(402, "unable to verify membership", new Headers()))
      .toMatchObject({ shouldSwitchAccount: true, errorType: "KIMI_QUOTA_EXCEEDED" })
  })

  it("maps 401/403 to AuthenticationError without switching", () => {
    expect(provider.classifyError(401, "invalid token", new Headers()))
      .toMatchObject({ shouldSwitchAccount: false, errorType: "AuthenticationError" })
    expect(provider.classifyError(403, "forbidden", new Headers()))
      .toMatchObject({ shouldSwitchAccount: false, errorType: "AuthenticationError" })
  })

  it("returns null for unrelated statuses", () => {
    expect(provider.classifyError(500, "oops", new Headers())).toBeNull()
    expect(provider.classifyError(200, "ok", new Headers())).toBeNull()
  })
})
