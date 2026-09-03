import { AccountRepository } from "@/server/repository"
import type { AccessCredential } from "@/server/gateway"
import { OpenCodeWebClient, OpenCodeWebError, type OpenCodeWebCallOptions } from "./client"

export interface ReportBrowserAccountInput {
  authCookie: string
  workspaceId: string
  extensionVersion?: string | null
  name?: string
  /** 扩展上报请求的浏览器 UA，有用户在场时透传给 opencode.ai 控制面。 */
  userAgent?: string | null
}

const inflightReports = new Map<string, Promise<ReturnType<AccountRepository["get"]>>>()

export class OpenCodeWebService {
  constructor(readonly ownerUserId: string, readonly repository = new AccountRepository(ownerUserId), private readonly client = new OpenCodeWebClient()) {}

  async report(input: ReportBrowserAccountInput) {
    const key = `${this.ownerUserId}:${input.workspaceId}`
    const current = inflightReports.get(key)
    if (current) return current
    const task = this.reportOnce(input).finally(() => inflightReports.delete(key))
    inflightReports.set(key, task)
    return task
  }

  private async reportOnce(input: ReportBrowserAccountInput) {
    const callOptions: OpenCodeWebCallOptions = { userAgent: input.userAgent }
    const [managedKey, dashboard] = await Promise.all([
      this.client.ensureManagedKey(input.authCookie, input.workspaceId, callOptions),
      this.client.dashboard(input.authCookie, input.workspaceId, callOptions),
    ])
    // 账号录入时自动开启“部署在中国的模型”，失败不阻断录入主流程。
    await this.client.setChinaProviders(input.authCookie, input.workspaceId, true, callOptions).catch(() => undefined)
    const verified = dashboard.subscriptionExists && dashboard.useBalance === false
    const account = this.repository.upsertBrowserAccount({
      name: input.name,
      workspaceId: input.workspaceId,
      email: managedKey.email,
      authCookie: input.authCookie,
      goApiKey: managedKey.key,
      goKeyId: managedKey.id,
      extensionVersion: input.extensionVersion,
      subscriptionState: dashboard.subscriptionExists ? "ACTIVE" : "INACTIVE",
      goSubscriptionId: dashboard.goSubscriptionId,
      isZenSubscribed: dashboard.isZenSubscribed,
      zenSubscriptionId: dashboard.zenSubscriptionId,
      hasManageSubscriptionButton: dashboard.hasManageSubscriptionButton,
      billingGuard: verified ? "VERIFIED_GO_ONLY" : dashboard.useBalance ? "PAYG_FALLBACK_ENABLED" : "UNVERIFIED",
      useBalance: dashboard.useBalance,
      useChinaProviders: dashboard.useChinaProviders ?? true,
      // 上游默认关闭（row.allowTraining ?? false）；解析不到时按关闭记录，下次同步再校正。
      allowTraining: dashboard.allowTraining ?? false,
      usage: dashboard.usage,
    })
    if (verified) {
      void import("@/server/provider-models").then(({ syncProviderModelsForAccount }) =>
        syncProviderModelsForAccount(this.ownerUserId, account.id).catch(() => undefined),
      )
    }
    return account
  }

  async credential(accountId: string): Promise<AccessCredential> {
    const account = this.repository.getCredential(accountId)
    if (!account) throw new OpenCodeWebError("Account not found", "PROTOCOL")
    return { accountId, goApiKey: account.goApiKey, credentialVersion: account.credentialVersion }
  }

