"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";
import { getPoolLabel, PoolTypeBadge } from "./status-ui";
import { AccountPicker } from "./account-picker";
import { RangeDatePicker } from "./range-date-picker";
import type { AccountListResponse, ApiKeysResponse, Bucket, UsageStats } from "./types";

const palette = ["#0070f3", "#7928ca", "#0a7a3e", "#ab570a", "#ee0000", "#00a0a0", "#333", "#888"];

type RangeKey = "1h" | "6h" | "24h" | "7d" | "30d";
type Granularity = "auto" | "5m" | "1m" | "1h" | "1d";

type PoolTypeFilter = string;
const fallbackPoolTypeOptions: { value: PoolTypeFilter; label: string }[] = [
  { value: "all", label: "全部号池" },
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "openai", label: "OpenAI" },
  { value: "xai-grok", label: "xAI Grok" },
  { value: "kimi-code", label: "Kimi Code" },
];

const rangeHours: Record<RangeKey, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 };
const rangeLabels: Record<RangeKey, string> = { "1h": "1 小时", "6h": "6 小时", "24h": "24 小时", "7d": "7 天", "30d": "30 天" };
const rangeOrder: RangeKey[] = ["1h", "6h", "24h", "7d", "30d"];
const granLabels: Record<Granularity, string> = { auto: "自动", "5m": "5 分钟", "1m": "1 分钟", "1h": "1 小时", "1d": "1 天" };
const granOrder: Granularity[] = ["auto", "5m", "1m", "1h", "1d"];

function autoGranularity(range: RangeKey): Granularity {
  if (range === "1h") return "5m";
  if (range === "6h") return "5m";
  if (range === "24h") return "1h";
  if (range === "7d") return "1h";
  return "1d";
}

interface TokenSegments {
  uncachedIn: number;
  cached: number;
  outputNonReason: number;
  reasoning: number;
}

function tokenSegmentsFromBucket(bucket: Bucket): TokenSegments {
  const prompt = bucket.promptTokens || 0;
  const completion = bucket.completionTokens || 0;
  const total = bucket.totalTokens || 0;
  const cached = bucket.cachedTokens || 0;
  const reasoning = bucket.reasoningTokens || 0;
  const uncachedIn = Math.max(0, prompt - cached);
  const sumWithoutReasoning = prompt + completion;
  const sumWithReasoningOutside = sumWithoutReasoning + reasoning;
  const reasoningOutside =
    Math.abs(total - sumWithReasoningOutside) < Math.abs(total - sumWithoutReasoning) && reasoning > 0;
  const outputNonReason = reasoningOutside ? completion : Math.max(0, completion - reasoning);
  return { uncachedIn, cached, outputNonReason, reasoning };
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}


