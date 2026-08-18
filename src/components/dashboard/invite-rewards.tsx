"use client";

import { useCallback, useEffect, useState } from "react";
import { Gift, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "./page-kit";
import type { Account, ReferralSummary } from "./types";

const STATUS_TEXT: Record<"available" | "applied" | "pending", string> = {
  available: "可用",
  applied: "已使用",
  pending: "待定",
};

function statusVariant(status: string): "default" | "outline" | "secondary" {
  if (status === "available") return "default";
  if (status === "pending") return "secondary";
  return "outline";
}

function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

export function InviteRewardsSection({
  account,
  adminFetch,
  onRefresh,
}: {
  account: Account;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onRefresh: (account: Account) => Promise<void>;
}) {
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/accounts/" + encodeURIComponent(account.id) + "/referrals");
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "获取邀请奖励失败");
      setSummary(payload as ReferralSummary);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "获取邀请奖励失败");
    } finally {
      setLoading(false);
    }
  }, [account.id, adminFetch]);

  useEffect(() => {
    // 延后一拍发起请求，避免在 effect 内同步 setState 触发级联渲染。
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function handleApply(reward: ReferralSummary["rewards"][number]) {
    setApplyingId(reward.id);
    setNotice(null);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/accounts/" + encodeURIComponent(account.id) + "/referrals/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referralId: reward.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "兑换失败");
      setNotice("已兑换 " + formatCents(reward.amount) + "，额度稍后同步");
      await load();
      // 奖励计入余额后配额会变化，顺手刷新账号额度。
      await onRefresh(account).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "兑换失败，请重试");
    } finally {
      setApplyingId(null);
    }
  }

  const rewards = summary?.rewards ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-4 text-muted-foreground">
          共 {rewards.length} 个奖励 ·
          {summary?.rewardAmount != null ? (
            <span className="font-medium text-foreground"> 可用 {formatCents(summary.rewardAmount)}</span>
          ) : (
            " 暂无可用金额"
          )}
          {summary?.referralCode ? <span className="ml-1 font-mono">（邀请码 {summary.referralCode}）</span> : null}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : undefined} data-icon="inline-start" />刷新
        </Button>
      </div>

      {loading ? (
        <div className="rounded-md border bg-[#fafafa] px-3.5 py-3 text-xs text-muted-foreground">正在读取邀请奖励…</div>
      ) : error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-3 text-xs leading-5 text-destructive">{error}</div>
      ) : rewards.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border bg-[#fafafa] px-3.5 py-3 text-xs text-muted-foreground">
          <Gift data-icon="inline-start" />暂无邀请奖励。
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {rewards.map((reward) => (
            <div key={reward.id} className="flex flex-wrap items-center gap-2 px-3.5 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium tabular-nums">{formatCents(reward.amount)}</span>
                <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground" title={reward.email ?? undefined}>
                  {reward.source === "inviter"
                    ? reward.email ? "由 " + reward.email + " 邀请" : "由他人邀请"
                    : "邀请 " + (reward.email ?? "未记录")}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {formatDate(reward.timeApplied ?? reward.timeCreated)}
                  {reward.status === "applied" && reward.timeApplied ? " 已兑换" : ""}
                </span>
              </span>
              <Badge variant={statusVariant(reward.status)} className="h-5 rounded-sm px-1.5 text-[11px]">
                {STATUS_TEXT[reward.status]}
              </Badge>
              {reward.status === "available" ? (
                <Button size="sm" variant="outline" onClick={() => void handleApply(reward)} disabled={applyingId !== null}>
                  {applyingId === reward.id ? "兑换中…" : "兑换"}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {notice ? <p className="text-[11px] text-emerald-deep">{notice}</p> : null}
    </div>
  );
}