  async refreshUsage(accountId: string, options: OpenCodeWebCallOptions = {}) {
    const account = this.repository.getCredential(accountId)
    if (!account) return
    try {
      const dashboard = await this.client.dashboard(account.authCookie, account.workspaceId, options)
      const verified = dashboard.subscriptionExists && dashboard.useBalance === false
      const syncedAt = new Date().toISOString()
      this.repository.updateState(accountId, {
        subscriptionState: dashboard.subscriptionExists ? "ACTIVE" : "INACTIVE",
        goSubscriptionId: dashboard.goSubscriptionId,
        isZenSubscribed: dashboard.isZenSubscribed,
        zenSubscriptionId: dashboard.zenSubscriptionId,
        hasManageSubscriptionButton: dashboard.hasManageSubscriptionButton,
        billingGuard: verified ? "VERIFIED_GO_ONLY" : dashboard.useBalance ? "PAYG_FALLBACK_ENABLED" : "UNVERIFIED",
        useBalance: dashboard.useBalance,
        ...(dashboard.useChinaProviders == null ? {} : { useChinaProviders: dashboard.useChinaProviders }),
        ...(dashboard.allowTraining == null ? {} : { allowTraining: dashboard.allowTraining }),
        lastSyncedAt: syncedAt,
      })
      if (dashboard.usage) this.repository.updateUsage(accountId, dashboard.usage)
      else this.repository.scheduleUsageCheck(accountId, new Date(Date.now() + 6 * 60 * 60_000))
      return this.repository.get(accountId)
    } catch (cause) {
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") this.repository.markAuthError(accountId, true)
      else this.repository.scheduleUsageCheck(accountId, new Date(Date.now() + 5 * 60_000))
      throw cause
    }
  }

  async setChinaProviders(accountId: string, enabled: boolean, options: OpenCodeWebCallOptions = {}) {
    const account = this.repository.getCredential(accountId)
    if (!account) throw new OpenCodeWebError("Account not found", "PROTOCOL")
    try {
      await this.client.setChinaProviders(account.authCookie, account.workspaceId, enabled, options)
    } catch (cause) {
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") this.repository.markAuthError(accountId, true)
      throw cause
    }
    this.repository.updateState(accountId, { useChinaProviders: enabled })
    return this.repository.get(accountId)
  }

  async setAllowTraining(accountId: string, enabled: boolean, options: OpenCodeWebCallOptions = {}) {
    const account = this.repository.getCredential(accountId)
    if (!account) throw new OpenCodeWebError("Account not found", "PROTOCOL")
    try {
      await this.client.setAllowTraining(account.authCookie, account.workspaceId, enabled, options)
    } catch (cause) {
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") this.repository.markAuthError(accountId, true)
      throw cause
    }
    this.repository.updateState(accountId, { allowTraining: enabled })
    return this.repository.get(accountId)
  }

  async listReferralRewards(accountId: string, options: OpenCodeWebCallOptions = {}) {
    const account = this.repository.getCredential(accountId)
    if (!account) throw new OpenCodeWebError("Account not found", "PROTOCOL")
    try {
      const summary = await this.client.referrals(account.authCookie, account.workspaceId, options)
      return {
        referralCode: summary?.referralCode ?? null,
        rewardAmount: summary?.rewardAmount ?? null,
        rewards: summary?.rewards ?? [],
      }
    } catch (cause) {
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") this.repository.markAuthError(accountId, true)
      throw cause
    }
  }

  async applyReferralReward(accountId: string, referralId: string, options: OpenCodeWebCallOptions = {}) {
    const account = this.repository.getCredential(accountId)
    if (!account) throw new OpenCodeWebError("Account not found", "PROTOCOL")
    let applied = false
    try {
      await this.client.applyReferralReward(account.authCookie, account.workspaceId, referralId, options)
      applied = true
    } catch (cause) {
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") this.repository.markAuthError(accountId, true)
      throw cause
    }
    // 兑换成功后立即同步一次额度，让奖励计入后的余额尽快反映到配额（同一用户动作延续，带上操作者 UA）。
    if (applied) await this.refreshUsage(accountId, options).catch(() => undefined)
    return { applied, account: this.repository.get(accountId) }
  }
}


const services = new Map<string, OpenCodeWebService>()
export function getOpenCodeWebService(ownerUserId: string): OpenCodeWebService {
  const existing = services.get(ownerUserId)
  if (existing) return existing
  const service = new OpenCodeWebService(ownerUserId)
  services.set(ownerUserId, service)
  return service
}

export const getGoCredential = (ownerUserId: string, accountId: string) => getOpenCodeWebService(ownerUserId).credential(accountId)
