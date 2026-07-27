import { beforeEach, describe, expect, it } from "vitest"
import { SecretVault } from "../crypto"
import { createDatabase } from "../db"
import { AccountRepository } from "../repository"
import { RoutingService } from "../routing"
import { XAIGrokProvider } from "./xai-grok"

const encryptionKey = Buffer.alloc(32, 6).toString("base64")
const ownerUserId = "xai-error-owner"

function setup() {
  const db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, ownerUserId, ownerUserId, "xAI Error Owner", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
  const account = accounts.createProviderAccount({ name: "xAI seat", poolType: "xai-grok", externalId: "xai-error-seat" })
  return { db, account, routing: new RoutingService(ownerUserId, db) }
}

describe("xAI error classification and account state", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })
  const provider = new XAIGrokProvider()

  it.each([
    JSON.stringify({ error: { message: "Invalid or expired credentials" } }),
    JSON.stringify({ error: { code: "PermissionDenied", message: "denied" } }),
    JSON.stringify({ error: "PermissionDenied" }),
    JSON.stringify({ error: { message: "no auth context" } }),
  ])("精确凭证错误会切号并迁移到 AUTH_ERROR", (body) => {
    const classified = provider.classifyError(401, body, new Headers())
    expect(classified).toMatchObject({ shouldSwitchAccount: true, permanentlyDisableAccount: true, errorType: "CREDENTIAL_INVALID" })
    const { db, account, routing } = setup()

    routing.markPermanentlyDisabled(account.id, classified!.errorType, "Invalid or expired credentials")

    expect(db.prepare("SELECT admin_state,auth_state,disabled_reason,last_error FROM accounts WHERE id=?").get(account.id))
      .toEqual({ admin_state: "DISABLED", auth_state: "AUTH_ERROR", disabled_reason: "CREDENTIAL_INVALID", last_error: "Invalid or expired credentials" })
    expect(db.prepare("SELECT type,severity,metadata_json FROM events WHERE account_id=? ORDER BY created_at DESC LIMIT 1").get(account.id))
      .toMatchObject({ type: "ACCOUNT_CREDENTIAL_INVALID", severity: "ERROR" })
  })

  it("spending-limit 402 会停用账号但不伪装成额度 cooldown", () => {
    const body = JSON.stringify({ code: "personal-team-blocked:spending-limit", message: "team spending is blocked" })
    const classified = provider.classifyError(402, body, new Headers())
    expect(classified).toEqual({ shouldSwitchAccount: true, errorType: "SPENDING_BLOCKED", permanentlyDisableAccount: true })
    const { db, account, routing } = setup()

    routing.markPermanentlyDisabled(account.id, classified!.errorType, "team spending is blocked")

    expect(db.prepare("SELECT admin_state,auth_state,disabled_reason FROM accounts WHERE id=?").get(account.id))
      .toEqual({ admin_state: "DISABLED", auth_state: "VALID", disabled_reason: "SPENDING_BLOCKED" })
    expect(db.prepare("SELECT COUNT(*) AS value FROM quota_windows WHERE account_id=?").get(account.id)).toEqual({ value: 0 })
    expect(db.prepare("SELECT type,severity FROM events WHERE account_id=? ORDER BY created_at DESC LIMIT 1").get(account.id))
      .toEqual({ type: "ACCOUNT_SPENDING_BLOCKED", severity: "WARN" })
  })

  it("429 仍是临时 cooldown，未知 401/402 不过度匹配", () => {
    expect(provider.classifyError(429, "{}", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      quotaKind: "PROVIDER_RATE_LIMIT",
      errorType: "XAI_TEMPORARILY_RATE_LIMITED",
    })
    expect(provider.classifyError(401, JSON.stringify({ message: "authorization failed" }), new Headers())).toBeNull()
    expect(provider.classifyError(402, JSON.stringify({ code: "payment-required" }), new Headers())).toBeNull()
    expect(provider.classifyError(200, JSON.stringify({ code: "personal-team-blocked:spending-limit" }), new Headers())).toBeNull()
  })
})
