import { Badge } from "@/components/ui/badge";
import type { Account, QuotaWindow } from "./types";
import { formatDate, formatDuration } from "./page-kit";

export const POOL_TYPE_META: Record<string, { label: string; description: string; quotaKinds: string[] }> = {
  "opencode-go": { label: "OpenCode Go", description: "Google 登录 + Go API Key", quotaKinds: ["fiveHour", "weekly", "monthly"] },
  "openai": { label: "OpenAI", description: "Codex AT token 或 OAuth 刷新", quotaKinds: ["fiveHour", "weekly"] },
  "xai-grok": { label: "xAI Grok", description: "xAI 免费 OAuth，滚动 24h 100 万 token", quotaKinds: ["rolling24h"] },
  "kimi-code": { label: "Kimi Code", description: "Kimi Code 设备码 OAuth，5h + weekly 额度", quotaKinds: ["fiveHour", "weekly"] },
};

export function getPoolLabel(poolType?: string | null) {
  return POOL_TYPE_META[poolType || "opencode-go"]?.label ?? poolType ?? "OpenCode Go";
}

export function getPoolQuotaKinds(poolType?: string | null) {
  return POOL_TYPE_META[poolType || "opencode-go"]?.quotaKinds ?? ["fiveHour", "weekly", "monthly"];
}

export function PoolTypeBadge({ poolType }: { poolType?: string | null }) {
  const type = poolType || "opencode-go";
  const meta = POOL_TYPE_META[type];
  const isOpenAI = type === "openai";
  const isGrok = type === "xai-grok";
  const isKimi = type === "kimi-code";
  return (
    <Badge
      variant="outline"
      className={`h-5 rounded-sm px-1.5 text-[11px] font-medium ${
        isOpenAI
          ? "border-violet/20 bg-violet-soft text-violet-deep"
          : isGrok
            ? "border-emerald/30 bg-emerald-soft text-emerald-deep"
            : isKimi
              ? "border-orange-300/40 bg-orange-50 text-orange-700"
              : "border-info/20 bg-info-soft text-info"
      }`}
    >
      {meta?.label ?? type}
    </Badge>
  );
}

const statusLabels: Record<string, string> = {
  active: "可用",
  available: "可用",
  blocked: "额度阻塞",
  exhausted: "额度阻塞",
  disabled: "已停用",
  subscription_inactive: "订阅无效",
  sub_expired: "订阅无效",
  auth_error: "认证异常",
  expired: "认证过期",
  pending: "待同步",
  unverified: "不可路由",
  error: "异常",
  banned: "已封禁",
  queued: "排队中",
  running: "处理中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  unknown: "未知",
};

export function StatusBadge({ status }: { status?: string | null }) {
  const key = (status || "unknown").toLowerCase();
  const available = key === "available" || key === "active" || key === "success" || key === "completed";
  const warning = key === "blocked" || key === "exhausted" || key === "pending" || key === "unverified" || key === "cooldown" || key === "queued" || key === "running";
  const danger = key.includes("error") || key.includes("expired") || key.includes("inactive") || key === "failed" || key === "banned";
  return (
    <Badge
      variant="outline"
      className={`h-5 rounded-sm px-1.5 text-[11px] font-medium ${
        available
          ? "border-success/20 bg-success-soft text-success"
          : warning
            ? "border-warning/20 bg-warning-soft text-warning"
            : danger
              ? "border-destructive/20 bg-destructive/5 text-destructive"
              : "bg-[#fafafa] text-muted-foreground"
      }`}
    >
      {statusLabels[key] || status || "未知"}
    </Badge>
  );
}

