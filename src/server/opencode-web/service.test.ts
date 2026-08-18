import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase } from "../db"
import { SecretVault } from "../crypto"
import { AccountRepository } from "../repository"
import { OpenCodeWebService } from "./service"
import { OpenCodeWebError as ClientError } from "./client"
import type { OpenCodeWebClient } from "./client"

const encryptionKey = Buffer.alloc(32, 3).toString("base64")
const dashboard = { subscriptionExists: true, goSubscriptionId: "sub_go_1", isZenSubscribed: false, zenSubscriptionId: null, hasManageSubscriptionButton: true, useBalance: false as boolean | null, useChinaProviders: null, usage: { FIVE_HOUR: { usagePercent: 10, resetInSeconds: 100 }, WEEKLY: { usagePercent: 20, resetInSeconds: 200 }, MONTHLY: { usagePercent: 30, resetInSeconds: 300 } } }

function setup() {
  const db = createDatabase(":memory:"); const now = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run("owner", "owner", "owner", "Owner", "USER", "hash", now, now)
  const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
  const client = { ensureManagedKey: vi.fn().mockResolvedValue({ id: "key_1", name: "OpenCode to API", key: "sk-go-secret", userId: "usr", email: "a@example.com", keyDisplay: "sk-..." }), dashboard: vi.fn().mockResolvedValue(dashboard), setChinaProviders: vi.fn().mockResolvedValue(undefined), referrals: vi.fn().mockResolvedValue(null), applyReferralReward: vi.fn().mockResolvedValue(undefined) } as unknown as OpenCodeWebClient
  return { db, repository, client, service: new OpenCodeWebService("owner", repository, client) }
}

describe("OpenCodeWebService", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("保存扩展来源元数据、密文凭据和自动 Go-only 结论", async () => {
    const { db, repository, service } = setup()
    const account = await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_abc", extensionVersion: "1.2.3" })
    expect(account).toMatchObject({ ownerUserId: "owner", credentialSource: "BROWSER_EXTENSION", extensionVersion: "1.2.3", subscriptionState: "ACTIVE", goSubscriptionId: "sub_go_1", hasManageSubscriptionButton: true, billingGuard: "VERIFIED_GO_ONLY", useBalance: false })
    const raw = db.prepare("SELECT auth_cookie_ciphertext,go_api_key_ciphertext FROM accounts").get() as Record<string, string>
    expect(JSON.stringify(raw)).not.toContain("browser-cookie-secret"); expect(JSON.stringify(raw)).not.toContain("sk-go-secret")
    expect(repository.getCredential(account!.id)?.goApiKey).toBe("sk-go-secret")
  })

  it("useBalance 未知时绝不进入 VERIFIED_GO_ONLY", async () => {
    const { client, service } = setup()
    vi.mocked(client.dashboard).mockResolvedValue({ ...dashboard, useBalance: null })
    expect(await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_unknown" })).toMatchObject({ billingGuard: "UNVERIFIED", useBalance: null })
  })

  it("同一 workspace 不能跨用户登记", async () => {
    const { db, service } = setup(); await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_same" })
    const now = new Date().toISOString(); db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)").run("other", "other", "other", "Other", "USER", "hash", now, now)
    const otherRepo = new AccountRepository("other", db, new SecretVault(encryptionKey))
    const otherClient = { ensureManagedKey: vi.fn().mockResolvedValue({ id: "key_2", name: "OpenCode to API", key: "sk-other", userId: "u", email: "b@example.com", keyDisplay: "sk-..." }), dashboard: vi.fn().mockResolvedValue(dashboard), setChinaProviders: vi.fn().mockResolvedValue(undefined) } as unknown as OpenCodeWebClient
    await expect(new OpenCodeWebService("other", otherRepo, otherClient).report({ authCookie: "another-browser-cookie", workspaceId: "wrk_same" })).rejects.toThrow(/already registered/)
  })

  it("扩展后续同步未提供名称或版本时保留用户名称和已知版本", async () => {
    const { repository, service } = setup()
    const first = await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_repeat", extensionVersion: "2.0.0", name: "我的主账号" })
    repository.updateState(first!.id, { name: "手动名称" })
    const second = await service.report({ authCookie: "new-browser-cookie-secret", workspaceId: "wrk_repeat" })
    expect(second).toMatchObject({ name: "手动名称", extensionVersion: "2.0.0" })
  })
})

describe("OpenCodeWebService referral", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("listReferralRewards 返回解析后的奖励摘要", async () => {
    const { client, service } = setup()
    await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_xyz" })
    const reported = await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_xyz" })
    vi.mocked(client.referrals).mockResolvedValue({
      referralCode: "CODE1",
      rewardAmount: 500,
      rewards: [{ id: "ref_1", source: "inviter", status: "available", email: "a@b.com", amount: 500, timeCreated: "2026-01-01T00:00:00.000Z", timeApplied: null }],
    })
    const result = await service.listReferralRewards(reported!.id)
    expect(result).toEqual({
      referralCode: "CODE1",
      rewardAmount: 500,
      rewards: [{ id: "ref_1", source: "inviter", status: "available", email: "a@b.com", amount: 500, timeCreated: "2026-01-01T00:00:00.000Z", timeApplied: null }],
    })
  })

  it("listReferralRewards 无奖励数据时返回空结构", async () => {
    const { client, service } = setup()
    await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_empty" })
    const acc = await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_empty" })
    vi.mocked(client.referrals).mockResolvedValue(null)
    expect(await service.listReferralRewards(acc!.id)).toEqual({ referralCode: null, rewardAmount: null, rewards: [] })
  })

  it("applyReferralReward 成功后触发 usage 刷新", async () => {
    const { client, service } = setup()
    const acc = await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_apply" })
    vi.mocked(client.applyReferralReward).mockResolvedValue(undefined)
    const result = await service.applyReferralReward(acc!.id, "ref_1")
    expect(result.applied).toBe(true)
    expect(client.applyReferralReward).toHaveBeenCalledWith("browser-cookie-secret", "wrk_apply", "ref_1")
    // refreshUsage 被触发（dashboard 调用次数增加：report 1 次 + refresh 1 次）
    expect(client.dashboard).toHaveBeenCalledTimes(2)
  })

  it("applyReferralReward AUTH 失败标记凭据失效", async () => {
    const { client, repository, service } = setup()
    const acc = await service.report({ authCookie: "browser-cookie-secret", workspaceId: "wrk_authfail" })
    vi.mocked(client.applyReferralReward).mockRejectedValue(new ClientError("expired", "AUTH"))
    await expect(service.applyReferralReward(acc!.id, "ref_1")).rejects.toMatchObject({ code: "AUTH" })
    expect(repository.get(acc!.id)!.authState).toBe("REAUTH_REQUIRED")
  })
})