function formatUsd(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs < 0.0001) return `$${value.toExponential(2)}`;
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function UsagePage() {
  const [range, setRange] = useState<RangeKey>("24h");
  const [granularity, setGranularity] = useState<Granularity>("auto");
  const [poolType, setPoolType] = useState<PoolTypeFilter>("all");
  const [model, setModel] = useState<string>("all");
  const [accountId, setAccountId] = useState("");
  // 按密钥筛选：单选（对齐现有 Select 交互），"all" 表示全部密钥。
  const [apiKeyId, setApiKeyId] = useState("all");
  // 自定义时间范围（yyyy-mm-dd）；激活时预设按钮组不高亮、不传 hours。
  const [customRange, setCustomRange] = useState<{ start: string | null; end: string | null } | null>(null);
  const customRangeActive = customRange !== null;
  // 自定义范围时粒度固定为 auto（后端按 from/to 跨度自适应），预设时维持现有联动。
  const effectiveGranularity = customRangeActive
    ? "auto"
    : granularity === "auto"
      ? autoGranularity(range)
      : granularity;
  const queryParts: string[] = [];
  if (customRangeActive) {
    // 本地时区语义：开始取本地零点、结束取本地 23:59:59.999，与总览页实现一致。
    if (customRange?.start) {
      queryParts.push(`from=${encodeURIComponent(new Date(`${customRange.start}T00:00:00`).toISOString())}`);
    }
    if (customRange?.end) {
      queryParts.push(`to=${encodeURIComponent(new Date(`${customRange.end}T23:59:59.999`).toISOString())}`);
    }
    queryParts.push("granularity=auto");
  } else {
    queryParts.push(`hours=${rangeHours[range]}`, `granularity=${granularity}`);
  }
  if (poolType && poolType !== "all") queryParts.push(`poolType=${poolType}`);
  if (model && model !== "all") queryParts.push(`model=${encodeURIComponent(model)}`);
  if (accountId) queryParts.push(`accountId=${encodeURIComponent(accountId)}`);
  if (apiKeyId && apiKeyId !== "all") queryParts.push(`apiKeyId=${encodeURIComponent(apiKeyId)}`);
  const path = `/api/admin/usage?${queryParts.join("&")}`;
  // 账号筛选数据源：不带 pageSize 拉全量（items / accounts 同源，均为完整 AccountRecord）。
  const accountsResource = useAdminResource<AccountListResponse>("/api/admin/accounts");
  const accounts = accountsResource.data?.items ?? accountsResource.data?.accounts ?? [];
  // 密钥筛选数据源：/api/admin/keys 全量小表。
  const keysResource = useAdminResource<ApiKeysResponse>("/api/admin/keys");
  const apiKeyOptions = keysResource.data?.apiKeys ?? [];
  const resource = useAdminResource<UsageStats>(path);
  const data = resource.data;
  const apiPoolTypes = resource.data?.poolTypes;
  const poolTypeOptions = useMemo(() => {
    const base = apiPoolTypes?.length
      ? [{ value: "all", label: "全部号池" }, ...apiPoolTypes.map((pool) => ({ value: pool.type, label: pool.label }))]
      : fallbackPoolTypeOptions;
    return poolType !== "all" && !base.some((option) => option.value === poolType)
      ? [...base, { value: poolType, label: getPoolLabel(poolType) }]
      : base;
  }, [apiPoolTypes, poolType]);
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const bucket of resource.data?.byModel ?? []) {
      const key = bucket.key || bucket.label || "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: bucket.label || key });
    }
    if (model !== "all" && !options.some((option) => option.value === model)) {
      options.push({ value: model, label: model });
    }
    return options;
  }, [resource.data?.byModel, model]);

  function selectRange(next: RangeKey) {
    setRange(next);
    setCustomRange(null);
    const auto = autoGranularity(next);
    if (granularity !== "auto" && granularity !== auto) {
      setGranularity("auto");
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="USAGE DASHBOARD"
        title="用量看板"
        description="按时间、模型、账号和 API Key 维度查看请求量、Token 消耗与延迟趋势。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={granularity} onValueChange={(value) => setGranularity(value as Granularity)} disabled={customRangeActive}>
              <SelectTrigger size="sm" className="w-full sm:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {granOrder.map((gran) => (
                  <SelectItem key={gran} value={gran}>{granLabels[gran]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
              <RefreshCw data-icon="inline-start" />刷新
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="inline-flex w-full items-center rounded-lg border bg-card p-0.5 sm:w-auto">
          {rangeOrder.map((key) => (
            <Button
              key={key}
              type="button"
              variant={!customRangeActive && range === key ? "default" : "ghost"}
              size="sm"
              onClick={() => selectRange(key)}
              className={!customRangeActive && range === key ? undefined : "text-muted-foreground"}
              aria-current={!customRangeActive && range === key ? "true" : undefined}
            >
              {rangeLabels[key]}
            </Button>
          ))}
        </div>
        <div className="w-full sm:w-auto"><RangeDatePicker
          startDate={customRange?.start ?? null}
          endDate={customRange?.end ?? null}
          highlighted={customRangeActive}
          onChange={(next) => setCustomRange(next.start || next.end ? next : null)}
        /></div>
        <span className="text-xs text-muted-foreground">
          粒度：{granLabels[effectiveGranularity]}
        </span>
        <Select value={poolType} onValueChange={(value) => setPoolType(value)}>
          <SelectTrigger size="sm" className="w-full sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {poolTypeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={model} onValueChange={(value) => setModel(value)}>
          <SelectTrigger size="sm" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模型</SelectItem>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="w-full sm:w-auto"><AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} /></div>
        <Select value={apiKeyId} onValueChange={setApiKeyId}>
          <SelectTrigger size="sm" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部密钥</SelectItem>
            {apiKeyOptions.map((key) => (
              <SelectItem key={key.id} value={key.id}>{key.name || key.prefix || key.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {resource.error ? (
        <Panel><ErrorState message={resource.error} onRetry={() => void resource.refresh()} /></Panel>
      ) : null}

      {resource.loading && !data ? (
        <Panel><LoadingTable rows={4} columns={6} /></Panel>
      ) : null}

      {data ? (
        <div className="space-y-4">
          <KpiRow summary={data.summary} />

          {resource.error ? null : !data.byTime.length && !data.byModel.length && !data.byAccount.length && !data.byKey.length && !data.summary.totalTokens ? (
            <Panel>
              <EmptyState title="暂无用量数据" description="当前筛选条件下没有可用统计，尝试调整时间范围或筛选条件后刷新。" />
            </Panel>
          ) : (
            <>
              <Panel title="Token 趋势" description="按时间分桶展示 Token 分段与请求数。">
                {data.byTime.length ? (
                  <TokenOverTimeChart buckets={data.byTime} />
                ) : (
                  <EmptyState title="暂无时间序列数据" description="当前时间范围内没有请求记录。" />
                )}
              </Panel>

              <div className="grid gap-4 xl:grid-cols-2">
                <Panel title="Token 构成" description="输入 / 输出 / 缓存 / 推理 Token 占比。">
                  {data.summary.totalTokens ? (
                    <TokenMixChart summary={data.summary} />
                  ) : (
                    <EmptyState title="暂无 Token 数据" description="当前范围内未统计到 Token 消耗。" />
                  )}
                </Panel>

                <Panel title="模型分布" description="按 Token 消耗展示各模型占比。">
                  {data.byModel.length ? (
                    <ModelDistributionChart buckets={data.byModel} />
                  ) : (
                    <EmptyState title="暂无模型数据" description="没有按模型维度的统计数据。" />
                  )}
                </Panel>
              </div>

              <Panel title="模型费用排行" description="按 OpenRouter 参考价估算的模型费用（非实际账单）。">
                {data.byModel.some((b) => (b.costUsd ?? 0) > 0) ? (
                  <div className="divide-y">
                    {[...data.byModel]
                      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
                      .slice(0, 12)
                      .map((bucket) => (
                        <div key={bucket.key} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{bucket.label}</p>
                            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                              {formatNumber(bucket.totalTokens)} tokens · {formatNumber(bucket.requests)} 请求
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-sm font-medium">{formatUsd(bucket.costUsd)}</span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <EmptyState title="暂无费用数据" description="需要先在智能路由页刷新 OpenRouter 价格缓存，且请求带有 Token 统计。" />
                )}
              </Panel>

              <div className="grid gap-4 xl:grid-cols-2">
                <Panel title="按服务账号" description="各账号的 Token 分段对比。">
                  {data.byAccount.length ? (
                    <AccountChart buckets={data.byAccount} poolLabels={Object.fromEntries((apiPoolTypes ?? []).map((pool) => [pool.type, pool.label]))} />
                  ) : (
                    <EmptyState title="暂无账号数据" description="没有按账号维度的统计数据。" />
                  )}
                </Panel>

                <Panel title="按 API Key" description="各 API Key 的总 Token 消耗。">
                  {data.byKey.length ? (
                    <KeyChart buckets={data.byKey} />
                  ) : (
                    <EmptyState title="暂无 Key 数据" description="没有按 API Key 维度的统计数据。" />
                  )}
                </Panel>
              </div>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

function KpiRow({ summary }: { summary: UsageStats["summary"] }) {
  const successRate = summary.requests > 0 ? (summary.ok / summary.requests) * 100 : null;
  const cacheHitRate = summary.promptTokens > 0 ? Math.min(100, (summary.cachedTokens / summary.promptTokens) * 100) : null;
  const items: Array<{ label: string; value: string; note?: string }> = [
    { label: "请求数", value: formatNumber(summary.requests), note: `${formatNumber(summary.ok)} 成功 · ${formatNumber(summary.fail)} 失败` },
    { label: "成功率", value: successRate != null ? `${successRate.toFixed(1)}%` : "—", note: "成功 / 总请求" },
    { label: "平均延迟", value: formatMs(summary.avgLatencyMs), note: "端到端" },
    { label: "平均 TTFT", value: formatMs(summary.avgFirstTokenMs), note: "首 Token 时间" },
    { label: "平均 TPS", value: summary.tpsSampleCount > 0 && summary.avgTps != null ? summary.avgTps.toFixed(1) : "—", note: `样本 ${summary.tpsSampleCount}` },
    { label: "总 Token", value: formatNumber(summary.totalTokens), note: "输入 + 输出" },
    { label: "估算费用", value: formatUsd(summary.costUsd), note: "OpenRouter 参考价" },
    { label: "输入 Token", value: formatNumber(summary.promptTokens), note: "含缓存" },
    { label: "输出 Token", value: formatNumber(summary.completionTokens), note: "含推理" },
    { label: "缓存 Token", value: formatNumber(summary.cachedTokens), note: "命中缓存" },
    { label: "缓存命中率", value: cacheHitRate != null ? `${cacheHitRate.toFixed(1)}%` : "—", note: "缓存 / 输入" },
    { label: "推理 Token", value: formatNumber(summary.reasoningTokens), note: "思维链" },
  ];
  const cols = 6
  const cells: Array<{ label: string; value: string; note?: string; empty?: boolean }> = items.map((item) => ({ ...item }))
  while (cells.length % cols !== 0) {
    cells.push({ label: `__empty_${cells.length}`, value: "", empty: true })
  }

  return (
    <section className="dashboard-surface overflow-hidden rounded-lg border bg-white">
      <div className="-mb-px -mr-px grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {cells.map((item) => (
          <div key={item.label} className="min-h-28 border-b border-r p-4">
            {item.empty ? null : (
              <>
                <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
                <p className="tabular mt-3 text-2xl font-semibold tracking-[-0.04em]">{item.value}</p>
                {item.note ? <p className="mt-1 text-[11px] text-muted-foreground">{item.note}</p> : null}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const tokenChartConfig: ChartConfig = {
  uncachedIn: { label: "输入(未缓存)", color: palette[0] },
  cached: { label: "缓存", color: palette[5] },
  outputNonReason: { label: "输出", color: palette[2] },
  reasoning: { label: "推理", color: palette[1] },
  requests: { label: "请求数", color: palette[3] },
};

function TokenOverTimeChart({ buckets }: { buckets: Bucket[] }) {
  const chartData = useMemo(
    () =>
      buckets.map((bucket) => {
        const seg = tokenSegmentsFromBucket(bucket);
        return {
          key: bucket.key,
          label: bucket.label,
          uncachedIn: seg.uncachedIn,
          cached: seg.cached,
          outputNonReason: seg.outputNonReason,
          reasoning: seg.reasoning,
          requests: bucket.requests,
        };
      }),
    [buckets]
  );
  return (
    <ChartContainer config={tokenChartConfig} className="aspect-auto h-72 w-full p-4">
      <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} fontSize={11} />
        <YAxis yAxisId="tokens" tickLine={false} axisLine={false} tickMargin={8} width={48} fontSize={11} tickFormatter={formatNumber} />
        <YAxis yAxisId="requests" orientation="right" tickLine={false} axisLine={false} tickMargin={8} width={40} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <ChartLegend content={<ChartLegendContent verticalAlign="top" />} />
        <Bar yAxisId="tokens" dataKey="uncachedIn" stackId="tokens" fill={palette[0]} />
        <Bar yAxisId="tokens" dataKey="cached" stackId="tokens" fill={palette[5]} />
        <Bar yAxisId="tokens" dataKey="outputNonReason" stackId="tokens" fill={palette[2]} />
        <Bar yAxisId="tokens" dataKey="reasoning" stackId="tokens" fill={palette[1]} />
        <Line yAxisId="requests" type="monotone" dataKey="requests" stroke={palette[3]} strokeWidth={1.5} dot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}

function TokenMixChart({ summary }: { summary: UsageStats["summary"] }) {
  const data = useMemo(() => {
    const seg = tokenSegmentsFromBucket({
      ...summary,
      key: "summary",
      label: "汇总",
      requests: summary.requests,
      ok: summary.ok,
      fail: summary.fail,
      latencySum: summary.avgLatencyMs * summary.requests,
      firstTokenSum: (summary.avgFirstTokenMs ?? 0) * summary.requests,
      firstTokenCount: summary.requests,
      tpsSampleCount: summary.tpsSampleCount,
      genLatencySum: 0,
      genTokensForTps: 0,
    } as Bucket);
    return [
      { key: "uncachedIn", label: "输入(未缓存)", value: seg.uncachedIn },
      { key: "cached", label: "缓存", value: seg.cached },
      { key: "outputNonReason", label: "输出", value: seg.outputNonReason },
      { key: "reasoning", label: "推理", value: seg.reasoning },
    ].filter((item) => item.value > 0);
  }, [summary]);
  const config: ChartConfig = {
    uncachedIn: { label: "输入(未缓存)", color: palette[0] },
    cached: { label: "缓存", color: palette[5] },
    outputNonReason: { label: "输出", color: palette[2] },
    reasoning: { label: "推理", color: palette[1] },
  };
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full p-4">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Pie data={data} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80} paddingAngle={2}>
          {data.map((item) => {
            const color = config[item.key as keyof typeof config]?.color ?? palette[6];
            return <Cell key={item.key} fill={color} />;
          })}
        </Pie>
        <ChartLegend content={<ChartLegendContent />} />
      </PieChart>
    </ChartContainer>
  );
}

function ModelDistributionChart({ buckets }: { buckets: Bucket[] }) {
  const data = useMemo(
    () =>
      buckets
        .map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          value: bucket.totalTokens || bucket.requests,
          requests: bucket.requests,
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8),
    [buckets]
  );
  const config = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    data.forEach((item, index) => {
      cfg[item.key] = { label: item.label, color: palette[index % palette.length] };
    });
    return cfg;
  }, [data]);
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full p-4">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Pie data={data} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80} paddingAngle={2}>
          {data.map((item, index) => (
            <Cell key={item.key} fill={palette[index % palette.length]} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent />} />
      </PieChart>
    </ChartContainer>
  );
}

function AccountChart({ buckets, poolLabels = {} }: { buckets: Bucket[]; poolLabels?: Record<string, string> }) {
  const sorted = useMemo(
    () =>
      buckets
        .map((bucket) => ({ bucket, total: bucket.totalTokens || 0 }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10),
    [buckets],
  );
  const data = useMemo(
    () =>
      sorted.map(({ bucket }) => {
        const seg = tokenSegmentsFromBucket(bucket);
        return {
          key: bucket.key,
          label: bucket.label,
          uncachedIn: seg.uncachedIn,
          cached: seg.cached,
          outputNonReason: seg.outputNonReason,
          reasoning: seg.reasoning,
        };
      }),
    [sorted],
  );
  return (
    <div className="space-y-3">
      <ChartContainer config={tokenChartConfig} className="aspect-auto h-64 w-full p-4">
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#eee" />
          <XAxis type="number" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} tickFormatter={formatNumber} />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={100} fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
          <ChartLegend content={<ChartLegendContent verticalAlign="top" />} />
          <Bar dataKey="uncachedIn" stackId="tokens" fill={palette[0]} />
          <Bar dataKey="cached" stackId="tokens" fill={palette[5]} />
          <Bar dataKey="outputNonReason" stackId="tokens" fill={palette[2]} />
          <Bar dataKey="reasoning" stackId="tokens" fill={palette[1]} />
        </BarChart>
      </ChartContainer>
      <AccountPoolList buckets={buckets} poolLabels={poolLabels} />
    </div>
  );
}

function AccountPoolList({ buckets, poolLabels = {} }: { buckets: Bucket[]; poolLabels?: Record<string, string> }) {
  const rows = useMemo(
    () =>
      [...buckets]
        .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))
        .slice(0, 12),
    [buckets],
  );
  return (
    <div className="border-t">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
        {rows.map((bucket) => (
          <div key={bucket.key} className="contents">
            <span className="flex items-center gap-1.5 truncate font-mono text-muted-foreground" title={bucket.label}>
              {bucket.label}
              <PoolTypeBadge poolType={bucket.poolType} label={bucket.poolType ? poolLabels[bucket.poolType] : undefined} />
            </span>
            <span className="tabular text-right font-mono text-muted-foreground">{formatNumber(bucket.totalTokens || 0)}</span>
            <span className="tabular text-right font-mono text-muted-foreground">{formatNumber(bucket.requests)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KeyChart({ buckets }: { buckets: Bucket[] }) {
  const data = useMemo(
    () =>
      buckets
        .map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          totalTokens: bucket.totalTokens,
        }))
        .sort((a, b) => a.totalTokens - b.totalTokens)
        .slice(-10),
    [buckets]
  );
  const config: ChartConfig = {
    totalTokens: { label: "总 Token", color: palette[0] },
  };
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full p-4">
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#eee" />
        <XAxis type="number" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} tickFormatter={formatNumber} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={100} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <Bar dataKey="totalTokens" fill={palette[0]} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}