export function AccountBadges({ account }: { account: Account }) {
  const status = account.disabledReason === "XAI_ACCOUNT_BANNED"
    ? "banned"
    : account.adminState === "DISABLED"
    ? "disabled"
    : account.authState === "AUTH_ERROR" || account.authState === "REAUTH_REQUIRED"
      ? "auth_error"
      : account.subscriptionState === "INACTIVE" || account.subscriptionState === "VERIFY_ERROR"
        ? "subscription_inactive"
        : account.billingGuard !== "VERIFIED_GO_ONLY"
          ? "unverified"
          : account.status || "available";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={account.enabled === false ? "disabled" : status} />
      {account.isCurrent ? (
        <Badge variant="outline" className="h-5 rounded-sm border-info/20 bg-info-soft px-1.5 text-[11px] text-info">当前服务</Badge>
      ) : null}
      {account.isPreferred ? (
        <Badge variant="outline" className="h-5 rounded-sm border-info/20 bg-white px-1.5 text-[11px] text-info">优先</Badge>
      ) : null}
    </div>
  );
}

export function BillingSafetyBadge({ account }: { account: Account }) {
  const poolType = account.poolType || "opencode-go";
  if (poolType === "xai-grok") {
    return <Badge variant="outline" className="h-5 rounded-sm border-emerald/30 bg-emerald-soft px-1.5 text-[11px] text-emerald-deep">OAuth Free</Badge>;
  }
  if (poolType === "kimi-code") {
    return <Badge variant="outline" className="h-5 rounded-sm border-orange-300/40 bg-orange-50 px-1.5 text-[11px] text-orange-700">Kimi OAuth</Badge>;
  }
  if (poolType === "openai") {
    return <Badge variant="outline" className="h-5 rounded-sm border-violet/20 bg-violet-soft px-1.5 text-[11px] text-violet-deep">OpenAI Codex</Badge>;
  }
  const verified = account.billingGuard === "VERIFIED_GO_ONLY";
  const label = verified
    ? "Go only"
    : account.useBalance === true
      ? "按量回退已开启"
      : "回退状态未知";
  return (
    <Badge
      variant="outline"
      className={`h-5 rounded-sm px-1.5 text-[11px] ${verified ? "border-success/20 bg-success-soft text-success" : "border-warning/20 bg-warning-soft text-warning"}`}
    >
      {label}
    </Badge>
  );
}

export function getQuota(account: Account, key: "fiveHour" | "weekly" | "monthly" | "rolling24h") {
  if (Array.isArray(account.quotaWindows)) {
    const aliases =
      key === "fiveHour"
        ? ["fiveHour", "five_hour", "5h", "FIVE_HOUR"]
        : key === "rolling24h"
          ? ["rolling24h", "ROLLING_24H", "ROLLING", "24h"]
          : key === "weekly"
            ? ["weekly", "week", "WEEKLY"]
            : ["monthly", "month", "MONTHLY"];
    const found = account.quotaWindows.find((quota) => aliases.includes(String(quota.kind || "")));
    if (!found) return null;
    return {
      ...found,
      status: found.status || (Number(found.usagePercent) >= 100 || found.blockedAt ? "blocked" : found.lastObservedAt ? "available" : "unknown"),
      resetInSec: found.resetInSec ?? found.retryAfterSeconds,
    };
  }
  // Legacy/shaped accounts only expose fiveHour/weekly/monthly keys; the
  // rolling24h kind is a modern-windowed pool with no legacy slot, so remap it
  // to fiveHour for the backcompat lookup.
  const legacyKey = key === "rolling24h" ? "fiveHour" : key;
  const legacy = account.quotaWindows?.[legacyKey] ?? account.quotas?.[legacyKey] ?? account[legacyKey];
  return legacy ?? null;
}

