"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Clock3, RefreshCw, ShieldAlert, UsersRound } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { PageIntro, Panel, ErrorState, LoadingTable, EmptyState, formatDate } from "./page-kit";
import { getPoolLabel, StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { OverviewPayload, UsageStats } from "./types";

const trendPalette = ["#0070f3", "#00a0a0", "#0a7a3e", "#7928ca"];
const trendConfig: ChartConfig = {
  uncachedIn: { label: "输入", color: trendPalette[0] },
  cached: { label: "缓存", color: trendPalette[1] },
  outputNonReason: { label: "输出", color: trendPalette[2] },
  reasoning: { label: "推理", color: trendPalette[3] },
  requests: { label: "请求数", color: "#ab570a" },
};

export function OverviewPage() {
  const resource = useAdminResource<OverviewPayload>("/api/admin/overview");
  const usageResource = useAdminResource<UsageStats>("/api/admin/usage?hours=24&granularity=auto");
  const data = resource.data;
  const poolLabels = useMemo(
    () => Object.fromEntries((data?.poolTypes ?? []).map((item) => [item.type, item.label])),
    [data?.poolTypes],
  );

  return (
    <>
      <PageIntro
        eyebrow="POOL OVERVIEW"
        title="账号池总览"
        description="优先关注当前可路由账号、最近切号和最早恢复时间。这里不主动探测闲置账号。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
            <RefreshCw data-icon="inline-start" />刷新缓存
          </Button>
        }
      />

      {resource.error ? <Panel><ErrorState message={resource.error} onRetry={() => void resource.refresh()} /></Panel> : null}
      {!resource.error ? (
        <div className="space-y-4">
          <section className="dashboard-surface grid overflow-hidden rounded-lg bg-white sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={UsersRound} label="账号总数" value={data?.counts?.totalAccounts ?? data?.stats?.totalAccounts} note="已录入账号" />
            <Metric icon={CheckCircle2} label="当前可路由" value={data?.counts?.readyAccounts ?? data?.stats?.availableAccounts} note="可立即承载请求" tone="success" />
            <Metric icon={Clock3} label="额度冷却中" value={data?.counts?.quotaBlocked ?? data?.stats?.coolingAccounts} note="等待窗口恢复" />
            <Metric icon={ShieldAlert} label="不可用" value={data?.counts?.inactiveAccounts ?? data?.stats?.unavailableAccounts} note="订阅、认证或已停用" />
          </section>

          {data?.counts?.byPoolType ? (
            <Panel title="按号池类型统计" description="每种号池的账号健康度分布。">
              <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(data.counts.byPoolType).map(([poolType, counts]) => (
                  <PoolTypeStatCard key={poolType} poolType={poolType} label={poolLabels[poolType]} counts={counts} />
                ))}
              </div>
            </Panel>
          ) : null}

          <Panel title="24 小时 Token 趋势" description="堆叠柱图展示 Token 分段，折线展示请求数。">
            {usageResource.loading ? <LoadingTable rows={3} columns={6} /> : usageResource.error ? (
              <ErrorState message={usageResource.error} onRetry={() => void usageResource.refresh()} />
            ) : usageResource.data?.byTime?.length ? (
              <MiniTokenTrend data={usageResource.data} />
            ) : (
              <EmptyState title="暂无趋势数据" description="最近 24 小时没有请求记录。" />
            )}
          </Panel>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
            <Panel title="路由状态" description="自动回退始终开启，优先账号只影响第一候选。">
              {resource.loading ? <LoadingTable rows={3} columns={2} /> : data?.routing ? (
                <div className="divide-y">
                  <OverviewRow label="当前服务账号" value={data.routing.currentAccountName || data.routing.currentAccountId || "当前没有服务账号"} mono />
                  <OverviewRow label="优先账号" value={data.routing.preferredAccountName || data.routing.preferredAccountId || "未指定，按候选顺序选择"} mono />
                  <OverviewRow label="最早恢复" value={data.routing.nextRecoveryAt ? formatDate(data.routing.nextRecoveryAt) : "暂无明确恢复时间"} mono />
                </div>
              ) : (
                <EmptyState title="尚无路由状态" description="录入并验证至少一个 Provider 账号后，路由状态会显示在这里。" action={<Button asChild size="sm"><Link href="/accounts">录入账号</Link></Button>} />
              )}
            </Panel>

            <Panel title="快捷操作" description="保持关键操作在两步以内。">
              <div className="divide-y px-1">
                <QuickLink href="/accounts" title="管理账号池" detail="按 Provider 接入账号并查看额度状态" />
                <QuickLink href="/routing" title="设置优先账号" detail="优先尝试，额度不足时继续自动回退" />
                <QuickLink href="/api-keys" title="创建 API 密钥" detail="为外部客户端创建统一入口" />
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="最近请求" description="只显示缓存的请求结果，不触发额度检查。">
              {resource.loading ? <LoadingTable rows={4} columns={4} /> : data?.recentRequests?.length ? (
                <div className="divide-y">
                  {data.recentRequests.slice(0, 6).map((request) => (
                    <Link key={request.id} href="/requests" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-[#fafafa] sm:px-5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{request.model || "未记录模型"}</p>
                        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{request.id}</p>
                      </div>
                      <div className="text-right">
                        <StatusBadge status={String(request.status || "unknown")} />
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatDate(request.createdAt)}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : <EmptyState title="暂无请求" description="外部 API 收到请求后，最终服务账号和切号次数会显示在这里。" />}
            </Panel>

            <Panel title="最近事件" description="各 Provider 的额度、凭据、订阅与路由状态变化。">
              {resource.loading ? <LoadingTable rows={4} columns={3} /> : data?.recentEvents?.length ? (
                <div className="divide-y">
                  {data.recentEvents.slice(0, 6).map((event) => (
                    <Link key={event.id} href="/events" className="flex items-start gap-3 px-4 py-3 hover:bg-[#fafafa] sm:px-5">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{event.message || event.type || "系统事件"}</p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatDate(event.createdAt)}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : <EmptyState title="暂无事件" description="账号状态发生变化后，恢复和安全事件会显示在这里。" />}
            </Panel>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Metric({ icon: Icon, label, value, note, tone }: { icon: typeof UsersRound; label: string; value?: number; note: string; tone?: "success" }) {
  return (
    <div className="border-b p-4 last:border-b-0 sm:min-h-28 xl:border-r xl:border-b-0 xl:last:border-r-0">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Icon className={`size-4 ${tone === "success" ? "text-success" : "text-muted-foreground"}`} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <p className="tabular mt-3 text-2xl font-semibold tracking-[-0.04em]">{value ?? "未知"}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
    </div>
  );
}

function PoolTypeStatCard({ poolType, label: poolLabel, counts }: { poolType: string; label?: string; counts: { total: number; ready: number; blocked: number; inactive: number } }) {
  const label = getPoolLabel(poolType, poolLabel);
  return (
    <div className="space-y-3 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <span className="tabular text-lg font-semibold tracking-[-0.04em]">{counts.total}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md bg-success-soft/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">就绪</p>
          <p className="tabular mt-0.5 text-sm font-semibold text-success">{counts.ready}</p>
        </div>
        <div className="rounded-md bg-warning-soft/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">封禁</p>
          <p className="tabular mt-0.5 text-sm font-semibold text-warning">{counts.blocked}</p>
        </div>
        <div className="rounded-md bg-destructive/5 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">失活</p>
          <p className="tabular mt-0.5 text-sm font-semibold text-destructive">{counts.inactive}</p>
        </div>
      </div>
    </div>
  );
}

function OverviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center sm:px-5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`truncate text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function QuickLink({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link href={href} className="group flex items-center gap-3 px-3 py-3 hover:bg-[#fafafa]">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
    </Link>
  );
}

function MiniTokenTrend({ data }: { data: UsageStats }) {
  const chartData = useMemo(
    () =>
      data.byTime.map((bucket) => {
        const prompt = bucket.promptTokens || 0;
        const completion = bucket.completionTokens || 0;
        const total = bucket.totalTokens || 0;
        const cached = bucket.cachedTokens || 0;
        const reasoning = bucket.reasoningTokens || 0;
        const uncachedIn = Math.max(0, prompt - cached);
        const reasoningOutside =
          Math.abs(total - (prompt + completion + reasoning)) < Math.abs(total - (prompt + completion)) && reasoning > 0;
        const outputNonReason = reasoningOutside ? completion : Math.max(0, completion - reasoning);
        return {
          label: bucket.label,
          uncachedIn,
          cached,
          outputNonReason,
          reasoning,
          requests: bucket.requests,
        };
      }),
    [data.byTime]
  );
  return (
    <ChartContainer config={trendConfig} className="aspect-auto h-48 w-full p-3">
      <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={32} fontSize={10} />
        <YAxis yAxisId="tokens" tickLine={false} axisLine={false} tickMargin={4} width={40} fontSize={10} />
        <YAxis yAxisId="requests" orientation="right" tickLine={false} axisLine={false} tickMargin={4} width={32} fontSize={10} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Bar yAxisId="tokens" dataKey="uncachedIn" stackId="tokens" fill={trendPalette[0]} />
        <Bar yAxisId="tokens" dataKey="cached" stackId="tokens" fill={trendPalette[1]} />
        <Bar yAxisId="tokens" dataKey="outputNonReason" stackId="tokens" fill={trendPalette[2]} />
        <Bar yAxisId="tokens" dataKey="reasoning" stackId="tokens" fill={trendPalette[3]} />
        <Line yAxisId="requests" type="monotone" dataKey="requests" stroke="#ab570a" strokeWidth={1.5} dot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}
