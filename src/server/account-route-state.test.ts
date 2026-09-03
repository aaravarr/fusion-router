import { describe, expect, it } from "vitest"
import { deriveAccountRouteStatus } from "./account-route-state"
import type { AccountRecord } from "./types"

function account(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: "account", ownerUserId: "owner", name: "account", poolType: "xai-grok", workspaceId: "workspace",
    email: null, goKeyId: "", credentialSource: "TEST", extensionVersion: null, lastSyncedAt: "2026-07-27T00:00:00.000Z",
    adminState: "ENABLED", authState: "VALID", subscriptionState: "ACTIVE", goSubscriptionId: null,
    isZenSubscribed: false, zenSubscriptionId: null, hasManageSubscriptionButton: false,
    billingGuard: "UNVERIFIED", useBalance: null, useChinaProviders: false, allowTraining: false, credentialVersion: 1, lastUsageCheckAt: null,
    nextUsageCheckAt: "2026-07-27T00:00:00.000Z", lastSelectedAt: null, lastRequestAt: null,
    lastSuccessAt: null, lastLimitAt: null, disabledReason: null, disabledAt: null, lastError: null,
    externalId: null, maxConcurrency: 1, ordinal: 0, createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z", ...overrides,
  }
}

describe("deriveAccountRouteStatus", () => {
  it("uses a deterministic hard-block priority", () => {
    expect(deriveAccountRouteStatus(account({ adminState: "DISABLED", authState: "AUTH_ERROR", disabledReason: "CREDENTIAL_INVALID" }), []))
      .toMatchObject({ routeState: "CREDENTIAL_INVALID", blockedUntil: null })
    expect(deriveAccountRouteStatus(account({ adminState: "DISABLED", disabledReason: "SPENDING_BLOCKED" }), []))
      .toMatchObject({ routeState: "SPENDING_BLOCKED", blockedUntil: null })
    expect(deriveAccountRouteStatus(account({ adminState: "DISABLED", disabledReason: "ADMIN_DISABLED" }), []))
      .toMatchObject({ routeState: "ADMIN_DISABLED", blockedUntil: null })
  })

  it("reports temporary blocks and their earliest recovery time", () => {
    const now = Date.parse("2026-07-27T00:00:00.000Z")
    expect(deriveAccountRouteStatus(account(), [
      { usagePercent: 100, resetAt: "2026-07-27T02:00:00.000Z" },
      { usagePercent: 100, resetAt: "2026-07-27T01:00:00.000Z" },
    ], now)).toMatchObject({ routeState: "TEMP_BLOCKED", blockedUntil: "2026-07-27T01:00:00.000Z" })
    expect(deriveAccountRouteStatus(account(), [{ usagePercent: 100, resetAt: "2026-07-26T23:00:00.000Z" }], now).routeState)
      .toBe("READY")
  })

  it("respects provider-specific readiness before reporting READY", () => {
    expect(deriveAccountRouteStatus(account(), [], Date.now(), {
      providerReady: false,
      providerUnavailableReason: "自定义 Provider 已停用",
    })).toEqual({ routeState: "UNAVAILABLE", routeReason: "自定义 Provider 已停用", blockedUntil: null })
    expect(deriveAccountRouteStatus(account({ subscriptionState: "INACTIVE" }), [], Date.now(), { providerReady: true }).routeState)
      .toBe("READY")
    expect(deriveAccountRouteStatus(account({ subscriptionState: "INACTIVE" }), [], Date.now(), { providerReady: false }).routeState)
      .toBe("SUBSCRIPTION_INACTIVE")
  })
})
