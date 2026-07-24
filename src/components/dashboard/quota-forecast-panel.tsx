"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { EmptyState, ErrorState, LoadingTable, Panel } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";
import type { QuotaForecastResult } from "./types";

const poolOptions = [
  { value: "all", label: "全部号池" },
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "openai", label: "OpenAI" },
  { value: "xai-grok", label: "xAI Grok" },
  { value: "kimi-code", label: "Kimi Code" },
] as const;

const chartConfig: ChartConfig = {
  availableAmount: { label: "可用余量", color: "#0070f3" },
  routingReadyAccounts: { label: "可路由账号", color: "#0a7a3e" },
};

function formatAmount(value: number | null | undefined, metric?: string | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (metric === "tokens") {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(Math.round(value));
  }
  return Number(value).toFixed(2);
}

function metricHint(metric?: string | null, primaryWindow?: string | null) {
  if (metric === "tokens") return "号池可用 token 总量";
  if (primaryWindow === "fiveHour") return "5h 等效可用号量（每号 0~1 求和）";
  return "主窗口等效可用号量（每号 0~1 求和）";
}

export function QuotaForecastPanel({
  poolType: controlledPoolType,
  defaultPoolType = "all",
  compact = false,
  showPoolFilter = true,
}: {
  poolType?: string;
  defaultPoolType?: string;
  compact?: boolean;
  showPoolFilter?: boolean;
}) {
  const [internalPoolType, setInternalPoolType] = useState(defaultPoolType);
  const poolType = controlledPoolType ?? internalPoolType;
  const path = useMemo(() => {
    const params = new URLSearchParams({ hours: "24" });
    if (poolType && poolType !== "all") params.set("poolType", poolType);
    return `/api/admin/usage/forecast?${params.toString()}`;
  }, [poolType]);
  const resource = useAdminResource<QuotaForecastResult>(path);
  const data = resource.data;
  const points = data?.points ?? [];
  const poolLabel = poolOptions.find((item) => item.value === (poolType || "all"))?.label || "全部号池";
  const metric = data?.metric;
  const yTick = (value: number) => formatAmount(value, metric);

  return (
    <Panel
      title="未来 24 小时预计可用余量"
      description={`${poolLabel} · ${metricHint(metric, data?.primaryWindow)}；绿色阶梯线是预计可路由账号数。只推演恢复，不预测未来新增消耗。`}
      action={
        <div className="flex items-center gap-2">
          {showPoolFilter ? (
            <Select value={poolType || "all"} onValueChange={setInternalPoolType}>
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {poolOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="rounded-md border bg-white px-2 py-1 font-mono text-[11px] text-muted-foreground">{poolLabel}</span>
          )}
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
            刷新
          </Button>
        </div>
      }
    >
      {resource.loading && !data ? <LoadingTable rows={compact ? 3 : 4} columns={6} /> : null}
      {resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : null}
      {!resource.loading && !resource.error && data ? (
        points.length ? (
          <div className={compact ? "px-2 pb-3 pt-2" : "px-3 pb-4 pt-3"}>
            <ChartContainer config={chartConfig} className={compact ? "h-56 w-full" : "h-72 w-full"}>
              <ComposedChart data={points} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  yAxisId="amount"
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tick={{ fontSize: 10 }}
                  tickFormatter={yTick}
                />
                <YAxis
                  yAxisId="accounts"
                  orientation="right"
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                  tick={{ fontSize: 10 }}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value, name) => {
                        const key = String(name);
                        if (key === "availableAmount") {
                          return [
                            metric === "tokens"
                              ? `${formatAmount(Number(value), "tokens")} token`
                              : `${formatAmount(Number(value), "capacity")} 等效号`,
                            data.metricLabel || "可用余量",
                          ];
                        }
                        if (key === "routingReadyAccounts") return [String(value), "可路由账号"];
                        return [String(value), key];
                      }}
                    />
                  }
                />
                <Line
                  yAxisId="amount"
                  type="monotone"
                  dataKey="availableAmount"
                  stroke="var(--color-availableAmount)"
                  strokeWidth={2}
                  dot={false}
                  name="availableAmount"
                />
                <Line
                  yAxisId="accounts"
                  type="stepAfter"
                  dataKey="routingReadyAccounts"
                  stroke="var(--color-routingReadyAccounts)"
                  strokeWidth={1.75}
                  dot={false}
                  name="routingReadyAccounts"
                />
              </ComposedChart>
            </ChartContainer>
            <p className="mt-2 px-1 text-[11px] leading-5 text-muted-foreground">
              {metric === "tokens"
                ? "蓝线：可用 token 总量。绿线：预计可路由账号数。"
                : "蓝线：主窗口等效可用号量（5 个半满的号 = 2.50）。绿线：预计可路由账号数。"}
              {" "}缺少额度数据的账号按 0 计，避免被平均值抬高。
            </p>
          </div>
        ) : (
          <EmptyState title="暂无预测数据" description="录入可用账号后，这里会显示未来 24 小时的额度恢复曲线。" />
        )
      ) : null}
    </Panel>
  );
}
