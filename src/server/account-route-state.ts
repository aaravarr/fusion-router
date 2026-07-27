import type { AccountRecord, AccountRouteState } from "./types"

export interface AccountRouteStatus {
  routeState: AccountRouteState
  routeReason: string
  blockedUntil: string | null
}

export interface RouteQuotaWindow {
  usagePercent: number | null
  resetAt: string | null
}

export interface AccountRouteStatusOptions {
  providerReady?: boolean
  providerUnavailableReason?: string | null
}

const reasonLabels: Record<string, string> = {
  XAI_ACCOUNT_BANNED: "xAI 上游已永久封禁此账号",
  CREDENTIAL_INVALID: "凭据无效或已过期，需要重新认证",
  SPENDING_BLOCKED: "上游消费额度或订阅受限，已自动停用",
  ADMIN_DISABLED: "管理员已手动停用",
}

/**
 * 账号列表、详情和调度说明共用的唯一状态口径。
 * 优先级：永久封禁 > 凭据失效 > 消费受限 > 人工停用 > 账号配置 > 临时额度阻塞 > 可用。
 */
export function deriveAccountRouteStatus(
  account: AccountRecord,
  windows: RouteQuotaWindow[],
  now = Date.now(),
  options: AccountRouteStatusOptions = {},
): AccountRouteStatus {
  const disabledReason = account.disabledReason || ""
  if (disabledReason === "XAI_ACCOUNT_BANNED") {
    return { routeState: "UPSTREAM_BANNED", routeReason: reasonLabels.XAI_ACCOUNT_BANNED, blockedUntil: null }
  }
  if (disabledReason === "CREDENTIAL_INVALID" || account.authState === "REAUTH_REQUIRED" || account.authState === "AUTH_ERROR") {
    return { routeState: "CREDENTIAL_INVALID", routeReason: reasonLabels.CREDENTIAL_INVALID, blockedUntil: null }
  }
  if (disabledReason === "SPENDING_BLOCKED") {
    return { routeState: "SPENDING_BLOCKED", routeReason: reasonLabels.SPENDING_BLOCKED, blockedUntil: null }
  }
  if (account.adminState === "DISABLED") {
    return {
      routeState: "ADMIN_DISABLED",
      routeReason: reasonLabels[disabledReason] || disabledReason || reasonLabels.ADMIN_DISABLED,
      blockedUntil: null,
    }
  }
  if (options.providerReady === false && account.subscriptionState !== "ACTIVE") {
    return { routeState: "SUBSCRIPTION_INACTIVE", routeReason: "订阅未激活或校验失败", blockedUntil: null }
  }
  if (options.providerReady === false && account.poolType === "opencode-go" && (account.billingGuard !== "VERIFIED_GO_ONLY" || account.useBalance !== false)) {
    return { routeState: "BILLING_UNSAFE", routeReason: "计费安全状态未验证，禁止参与路由", blockedUntil: null }
  }
  if (options.providerReady === false) {
    return { routeState: "UNAVAILABLE", routeReason: options.providerUnavailableReason || "Provider 规则判定该账号不可参与路由", blockedUntil: null }
  }

  const activeBlocks = windows.filter((window) => {
    if ((window.usagePercent ?? 0) < 100) return false
    if (!window.resetAt) return true
    const resetAt = Date.parse(window.resetAt)
    return Number.isFinite(resetAt) && resetAt > now
  })
  if (activeBlocks.length) {
    const finiteResets = activeBlocks
      .map((window) => window.resetAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    const blockedUntil = activeBlocks.some((window) => !window.resetAt) ? null : finiteResets[0] ?? null
    return {
      routeState: "TEMP_BLOCKED",
      routeReason: blockedUntil ? "上游额度或限流窗口尚未恢复" : "上游额度已耗尽，等待重新观测",
      blockedUntil,
    }
  }
  return { routeState: "READY", routeReason: "账号可参与路由", blockedUntil: null }
}