export function QuotaStatus({
  label,
  quota,
  variant = "compact",
}: {
  label: string;
  quota?: QuotaWindow | null;
  variant?: "compact" | "card";
}) {
  const state = quota?.status || "unknown";
  // Keep real over-limit percentages (can exceed 100%) so free-tier overspend is visible.
  const used = quota?.usagePercent == null ? null : Math.round(Math.max(0, Number(quota.usagePercent)) * 100) / 100;
  const remaining = used == null ? null : Math.round((100 - used) * 100) / 100;
  const usedTokens = quota?.limitValue != null && quota?.remainingValue != null
    ? Number(quota.limitValue) - Number(quota.remainingValue)
    : null;
  const limitTokens = quota?.limitValue == null ? null : Number(quota.limitValue);
  const reset = quota?.resetInSec != null
    ? formatDuration(quota.resetInSec)
    : quota?.resetAt
      ? formatDate(quota.resetAt)
      : null;
  const overLimit = used != null && used > 100;
  const stateLabel = overLimit || state === "blocked" || (used != null && used >= 100)
    ? (overLimit ? "已超限" : "已耗尽")
    : state === "available"
      ? "可用"
      : "待观测";
  const resetLabel = state === "blocked" ? "预计恢复" : "下次重置";

  if (variant === "card") {
    const primary = used != null ? used.toFixed(2) : state === "blocked" ? "100.00" : "—";
    return (
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${overLimit || state === "blocked" || (used != null && used >= 100) ? "bg-warning" : state === "available" ? "bg-success" : "bg-muted-foreground/40"}`} aria-hidden="true" />
            <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
          </div>
          <span className={`shrink-0 text-[10px] font-medium ${overLimit || state === "blocked" || (used != null && used >= 100) ? "text-warning" : state === "available" ? "text-success" : "text-muted-foreground"}`}>{stateLabel}</span>
        </div>
        <div className="mt-3 flex min-w-0 items-baseline gap-1">
          <span className="font-mono text-2xl font-medium tracking-[-0.04em] tabular-nums">{primary}</span>
          <span className="text-[11px] text-muted-foreground">{used != null || state === "blocked" ? "% 已用" : "暂无数据"}</span>
        </div>
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-black/5"
          role="progressbar"
          aria-label={`${label} 已使用额度`}
          aria-valuemin={0}
          aria-valuemax={Math.max(100, used ?? 100)}
          aria-valuenow={used ?? undefined}
        >
          <div className={`h-full rounded-full ${used != null && used >= 100 ? "bg-warning" : "bg-foreground/70"}`} style={{ width: `${Math.min(100, used ?? 0)}%` }} />
        </div>
        {usedTokens != null && limitTokens != null ? (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {compactNumber(usedTokens)} / {compactNumber(limitTokens)} tokens
            {overLimit ? ` · 超 ${compactNumber(usedTokens - limitTokens)}` : ""}
          </p>
        ) : null}
        <div className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-t pt-2.5 text-[10px]">
          <span className="text-muted-foreground">{resetLabel}</span>
          <span className="truncate text-right font-mono text-foreground" title={reset ?? undefined}>{reset ?? (state === "unknown" ? "尚无观测" : "未返回")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${overLimit || state === "blocked" || (used != null && used >= 100) ? "bg-warning" : state === "available" ? "bg-success" : "bg-muted-foreground/40"}`} aria-hidden="true" />
        <span className="truncate text-xs font-medium">{label}</span>
        </div>
        {used != null ? <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{used.toFixed(2)}%</span> : null}
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/5"
        role="progressbar"
        aria-label={`${label} 已使用额度`}
        aria-valuemin={0}
        aria-valuemax={Math.max(100, used ?? 100)}
        aria-valuenow={used ?? undefined}
      >
        <div className={`h-full rounded-full ${used != null && used >= 100 ? "bg-warning" : "bg-foreground/70"}`} style={{ width: `${Math.min(100, used ?? 0)}%` }} />
      </div>
      {usedTokens != null && limitTokens != null ? (
        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={`${usedTokens} / ${limitTokens} tokens`}>
          {compactNumber(usedTokens)} / {compactNumber(limitTokens)} tokens
          {overLimit ? ` · 超 ${compactNumber(usedTokens - limitTokens)}` : ""}
        </p>
      ) : (
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={reset ?? undefined}>
        {overLimit || state === "blocked" || (used != null && used >= 100)
          ? (reset ? `重置 ${reset}` : overLimit ? "已超限" : "已耗尽")
          : state === "available"
            ? (reset ? `重置 ${reset}` : "已观测")
            : "等待首次请求或手动同步"}
      </p>
      )}
    </div>
  );
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
