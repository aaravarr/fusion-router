import { AccountRepository } from "@/server/repository"
import type { AccessCredential } from "@/server/gateway"
import { OpenCodeWebClient, OpenCodeWebError } from "./client"

export interface ReportBrowserAccountInput {
  authCookie: string
  workspaceId: string
  extensionVersion?: string | null
  name?: string
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
    const [managedKey, dashboard] = await Promise.all([
      this.client.ensureManagedKey(input.authCookie, input.workspaceId),
      this.client.dashboard(input.authCookie, input.workspaceId),
    ])
    // 账号录入时自动开启“部署在中国的模型”，失败不阻断录入主流程。
    await this.client.setChinaProviders(input.authCookie, input.workspaceId, true).catch(() => undefined)
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

  async refreshUsage(accountId: string) {
    const account = this.repository.getCredential(accountId)
    if (!account) return
    try {
      const dashboard = await this.client.dashboard(account.authCookie, account.workspaceId)
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

  async setChinaProviders(accountId: string, enabled: boolean) {
    const account = this.repository.getCredential(accountId)
    if (!account) throw new OpenCodeWebError("Account not found", "PROTOCOL")
    try {
      await this.client.setChinaProviders(account.authCookie, account.workspaceId, enabled)
    } catch (cause) {
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") this.repository.markAuthError(accountId, true)
      throw cause
    }
    this.repository.updateState(accountId, { useChinaProviders: enabled })
    return this.repository.get(accountId)
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
