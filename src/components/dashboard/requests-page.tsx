"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, PaginationBar, StatsStrip, formatDate } from "./page-kit";
import { StatusBadge, PoolTypeBadge, getPoolLabel } from "./status-ui";
import { RangeDatePicker } from "./range-date-picker";
import { FilterMultiSelect } from "./filter-multi-select";
import { cn } from "@/lib/utils";
import type { AttemptDetail, RequestDetail, RequestFacets, RequestListResponse, RequestRecord } from "./types";
import { useAdmin } from "./admin-context";
import { useAdminResource } from "./use-admin-resource";

const pageSize = 20;

interface AccountsResponse { items?: { id: string; poolType?: string; poolLabel?: string }[]; accounts?: { id: string; poolType?: string; poolLabel?: string }[] }



function normalizeEndpointLabel(value?: string | null): string {
  if (!value) return "—"
  const v = value.replace(/^\/?v1\//, "").replace(/^raw\/v1\//, "raw/")
  const isRaw = value.startsWith("raw/") || value.includes("raw/v1/")
  if (v.includes("chat/completions")) return isRaw ? "raw/chat" : "chat"
  if (v.includes("responses")) return isRaw ? "raw/responses" : "responses"
  if (v.includes("messages")) return "messages"
  return v
}

function formatRouteLabel(request: RequestRecord): string {
  const inbound = normalizeEndpointLabel(request.inboundEndpoint || (request.endpoint ? `v1/${request.endpoint}` : null))
  const upstream = normalizeEndpointLabel(request.upstreamEndpoint || request.endpoint)
  if (request.converted || (inbound === "responses" && upstream === "chat")) return `${inbound} → ${upstream}`
  if (inbound !== upstream && upstream !== "—") return `${inbound} → ${upstream}`
  return inbound
}

function hasInjectedServerTools(request: RequestRecord): boolean {
  return String(request.transformSummary || "").includes("inject:web_search+x_search")
}

function routeBadgeClass(label: string): string {
  if (label.includes("→")) return "border-amber-200 bg-amber-50 text-amber-800"
  if (label.includes("raw")) return "border-slate-200 bg-slate-50 text-slate-700"
  if (label === "chat") return "border-sky-200 bg-sky-50 text-sky-800"
  if (label === "responses") return "border-emerald-200 bg-emerald-50 text-emerald-800"
  return "border-border bg-white text-muted-foreground"
}

function formatCostCalculation(request: RequestRecord): string | null {
  const breakdown = request.costBreakdown
  if (!breakdown) return null
  const formatTokens = (value: number) => new Intl.NumberFormat("zh-CN").format(value)
  const formatRate = (value: number) => `$${(value * 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 6 })}/百万 Token`
  const terms = [
    `非缓存输入 ${formatTokens(breakdown.uncachedPromptTokens)} × ${formatRate(breakdown.promptRate)}`,
  ]
  if (breakdown.cachedTokens > 0) {
    terms.push(`缓存输入 ${formatTokens(breakdown.cachedTokens)} × ${formatRate(breakdown.cacheRate)}`)
  }
  terms.push(`输出 ${formatTokens(breakdown.completionTokens)} × ${formatRate(breakdown.completionRate)}`)
  return terms.join(" + ")
}

/** 只翻译 routeReason 技术码，不替代转换过程展示。 */
function explainRouteReason(reason?: string | null): string {
  const r = String(reason || "").trim()
  if (!r) return "—"
  if (r === "prefer_responses_server_tools") return "为了 server tools，强制留 responses"
  if (r === "responses_native") return "正常走 responses，无特殊强制"
  if (r === "responses_compact") return "compact 请求，固定走 responses"
  if (r === "session_lineage_responses") return "会话历史偏 responses，继续 responses"
  if (r === "session_lineage_chat") return "会话历史偏 chat，转 chat"
  if (r.startsWith("foreign_previous_response_id")) return "陌生 previous id，可能转 chat"
  if (r.startsWith("foreign_opaque") || r.startsWith("foreign_history")) return "陌生历史状态，可能转 chat"
  if (r === "raw_passthrough") return "原生透传"
  if (r === "direct") return "直接转发"
  if (r === "chat_fallback") return "responses 回退到 chat"
  return r
}


/** 多维组合筛选状态（不含关键词/状态这两个常驻控件）。 */
interface RequestFilters {
  accountIds: string[];
  apiKeyIds: string[];
  providers: string[];
  models: string[];
  inboundEndpoints: string[];
  upstreamEndpoints: string[];
  clients: string[];
  /** 本地日期 yyyy-mm-dd；null 表示未选。 */
  from: string | null;
  to: string | null;
}

type RequestFilterKey = Exclude<keyof RequestFilters, "from" | "to">;
const listFilterKeys: RequestFilterKey[] = [
  "accountIds",
  "apiKeyIds",
  "providers",
  "models",
  "inboundEndpoints",
  "upstreamEndpoints",
  "clients",
];
const defaultRequestFilters: RequestFilters = {
  accountIds: [],
  apiKeyIds: [],
  providers: [],
  models: [],
  inboundEndpoints: [],
  upstreamEndpoints: [],
  clients: [],
  from: null,
  to: null,
};

function isoToLocalDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 从 URL query 恢复筛选（分享/刷新保留）；非法值静默忽略。 */
function readFiltersFromUrl(): RequestFilters {
  if (typeof window === "undefined") return defaultRequestFilters;
  const sp = new URLSearchParams(window.location.search);
  const filters: RequestFilters = { ...defaultRequestFilters };
  for (const key of listFilterKeys) {
    filters[key] = (sp.get(key) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  filters.from = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? isoToLocalDate(fromRaw) : null;
  filters.to = toRaw && !Number.isNaN(Date.parse(toRaw)) ? isoToLocalDate(toRaw) : null;
  return filters;
}

/** 筛选状态 → URL query（本地零点/末秒语义对齐用量看板）；不含 page/pageSize。 */
function filtersToSearchParams(filters: RequestFilters): URLSearchParams {
  const sp = new URLSearchParams();
  for (const key of listFilterKeys) {
    if (filters[key].length) sp.set(key, filters[key].join(","));
  }
  // 与 usage 页一致：开始取本地零点、结束取本地 23:59:59.999。
  if (filters.from) sp.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) sp.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
  return sp;
}

export function RequestsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"all" | "success" | "fail">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // 多维筛选：挂载后从 URL 恢复一次（避免 SSR 水合不一致），此后每次变更回写 URL（replaceState 不产生历史项）。
  const [filters, setFilters] = useState<RequestFilters>(defaultRequestFilters);
  const [hydrated, setHydrated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    // 挂载后一次性从 URL 恢复筛选（SSR 预渲染输出默认值，避免水合不一致）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilters(readFiltersFromUrl());
    setHydrated(true);
  }, []);

  function updateFilters(patch: Partial<RequestFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }

  const params = useMemo(() => {
    const parts = [`page=${page}`, `pageSize=${pageSize}`];
    if (status !== "all") parts.push(`ok=${status === "success" ? "true" : "false"}`);
    if (debouncedSearch.trim()) parts.push(`q=${encodeURIComponent(debouncedSearch.trim())}`);
    const sp = filtersToSearchParams(filters);
    sp.forEach((value, key) => parts.push(`${key}=${encodeURIComponent(value)}`));
    return parts.join("&");
  }, [page, status, debouncedSearch, filters]);

  useEffect(() => {
    if (!hydrated) return;
    const sp = filtersToSearchParams(filters);
    if (status !== "all") sp.set("ok", status === "success" ? "true" : "false");
    if (debouncedSearch.trim()) sp.set("q", debouncedSearch.trim());
    const qs = sp.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [hydrated, status, debouncedSearch, filters]);

  const path = `/api/admin/requests?${params}`;
  const resource = useAdminResource<RequestListResponse>(path);
  const accountsResource = useAdminResource<AccountsResponse>("/api/admin/accounts?pageSize=500");
  const poolTypeByAccountId = useMemo(() => {
    const map = new Map<string, { poolType?: string; poolLabel?: string }>();
    for (const account of [...(accountsResource.data?.items ?? []), ...(accountsResource.data?.accounts ?? [])]) {
      if (account.poolType) map.set(account.id, { poolType: account.poolType, poolLabel: account.poolLabel });
    }
    return map;
  }, [accountsResource.data]);
  // 各维度候选项：来自轻量 facets 接口（近 N 行采样 + TTL 缓存）。
  const facetsResource = useAdminResource<RequestFacets>("/api/admin/requests/facets");
  const facets = facetsResource.data;
  const accountOptions = useMemo(
    () => (facets?.accounts ?? []).map((account) => ({ value: account.id, label: account.name || account.id })),
    [facets],
  );
  const apiKeyOptions = useMemo(
    () => (facets?.apiKeys ?? []).map((key) => ({ value: key.id, label: key.name || key.prefix || key.id })),
    [facets],
  );
  const providerOptions = useMemo(
    () => (facets?.providers ?? []).map((provider) => ({ value: provider, label: getPoolLabel(provider) })),
    [facets],
  );
  const modelOptions = useMemo(() => (facets?.models ?? []).map((model) => ({ value: model, label: model })), [facets]);
  const inboundOptions = useMemo(() => (facets?.inboundEndpoints ?? []).map((value) => ({ value, label: value })), [facets]);
  const upstreamOptions = useMemo(() => (facets?.upstreamEndpoints ?? []).map((value) => ({ value, label: value })), [facets]);
  const clientOptions = useMemo(() => (facets?.clients ?? []).map((value) => ({ value, label: value })), [facets]);
  const accountNameById = useMemo(
    () => new Map(accountOptions.map((option) => [option.value, option.label])),
    [accountOptions],
  );
  const apiKeyLabelById = useMemo(
    () => new Map(apiKeyOptions.map((option) => [option.value, option.label])),
    [apiKeyOptions],
  );
  const [selected, setSelected] = useState<RequestRecord | null>(null);

  const items = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;

  // 已选条件 chip：每个维度可单独清除。
  const chips = useMemo(() => {
    const list: Array<{ key: string; group: string; label: string; onRemove: () => void }> = [];
    if (status !== "all") {
      list.push({ key: "status", group: "状态", label: status === "success" ? "成功" : "失败", onRemove: () => { setStatus("all"); setPage(1); } });
    }
    const keyword = debouncedSearch.trim();
    if (keyword) list.push({ key: "q", group: "关键词", label: keyword, onRemove: () => setSearch("") });
    if (filters.from || filters.to) {
      list.push({ key: "range", group: "时间", label: `${filters.from ?? "…"} ~ ${filters.to ?? "…"}`, onRemove: () => updateFilters({ from: null, to: null }) });
    }
    const chipGroup = (key: RequestFilterKey, group: string, resolve: (value: string) => string) => {
      filters[key].forEach((value) => {
        list.push({
          key: `${key}:${value}`,
          group,
          label: resolve(value),
          onRemove: () => updateFilters({ [key]: filters[key].filter((item) => item !== value) }),
        });
      });
    };
    chipGroup("accountIds", "账号", (id) => accountNameById.get(id) ?? id);
    chipGroup("apiKeyIds", "密钥", (id) => apiKeyLabelById.get(id) ?? id);
    chipGroup("providers", "Provider", getPoolLabel);
    chipGroup("models", "模型", (model) => model);
    chipGroup("inboundEndpoints", "入站路径", (value) => value);
    chipGroup("upstreamEndpoints", "上游路径", (value) => value);
    chipGroup("clients", "客户端", (value) => value);
    return list;
  }, [status, debouncedSearch, filters, accountNameById, apiKeyLabelById]);

  function clearAllFilters() {
    setSearch("");
    setStatus("all");
    setFilters(defaultRequestFilters);
    setPage(1);
  }

  return (
    <>
      <PageIntro
        eyebrow="REQUEST TRACE"
        title="请求与内部切号"
        description="查看每条请求的详情、Token 分解和 failover 时间线。支持关键词、时间范围、账号、密钥、Provider、模型、路径与客户端多维组合过滤。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
            <RefreshCw data-icon="inline-start" />刷新
          </Button>
        }
      />

      <div className="mb-4">
        <StatsStrip
          items={[
            { label: "匹配请求", value: total, hint: resource.data?.totalApproximate ? "近似值（封顶计数）" : "当前筛选结果" },
            { label: "当前页", value: items.length, hint: `第 ${page} 页` },
            { label: "成功", value: items.filter((item) => item.ok).length, hint: "本页成功数", tone: "success" },
            { label: "失败", value: items.filter((item) => item.ok === false).length, hint: "本页失败数", tone: "danger" },
          ]}
        />
      </div>

      <Panel>
        <div className="border-b bg-[#fafafa] p-3">
          {/* 常驻行：关键词 + 状态 + 移动端筛选折叠开关 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                placeholder="搜索 request id / model / error / endpoint…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select value={status} onValueChange={(value) => { setStatus(value as typeof status); setPage(1); }}>
              <SelectTrigger size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="success">成功</SelectItem>
                <SelectItem value="fail">失败</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={filtersOpen ? "default" : "outline"}
              size="sm"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              className="sm:hidden"
            >
              <SlidersHorizontal data-icon="inline-start" />筛选
            </Button>
          </div>
          {/* 多维组合筛选：移动端默认折叠（filtersOpen 展开），桌面端常驻 */}
          <div className={cn("mt-2 flex-wrap items-center gap-2", filtersOpen ? "flex" : "hidden sm:flex")}>
            <RangeDatePicker
              startDate={filters.from}
              endDate={filters.to}
              highlighted={Boolean(filters.from || filters.to)}
              onChange={(next) => updateFilters(next.start || next.end ? { from: next.start, to: next.end } : { from: null, to: null })}
            />
            <FilterMultiSelect label="账号" options={accountOptions} selected={filters.accountIds} onChange={(next) => updateFilters({ accountIds: next })} />
            <FilterMultiSelect label="密钥" options={apiKeyOptions} selected={filters.apiKeyIds} onChange={(next) => updateFilters({ apiKeyIds: next })} />
            <FilterMultiSelect label="Provider" options={providerOptions} selected={filters.providers} onChange={(next) => updateFilters({ providers: next })} />
            <FilterMultiSelect label="模型" options={modelOptions} selected={filters.models} onChange={(next) => updateFilters({ models: next })} />
            <FilterMultiSelect label="入站路径" options={inboundOptions} selected={filters.inboundEndpoints} onChange={(next) => updateFilters({ inboundEndpoints: next })} />
            <FilterMultiSelect label="上游路径" options={upstreamOptions} selected={filters.upstreamEndpoints} onChange={(next) => updateFilters({ upstreamEndpoints: next })} />
            <FilterMultiSelect label="客户端" options={clientOptions} selected={filters.clients} onChange={(next) => updateFilters({ clients: next })} />
          </div>
          {/* 已选条件 chips：可单独清除，一键清空 */}
          {chips.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2">
              <span className="text-xs text-muted-foreground">已选条件：</span>
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border bg-white px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  <span className="text-muted-foreground">{chip.group}:</span>
                  <span className="max-w-48 truncate">{chip.label}</span>
                  <button
                    type="button"
                    aria-label={`移除${chip.group}筛选 ${chip.label}`}
                    onClick={chip.onRemove}
                    className="-mr-0.5 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              <Button type="button" variant="ghost" size="xs" className="ml-1 text-muted-foreground" onClick={clearAllFilters}>
                清除全部
              </Button>
            </div>
          ) : null}
        </div>

        {resource.error ? (
          <ErrorState message={resource.error} onRetry={() => void resource.refresh()} />
        ) : resource.loading && !resource.data ? (
          <LoadingTable rows={8} columns={8} />
        ) : !items.length ? (
          <EmptyState title="暂无请求记录" description="没有匹配当前过滤条件的请求，尝试调整搜索或过滤。" />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[1360px]">
            <TableHeader className="bg-[#fafafa]">
              <TableRow>
                <TableHead className="px-4 text-xs text-muted-foreground">时间</TableHead>
                <TableHead className="text-xs text-muted-foreground">模型</TableHead>
                <TableHead className="text-xs text-muted-foreground">路径</TableHead>
                <TableHead className="text-xs text-muted-foreground">密钥</TableHead>
                <TableHead className="text-xs text-muted-foreground">结果</TableHead>
                <TableHead className="text-xs text-muted-foreground">服务账号</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">尝试</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">延迟</TableHead>
               <TableHead className="text-right text-xs text-muted-foreground">本地准备</TableHead>
               <TableHead className="text-right text-xs text-muted-foreground">TTFT</TableHead>
               <TableHead className="text-right text-xs text-muted-foreground">TPS</TableHead>
               <TableHead className="text-right text-xs text-muted-foreground">Tokens</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">费用</TableHead>
                <TableHead className="text-xs text-muted-foreground">客户端</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((request) => (
                <TableRow key={request.id}>
                  <TableCell className="px-4 font-mono text-xs text-muted-foreground">{formatDate(request.createdAt)}</TableCell>
                  <TableCell className="font-medium text-sm">{request.model || "未知"}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-medium ${routeBadgeClass(formatRouteLabel(request))}`}>
                      {formatRouteLabel(request)}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{request.apiKeyName || request.apiKeyPrefix || "未记录"}</TableCell>
                  <TableCell>
                    <StatusBadge status={request.ok ? "success" : request.status != null ? "failed" : "unknown"} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {request.accountName || "未分配"}
                      {request.accountId ? <PoolTypeBadge poolType={poolTypeByAccountId.get(request.accountId)?.poolType} label={poolTypeByAccountId.get(request.accountId)?.poolLabel} /> : null}
                    </span>
                  </TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">{request.attemptCount ?? 0}</TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">{request.latencyMs != null ? `${request.latencyMs} ms` : "—"}</TableCell>
                 <TableCell className="tabular text-right font-mono text-xs">{request.localPrepMs != null && request.localPrepMs > 0 ? `${request.localPrepMs} ms` : "—"}</TableCell>
                 <TableCell className="tabular text-right font-mono text-xs">{request.firstTokenMs != null ? `${request.firstTokenMs} ms` : "—"}</TableCell>
                 <TableCell className="tabular text-right font-mono text-xs">{request.tps != null ? request.tps : "—"}</TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">
                    {request.totalTokens != null ? (
                      <span title={`输入 ${request.promptTokens ?? 0} / 输出 ${request.completionTokens ?? 0}`}>
                        {request.totalTokens}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">{request.costLabel || "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{request.client || "—"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" onClick={() => setSelected(request)} aria-label="查看请求详情">
                      <ChevronRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
            </div>
        )}

        {total > 0 ? (
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={total}
            loading={resource.loading}
            onPageChange={setPage}
          />
        ) : null}
      </Panel>

      <RequestDetailSheet
        key={selected?.id ?? "closed"}
        request={selected}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        poolType={selected?.accountId ? poolTypeByAccountId.get(selected.accountId)?.poolType : undefined}
        poolLabel={selected?.accountId ? poolTypeByAccountId.get(selected.accountId)?.poolLabel : undefined}
      />
    </>
  );
}

function RequestDetailSheet({ request, onOpenChange, poolType, poolLabel }: { request: RequestRecord | null; onOpenChange: (open: boolean) => void; poolType?: string; poolLabel?: string }) {
  const { sessionFetch } = useAdmin();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await sessionFetch(`/api/admin/requests/${id}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "加载详情失败");
      setDetail(payload as RequestDetail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载详情失败");
    } finally {
      setLoading(false);
    }
  }, [sessionFetch]);

  useEffect(() => {
    if (!request?.id) return;
    const timer = window.setTimeout(() => void fetchDetail(request.id), 0);
    return () => window.clearTimeout(timer);
  }, [request?.id, fetchDetail]);

  const costCalculation = detail ? formatCostCalculation(detail.request) : null;

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {request ? (
          <>
            <DialogHeader className="border-b px-5 py-4">
              <DialogTitle>请求详情</DialogTitle>
              <DialogDescription className="font-mono text-[11px]">{request.id}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[calc(85dvh-64px)] overflow-y-auto p-5">
              {loading ? (
                <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在加载详情
                </div>
              ) : error ? (
                <ErrorState message={error} />
              ) : detail ? (
                <div className="space-y-6">
                  <BasicInfo request={detail.request} poolType={poolType} poolLabel={poolLabel} />
                  <TokenBreakdown request={detail.request} />
                  <div className="rounded-md border bg-[#fafafa] p-3">
                    <h3 className="mb-2 text-sm font-medium">估算费用</h3>
                    <p className="flex flex-wrap items-baseline gap-x-2 font-mono">
                      <span className="text-lg font-semibold tracking-[-0.03em]">{detail.request.costLabel || "—"}</span>
                      {costCalculation ? (
                        <span className="text-xs font-normal text-muted-foreground">{costCalculation}</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {detail.request.pricingModelId
                        ? `按 OpenRouter 价格匹配：${detail.request.pricingModelId}`
                        : "未匹配到 OpenRouter 价格（服务启动缓存，或到智能路由页底部刷新价格）"}
                    </p>
                  </div>
                  <FailoverTimeline attempts={detail.attempts} />
                  <HeadersBlock headers={detail.request.headers} />
                  <JsonBlock title="请求体" value={detail.request.request} truncated={detail.request.requestTruncated} />
                  <JsonBlock title="响应体" value={detail.request.response} truncated={detail.request.responseTruncated} />
                  {detail.request.error ? (
                    <div>
                      <h3 className="mb-2 text-sm font-medium">错误信息</h3>
                      <pre className="overflow-auto rounded-md border border-destructive/20 bg-destructive/5 p-3 font-mono text-xs leading-5 text-destructive">
                        {String(detail.request.error)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BasicInfo({ request, poolType, poolLabel }: { request: RequestDetail["request"]; poolType?: string; poolLabel?: string }) {
  const rows: Array<{ label: string; value: string; full?: boolean }> = [
    { label: "密钥", value: request.apiKeyName || request.apiKeyPrefix || "—" },
    { label: "__account__", value: request.accountName || "—", full: true },
    { label: "模型", value: request.model || "—" },
    { label: "费用", value: request.costLabel || "—" },
    { label: "路径", value: formatRouteLabel(request) },
    { label: "是否转换", value: request.converted ? "已转换" : "未转换" },
    { label: "注入工具", value: hasInjectedServerTools(request) ? "已注入 web_search + x_search" : "未注入内置工具" },
    { label: "原因", value: explainRouteReason(request.routeReason), full: true },
    { label: "Stream", value: request.stream ? "是" : "否" },
    { label: "HTTP 状态", value: request.status != null ? String(request.status) : "—" },
    { label: "结果", value: request.outcome || (request.ok ? "success" : "fail") },
    { label: "客户端", value: request.client || "—" },
    { label: "User-Agent", value: request.userAgent || "—", full: true },
    { label: "创建时间", value: formatDate(request.createdAt) },
    { label: "总延迟", value: request.latencyMs != null ? `${request.latencyMs} ms` : "—" },
    { label: "本地准备", value: request.localPrepMs != null && request.localPrepMs > 0 ? `${request.localPrepMs} ms` : "—" },
    { label: "首 Token", value: request.firstTokenMs != null ? `${request.firstTokenMs} ms` : "—" },
    { label: "TPS", value: request.tps != null ? String(request.tps) : "—" },
    { label: "请求大小", value: request.requestSizeBytes != null ? formatBytes(request.requestSizeBytes) : "—" },
    { label: "响应大小", value: request.responseSizeBytes != null ? formatBytes(request.responseSizeBytes) : "—" },
  ];
  return (
    <div className="rounded-md border bg-[#fafafa] p-3">
      <h3 className="mb-3 text-sm font-medium">基本信息</h3>
      <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
        {rows.map(({ label, value, full }) => (
          <div
            key={label}
            className={`grid grid-cols-[88px_minmax(0,1fr)] items-start gap-2 text-xs ${full ? "sm:col-span-2" : ""}`}
          >
            <span className="pt-0.5 text-muted-foreground">{label === "__account__" ? "服务账号" : label}</span>
            <span className="inline-flex min-w-0 flex-wrap items-start gap-1.5 break-all font-mono leading-5">
              <span className="min-w-0 whitespace-pre-wrap break-all">{value}</span>
              {label === "__account__" ? <PoolTypeBadge poolType={poolType} label={poolLabel} /> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TokenBreakdown({ request }: { request: RequestDetail["request"] }) {
  const tokens: Array<[string, number | null | undefined]> = [
    ["输入 Prompt", request.promptTokens],
    ["输出 Completion", request.completionTokens],
    ["总计 Total", request.totalTokens],
    ["缓存 Cached", request.cachedTokens],
    ["推理 Reasoning", request.reasoningTokens],
    ["文本 Text", request.textTokens],
    ["图像 Image", request.imageTokens],
    ["音频 Audio", request.audioTokens],
  ];
  const hasAny = tokens.some(([, value]) => value != null && value > 0);
  if (!hasAny) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Token 分解</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tokens.map(([label, value]) => (
          <div key={label} className="rounded-md border bg-[#fafafa] p-2.5">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className="tabular mt-1 font-mono text-sm font-medium">{value ?? "—"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FailoverTimeline({ attempts }: { attempts: AttemptDetail[] }) {
  if (!attempts?.length) return null;
  const sorted = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">Failover 时间线</h3>
      <ol className="space-y-0">
        {sorted.map((attempt, index) => (
          <AttemptItem key={attempt.id || index} attempt={attempt} index={index} last={index === sorted.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function AttemptItem({ attempt, index, last }: { attempt: AttemptDetail; index: number; last: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasBody = attempt.responseBody && attempt.responseBody.trim().length > 0;
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-5">
      <div className="relative flex justify-center">
        <span className="z-10 grid size-6 place-items-center rounded-full border bg-white font-mono text-[10px]">{index + 1}</span>
        {!last ? <span className="absolute top-6 bottom-0 w-px bg-border" /> : null}
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate font-mono text-xs font-medium">{attempt.accountName || attempt.accountId || "未知账号"}</p>
          <StatusBadge status={attempt.status != null ? (attempt.status < 400 ? "success" : "failed") : "unknown"} />
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          决策：{attempt.decision || "—"}
          {attempt.errorType ? ` · 错误类型：${attempt.errorType}` : ""}
        </p>
        {attempt.errorMessage ? (
          <p className="mt-1 text-xs leading-5 text-destructive">{attempt.errorMessage}</p>
        ) : null}
        {hasBody ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? "▼ 收起响应报文" : "▶ 展开响应报文"}
            </button>
            <pre
              className={
                "mt-1 overflow-auto rounded bg-[#1e1e1e] p-2 font-mono text-[10px] leading-5 text-[#d4d4d4] " +
                (expanded ? "max-h-80" : "line-clamp-2")
              }
            >
              {attempt.responseBody}
            </pre>
          </div>
        ) : null}
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          {attempt.latencyMs != null ? `${attempt.latencyMs} ms` : "—"} · {formatDate(attempt.startedAt)}
        </p>
      </div>
    </li>
  );
}

function HeadersBlock({ headers }: { headers?: Record<string, string> }) {
  if (!headers || !Object.keys(headers).length) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">请求头</h3>
      <pre className="max-h-60 overflow-auto rounded-md bg-[#1e1e1e] p-3 font-mono text-xs leading-5 text-[#d4d4d4]">
        {JSON.stringify(headers, null, 2)}
      </pre>
    </div>
  );
}

function JsonBlock({ title, value, truncated }: { title: string; value: unknown; truncated?: boolean }) {
  if (value == null) return null;
  const text = typeof value === "string" ? safePretty(value) : JSON.stringify(value, null, 2);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {truncated ? (
          <span className="rounded border border-warning/20 bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning">已截断</span>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md bg-[#1e1e1e] p-3 font-mono text-xs leading-5 text-[#d4d4d4]">
        {text}
      </pre>
    </div>
  );
}

function safePretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}