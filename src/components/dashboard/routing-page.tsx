"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, CheckCircle2, ChevronsUpDown, GripVertical, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAdmin } from "./admin-context";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, PaginationBar, formatDate } from "./page-kit";
import { AccountBadges, BillingSafetyBadge, getPoolLabel, PoolTypeBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { Account, ModelRouteRule, RoutingConfig } from "./types";
import { useConfirm } from "@/components/ui/confirm-provider";

interface RoutingPayload extends RoutingConfig { routing?: RoutingConfig }
interface AccountsPayload {
  items?: Account[];
  accounts?: Account[];
  poolPreferences?: Record<string, string | null>;
  poolTypes?: (string | { type: string; label: string })[];
}
interface ModelRoutingPayload { rules?: ModelRouteRule[] }

interface ProviderModelCatalog {
  poolType: string;
  label: string;
  models: string[];
  source: string;
  accountId: string | null;
  error: string | null;
  fetchedAt: string | null;
  updatedAt: string | null;
  defaultModels: string[];
  remoteModels: string[] | null;
}
interface ProviderModelsPayload { catalogs?: ProviderModelCatalog[] }

const POOL_OPTIONS = ["opencode-go", "openai", "xai-grok", "kimi-code", "glm-coding"] as const;

interface PoolTypeOptionItem { type: string; label: string }

export function RoutingPage() {
  const routingResource = useAdminResource<RoutingPayload>("/api/admin/routing");
  const accountsResource = useAdminResource<AccountsPayload>("/api/admin/accounts?pageSize=500&sort=name");
  const modelRoutingResource = useAdminResource<ModelRoutingPayload>("/api/admin/model-routing");
  const providerModelsResource = useAdminResource<ProviderModelsPayload>("/api/admin/provider-models");
  const { adminFetch } = useAdmin();
  const routing = routingResource.data?.routing ?? routingResource.data;
  const accounts = useMemo(() => accountsResource.data?.items ?? accountsResource.data?.accounts ?? [], [accountsResource.data]);
  const rules = useMemo(() => modelRoutingResource.data?.rules ?? [], [modelRoutingResource.data?.rules]);
  const catalogs = providerModelsResource.data?.catalogs ?? [];
  const poolTypeOptions = useMemo<PoolTypeOptionItem[]>(() => {
    const result: PoolTypeOptionItem[] = [];
    const seen = new Set<string>();
    const add = (item: PoolTypeOptionItem) => {
      if (seen.has(item.type)) return;
      seen.add(item.type);
      result.push(item);
    };
    const normalize = (item: string | { type: string; label: string }) => {
      if (typeof item === "string") add({ type: item, label: getPoolLabel(item) });
      else add({ type: item.type, label: item.label || getPoolLabel(item.type) });
    };
    const accountPoolTypes = accountsResource.data?.poolTypes ?? [];
    const routingPoolTypes = routing?.poolTypes ?? [];
    if (accountPoolTypes.length || routingPoolTypes.length) {
      for (const item of accountPoolTypes) normalize(item);
      for (const item of routingPoolTypes) normalize(item);
    } else {
      for (const type of POOL_OPTIONS) add({ type, label: getPoolLabel(type) });
    }
    for (const rule of rules) {
      for (const type of rule.poolTypePriority) add({ type, label: getPoolLabel(type) });
    }
    return result;
  }, [accountsResource.data?.poolTypes, routing?.poolTypes, rules]);
  const poolTypeLabels = useMemo(() => Object.fromEntries(poolTypeOptions.map((option) => [option.type, option.label])), [poolTypeOptions]);
  const poolTypes = poolTypeOptions.map((option) => option.type);
  const poolPreferences = routing?.poolPreferences ?? accountsResource.data?.poolPreferences ?? {};
  const [updatingPool, setUpdatingPool] = useState<string | null>(null);
  const [poolMessage, setPoolMessage] = useState<string | null>(null);
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidatePageSize, setCandidatePageSize] = useState(10);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidatePool, setCandidatePool] = useState<string>("all");

  const filteredCandidates = useMemo(() => {
    const q = candidateQuery.trim().toLowerCase();
    return accounts.filter((account) => {
      if (candidatePool !== "all" && (account.poolType || "opencode-go") !== candidatePool) return false;
      if (!q) return true;
      const haystack = [
        account.name,
        account.email,
        account.id,
        account.workspaceId,
        account.poolType,
      ].map((v) => String(v || "").toLowerCase()).join(" ");
      return haystack.includes(q);
    });
  }, [accounts, candidatePool, candidateQuery]);

  const candidateTotal = filteredCandidates.length;
  const candidateTotalPages = Math.max(1, Math.ceil(candidateTotal / Math.max(candidatePageSize, 1)));
  const safeCandidatePage = Math.min(candidatePage, candidateTotalPages);
  const pagedCandidates = useMemo(() => {
    const start = (safeCandidatePage - 1) * candidatePageSize;
    return filteredCandidates.slice(start, start + candidatePageSize);
  }, [filteredCandidates, safeCandidatePage, candidatePageSize]);

  async function savePoolPreferred(poolType: string, value: string) {
    setUpdatingPool(poolType); setPoolMessage(null);
    const preferredAccountId = value === "none" ? null : value;
    try {
      const response = await adminFetch("/api/admin/routing", { method: "PATCH", body: JSON.stringify({ poolType, preferredAccountId }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "保存失败");
      setPoolMessage(`${poolTypeLabels[poolType] ?? getPoolLabel(poolType)} 首选账号已更新`);
      await routingResource.refresh();
    } catch (cause) { setPoolMessage(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setUpdatingPool(null); }
  }

  const loading = routingResource.loading || accountsResource.loading;
  const error = routingResource.error || accountsResource.error;
  const refreshAll = () => {
    void routingResource.refresh();
    void accountsResource.refresh();
    void modelRoutingResource.refresh();
    void providerModelsResource.refresh();
  };

  return (
    <>
      <PageIntro eyebrow="SMART ROUTING" title="智能路由" description="优先账号只决定第一候选。该账号没有额度时，请求会在内部继续尝试下一个可用账号。模型路由规则按模型名称匹配号池优先级。" actions={<Button variant="outline" size="sm" onClick={refreshAll}><RefreshCw data-icon="inline-start" />刷新缓存</Button>} />
      <div className="space-y-4">
        <Panel>
          <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-success/20 bg-success-soft"><ShieldCheck className="size-4 text-success" /></div>
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">智能轮询始终开启</p><p className="mt-1 text-xs leading-5 text-muted-foreground">只有订阅有效、额度可用的账号会进入候选池。模型路由规则会根据请求的模型名称选择号池优先级。</p></div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-sm border border-success/20 bg-success-soft px-2 py-1 text-xs text-success"><CheckCircle2 className="size-3.5" />ACTIVE</span>
          </div>
        </Panel>
        {error ? <Panel><ErrorState message={error} onRetry={refreshAll} /></Panel> : null}
        {!error ? <div className="grid gap-4 xl:grid-cols-[minmax(320px,.7fr)_minmax(0,1.3fr)]">
          <Panel title="号池首选账号" description="为每种号池类型单独配置第一候选账号。">
            <div className="space-y-1 p-4 sm:p-5">
              {poolTypes.map((poolType) => {
                const poolAccounts = accounts.filter((account) => (account.poolType || "opencode-go") === poolType);
                const current = poolPreferences[poolType] ?? "none";
                const isUpdating = updatingPool === poolType;
                return (
                  <div key={poolType} className="flex items-center justify-between gap-3 py-2">
                    <PoolTypeBadge poolType={poolType} label={poolTypeLabels[poolType]} />
                    {poolAccounts.length === 0 ? (
                      <span className="text-xs text-muted-foreground">暂无账号</span>
                    ) : (
                      <PreferredAccountPicker
                        accounts={poolAccounts}
                        value={current}
                        disabled={isUpdating}
                        onChange={(value) => void savePoolPreferred(poolType, value)}
                      />
                    )}
                  </div>
                );
              })}
              <div className="mt-3 rounded-md border bg-[#fafafa] p-3 text-xs leading-5 text-muted-foreground">当前服务账号：<span className="font-mono text-foreground">{routing?.currentAccountId || "暂无"}</span><br />最早恢复：<span className="font-mono text-foreground">{formatDate((routing as RoutingConfig & { nextRecoveryAt?: string })?.nextRecoveryAt)}</span></div>
              {poolMessage ? <p className="text-xs text-muted-foreground" role="status">{poolMessage}</p> : null}
            </div>
          </Panel>
          <Panel title="候选账号" description="显示缓存状态，不额外触发上游额度请求。">
            {loading ? <LoadingTable rows={5} columns={3} /> : accounts.length ? (
              <>
                <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:px-5">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                      value={candidateQuery}
                      onChange={(event) => { setCandidateQuery(event.target.value); setCandidatePage(1); }}
                      placeholder="搜索候选账号"
                      className="h-8 rounded-md bg-white pl-8 text-xs"
                    />
                  </div>
                  <Select value={candidatePool} onValueChange={(value) => { setCandidatePool(value); setCandidatePage(1); }}>
                    <SelectTrigger className="w-[132px] bg-white text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                    <SelectItem value="all">全部号池</SelectItem>
                    {poolTypes.map((poolType) => (
                      <SelectItem key={poolType} value={poolType}>{poolTypeLabels[poolType] ?? getPoolLabel(poolType)}</SelectItem>
                    ))}
                    </SelectContent>
                  </Select>
                </div>
                {pagedCandidates.length ? (
                  <div className="max-h-[min(360px,50vh)] divide-y overflow-y-auto overscroll-contain">
                    {pagedCandidates.map((account, index) => {
                      const ordinal = (safeCandidatePage - 1) * candidatePageSize + index + 1;
                      return (
                        <div key={account.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:items-center sm:px-5">
                          <span className="font-mono text-xs text-muted-foreground">{String(ordinal).padStart(2, "0")}</span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{account.name || account.email || account.id}</p>
                            <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{account.workspaceId || account.id}</p>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <PoolTypeBadge poolType={account.poolType} label={account.poolLabel} />
                            <AccountBadges account={account} />
                            <BillingSafetyBadge account={account} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState title="没有匹配的候选账号" description="调整搜索词或号池筛选后再试。" />
                )}
                <PaginationBar
                  page={safeCandidatePage}
                  pageSize={candidatePageSize}
                  total={candidateTotal}
                  onPageChange={setCandidatePage}
                  onPageSizeChange={(value) => { setCandidatePageSize(value); setCandidatePage(1); }}
                  pageSizeOptions={[10, 20, 50, 100]}
                />
              </>
            ) : (
              <EmptyState title="没有候选账号" description="先在账号池中添加并验证至少一个 Provider 账号。" />
            )}
          </Panel>
        </div> : null}

        <ModelRoutingSection rules={rules} loading={modelRoutingResource.loading} error={modelRoutingResource.error} adminFetch={adminFetch} onRefresh={() => void modelRoutingResource.refresh()} poolTypeOptions={poolTypeOptions} labels={poolTypeLabels} />
        <ProviderModelsSection
          catalogs={catalogs}
          loading={providerModelsResource.loading}
          error={providerModelsResource.error}
          adminFetch={adminFetch}
          onRefresh={() => void providerModelsResource.refresh()}
        />
        <ModelPricingSection adminFetch={adminFetch} />
      </div>
    </>
  );
}



interface ModelPricingStatus {
  source: string;
  modelCount: number;
  fetchedAt: string | null;
  updatedAt: string | null;
  error: string | null;
  stale: boolean;
}

function ModelPricingSection({ adminFetch }: { adminFetch: (path: string, init?: RequestInit) => Promise<Response> }) {
  const resource = useAdminResource<{ pricing?: ModelPricingStatus }>("/api/admin/model-pricing");
  const pricing = resource.data?.pricing;
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refreshPricing() {
    setRefreshing(true);
    setMessage(null);
    try {
      const response = await adminFetch("/api/admin/model-pricing", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "刷新价格失败");
      setMessage(`已更新 ${payload?.pricing?.modelCount ?? 0} 个模型价格`);
      await resource.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "刷新价格失败");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Panel
      title="模型价格缓存"
      description="从 OpenRouter /models 拉取参考价，用于请求日志与用量看板的费用估算。仅启动时自动拉取，平时可手动刷新。"
      action={
        <Button size="sm" variant="outline" onClick={() => void refreshPricing()} disabled={refreshing || resource.loading}>
          <RefreshCw data-icon="inline-start" className={refreshing ? "animate-spin" : undefined} />
          {refreshing ? "更新中" : "更新价格"}
        </Button>
      }
    >
      {resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : null}
      {!resource.error ? (
        <div className="space-y-3 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-md border bg-[#fafafa] p-3">
              <p className="text-[11px] text-muted-foreground">来源</p>
              <p className="mt-1 text-sm font-medium">OpenRouter</p>
            </div>
            <div className="rounded-md border bg-[#fafafa] p-3">
              <p className="text-[11px] text-muted-foreground">模型数</p>
              <p className="mt-1 font-mono text-sm font-medium">{pricing?.modelCount ?? 0}</p>
            </div>
            <div className="rounded-md border bg-[#fafafa] p-3">
              <p className="text-[11px] text-muted-foreground">最近拉取</p>
              <p className="mt-1 font-mono text-xs">{formatDate(pricing?.fetchedAt)}</p>
            </div>
            <div className="rounded-md border bg-[#fafafa] p-3">
              <p className="text-[11px] text-muted-foreground">状态</p>
              <p className="mt-1 text-sm font-medium">{pricing?.stale ? "未缓存" : pricing?.error ? "有错误" : "可用"}</p>
            </div>
          </div>
          {pricing?.error ? (
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
              {pricing.error}
            </p>
          ) : null}
          {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
          <p className="text-[11px] leading-5 text-muted-foreground">
            费用为 OpenRouter 公开参考价估算（USD），不等于上游实际账单。模型 ID 会做短名匹配（如 grok-4.5 → x-ai/grok-4.5）。
          </p>
        </div>
      ) : null}
    </Panel>
  );
}


function accountLabel(account: Account) {
  return account.name || account.email || account.id;
}

function PreferredAccountPicker({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }
  const selected = value !== "none" ? accounts.find((account) => account.id === value) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((account) => {
      const haystack = [account.name, account.email, account.id, account.workspaceId]
        .map((item) => String(item || "").toLowerCase())
        .join(" ");
      return haystack.includes(q);
    });
  }, [accounts, query]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) { setOpen(false); setQuery(""); }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); setQuery(""); }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative w-full max-w-xs flex-1">
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => changeOpen(!open)}
        className="h-8 w-full justify-between bg-white px-2.5 text-left text-xs font-normal"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="min-w-0 truncate text-foreground">
          {selected ? accountLabel(selected) : "不指定"}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>
      {open ? (
        <div className="absolute top-[calc(100%+4px)] right-0 z-40 w-[min(100vw-2rem,20rem)] origin-top-right overflow-hidden rounded-lg border bg-white shadow-md ring-1 ring-foreground/10 duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] animate-in fade-in-0 zoom-in-95 slide-in-from-top-1">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索账号名 / 邮箱 / ID"
                className="h-8 rounded-md bg-[#fafafa] pl-7 text-xs"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1" role="listbox">
            <Button
              type="button"
              variant="ghost"
              role="option"
              aria-selected={value === "none"}
              className="h-auto w-full justify-between px-2.5 py-2 text-left text-xs font-normal"
              onClick={() => {
                onChange("none");
                changeOpen(false);
              }}
            >
              <span>不指定</span>
              {value === "none" ? <Check className="size-3.5 text-foreground" aria-hidden="true" /> : null}
            </Button>
            {filtered.length ? filtered.map((account) => {
              const active = value === account.id;
              return (
                <Button
                  key={account.id}
                  type="button"
                  variant="ghost"
                  role="option"
                  aria-selected={active}
                  className="h-auto w-full items-start justify-between px-2.5 py-2 text-left font-normal"
                  onClick={() => {
                    onChange(account.id);
                    changeOpen(false);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{accountLabel(account)}</span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                      {account.email || account.workspaceId || account.id}
                    </span>
                  </span>
                  {active ? <Check className="mt-0.5 size-3.5 shrink-0 text-foreground" aria-hidden="true" /> : null}
                </Button>
              );
            }) : (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">没有匹配账号</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProviderModelsSection({ catalogs, loading, error, adminFetch, onRefresh }: {
  catalogs: ProviderModelCatalog[];
  loading: boolean;
  error: string | null;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onRefresh: () => void;
}) {
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  async function refreshCatalog(poolType?: string, label?: string) {
    setRefreshing(poolType ?? "all");
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await adminFetch("/api/admin/provider-models", {
        method: "POST",
        body: JSON.stringify(poolType ? { poolType } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "刷新模型列表失败");
      setActionMessage(poolType ? `${label ?? getPoolLabel(poolType)} 模型列表已刷新` : "全部 Provider 模型列表已刷新");
      onRefresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "刷新模型列表失败");
    } finally {
      setRefreshing(null);
    }
  }

  return (
    <Panel
      title="Provider 模型目录"
      description="默认使用内置列表；服务启动、账号导入后会尝试拉取上游 /models，也可手动刷新。"
      action={
        <Button size="sm" variant="outline" onClick={() => void refreshCatalog()} disabled={Boolean(refreshing)}>
          <RefreshCw data-icon="inline-start" />
          {refreshing === "all" ? "刷新中" : "全部刷新"}
        </Button>
      }
    >
      {actionError ? <div className="mx-4 mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive" role="alert">{actionError}</div> : null}
      {actionMessage ? <div className="mx-4 mt-3 rounded-md border bg-[#fafafa] px-4 py-2.5 text-xs text-muted-foreground" role="status">{actionMessage}</div> : null}
      {loading ? <LoadingTable rows={4} columns={3} /> : null}
      {error ? <ErrorState message={error} onRetry={onRefresh} /> : null}
      {!loading && !error && !catalogs.length ? (
        <EmptyState title="还没有模型目录" description="导入至少一个 Provider 账号后，可刷新上游模型列表。" />
      ) : null}
      {!loading && !error && catalogs.length ? (
        <div className="divide-y">
          {catalogs.map((catalog) => (
            <div key={catalog.poolType} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <PoolTypeBadge poolType={catalog.poolType} label={catalog.label} />
                  <Badge variant="outline" className="h-5 rounded-sm px-1.5 text-[11px]">{catalog.source}</Badge>
                  <span className="text-[11px] text-muted-foreground">{catalog.models.length} 个模型</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {catalog.models.slice(0, 24).map((model) => (
                    <code key={model} className="rounded-sm bg-[#f5f5f5] px-1.5 py-0.5 font-mono text-[11px]">{model}</code>
                  ))}
                  {catalog.models.length > 24 ? (
                    <span className="text-[11px] text-muted-foreground">+{catalog.models.length - 24}</span>
                  ) : null}
                </div>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                  最近同步：{formatDate(catalog.fetchedAt || catalog.updatedAt)}
                  {catalog.error ? ` · ${catalog.error}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refreshCatalog(catalog.poolType, catalog.label)}
                disabled={Boolean(refreshing)}
              >
                <RefreshCw data-icon="inline-start" />
                {refreshing === catalog.poolType ? "刷新中" : "拉取 /models"}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function ModelRoutingSection({ rules, loading, error, adminFetch, onRefresh, poolTypeOptions, labels }: {
  rules: ModelRouteRule[];
  loading: boolean;
  error: string | null;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onRefresh: () => void;
  poolTypeOptions: PoolTypeOptionItem[];
  labels: Record<string, string>;
}) {
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);
  const [editRule, setEditRule] = useState<ModelRouteRule | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggleRule(rule: ModelRouteRule) {
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/model-routing/${encodeURIComponent(rule.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!response.ok) { const p = await response.json().catch(() => null); throw new Error(p?.error?.message || p?.message || "更新失败"); }
      onRefresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "更新失败"); }
  }

  async function deleteRule(rule: ModelRouteRule) {
    const approved = await confirm({ title: "删除路由规则？", description: `${rule.modelPattern} 将不再参与模型路由匹配。`, confirmText: "删除规则", destructive: true });
    if (!approved) return;
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/model-routing/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) { const p = await response.json().catch(() => null); throw new Error(p?.error?.message || p?.message || "删除失败"); }
      onRefresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "删除失败"); }
  }

  async function updatePriority(rule: ModelRouteRule, newPriority: string[]) {
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/model-routing/${encodeURIComponent(rule.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ poolTypePriority: newPriority }),
      });
      if (!response.ok) { const p = await response.json().catch(() => null); throw new Error(p?.error?.message || p?.message || "更新失败"); }
      onRefresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "更新失败"); }
  }

  return (
    <Panel
      title="模型路由优先级"
      description="按模型名称匹配号池优先级。匹配到规则的请求会按优先级顺序尝试对应号池中的账号。"
      action={
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus data-icon="inline-start" />添加规则
        </Button>
      }
    >
      {actionError ? <div className="mx-4 mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive" role="alert">{actionError}</div> : null}
      {loading ? <LoadingTable rows={4} columns={4} /> : null}
      {error ? <ErrorState message={error} onRetry={onRefresh} /> : null}
      {!loading && !error && !rules.length ? (
        <EmptyState title="还没有模型路由规则" description="添加规则将模型名称映射到号池优先级。未匹配的请求会使用默认号池顺序。" action={<Button size="sm" onClick={() => setAddOpen(true)}><Plus data-icon="inline-start" />添加规则</Button>} />
      ) : null}
      {!loading && !error && rules.length ? (
        <div className="divide-y">
          {rules.map((rule) => (
            <ModelRouteRow
              key={rule.id}
              rule={rule}
              labels={labels}
              onToggle={() => void toggleRule(rule)}
              onEdit={() => setEditRule(rule)}
              onDelete={() => void deleteRule(rule)}
              onReorder={(newPriority) => void updatePriority(rule, newPriority)}
            />
          ))}
        </div>
      ) : null}
      <AddRuleDialog open={addOpen} onOpenChange={setAddOpen} adminFetch={adminFetch} onCreated={onRefresh} options={poolTypeOptions} />
      {editRule ? (
        <EditRuleDialog rule={editRule} open={Boolean(editRule)} onOpenChange={(o) => { if (!o) setEditRule(null); }} adminFetch={adminFetch} onUpdated={onRefresh} options={poolTypeOptions} />
      ) : null}
    </Panel>
  );
}

function ModelRouteRow({ rule, onToggle, onEdit, onDelete, onReorder, labels }: {
  rule: ModelRouteRule;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReorder: (newPriority: string[]) => void;
  labels: Record<string, string>;
}) {
  const priority = rule.poolTypePriority;
  function moveUp(idx: number) { if (idx > 0) { const next = [...priority]; [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]; onReorder(next); } }
  function moveDown(idx: number) { if (idx < priority.length - 1) { const next = [...priority]; [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]; onReorder(next); } }

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="rounded-sm bg-[#f5f5f5] px-1.5 py-0.5 font-mono text-xs font-medium">{rule.modelPattern}</code>
          {!rule.enabled ? <Badge variant="outline" className="h-5 rounded-sm px-1.5 text-[11px] text-muted-foreground">已停用</Badge> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {priority.map((pool, idx) => (
            <div key={pool + idx} className="flex items-center gap-1">
              {idx > 0 ? <span className="text-[10px] text-muted-foreground">→</span> : null}
              <div className="flex items-center gap-0.5">
                <span className="inline-flex items-center gap-1 rounded-sm border bg-white px-1.5 py-0.5 text-[11px] font-medium">
                  {labels[pool] ?? getPoolLabel(pool)}
                </span>
                <div className="flex flex-col">
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => moveUp(idx)} disabled={idx === 0} className="text-muted-foreground" aria-label="上移">
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => moveDown(idx)} disabled={idx === priority.length - 1} className="text-muted-foreground" aria-label="下移">
                    <ArrowDown className="size-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onToggle}>{rule.enabled ? "停用" : "启用"}</Button>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="编辑规则"><Pencil /></Button>
        <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={onDelete} aria-label="删除规则"><Trash2 /></Button>
      </div>
    </div>
  );
}

function PrioritySelector({ value, onChange, options }: {
  value: string[];
  onChange: (v: string[]) => void;
  options: PoolTypeOptionItem[];
}) {
  const [selected, setSelected] = useState<string[]>(value);

  function toggle(pool: string) {
    const next = selected.includes(pool) ? selected.filter((p) => p !== pool) : [...selected, pool];
    setSelected(next);
    onChange(next);
  }

  function moveUp(idx: number) {
    if (idx > 0) { const next = [...selected]; [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]; setSelected(next); onChange(next); }
  }
  function moveDown(idx: number) {
    if (idx < selected.length - 1) { const next = [...selected]; [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]; setSelected(next); onChange(next); }
  }

  const optionTypes = options.map((option) => option.type);
  const buttonPools = Array.from(new Set([...optionTypes, ...value.filter((pool) => !optionTypes.includes(pool))]));
  const labelFor = (pool: string) => options.find((option) => option.type === pool)?.label ?? getPoolLabel(pool);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {buttonPools.map((pool) => (
          <Button
            key={pool}
            type="button"
            variant={selected.includes(pool) ? "default" : "outline"}
            size="sm"
            onClick={() => toggle(pool)}
            className={selected.includes(pool) ? undefined : "bg-white text-muted-foreground"}
          >
            {labelFor(pool)}
          </Button>
        ))}
      </div>
      {selected.length ? (
        <div className="rounded-md border bg-[#fafafa] p-2.5">
          <p className="mb-1.5 text-[11px] text-muted-foreground">优先级顺序（从上到下）</p>
          <div className="space-y-1">
            {selected.map((pool, idx) => (
              <div key={pool + idx} className="flex items-center gap-2">
                <GripVertical className="size-3.5 text-muted-foreground/50" />
                <span className="font-mono text-[10px] text-muted-foreground">{idx + 1}</span>
                <span className="text-xs font-medium">{labelFor(pool)}</span>
                <div className="ml-auto flex gap-0.5">
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => moveUp(idx)} disabled={idx === 0} className="text-muted-foreground" aria-label="上移"><ArrowUp className="size-3.5" /></Button>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => moveDown(idx)} disabled={idx === selected.length - 1} className="text-muted-foreground" aria-label="下移"><ArrowDown className="size-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : <p className="text-[11px] text-muted-foreground">选择至少一个号池类型</p>}
    </div>
  );
}

function AddRuleDialog({ open, onOpenChange, adminFetch, onCreated, options }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onCreated: () => void;
  options: PoolTypeOptionItem[];
}) {
  const [patterns, setPatterns] = useState("");
  const [priority, setPriority] = useState<string[]>(options.map((option) => option.type));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setPatterns(""); setPriority(options.map((option) => option.type)); setError(null); }

  async function handleSubmit() {
    const patternList = patterns.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

    if (!patternList.length) { setError("请输入至少一个模型 pattern"); return; }
    if (!priority.length) { setError("请选择至少一个号池类型"); return; }
    setSubmitting(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/model-routing", {
        method: "POST",
        body: JSON.stringify({ modelPatterns: patternList, poolTypePriority: priority }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "创建规则失败");
      reset();
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建规则失败");
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>添加模型路由规则</DialogTitle>
          <DialogDescription>将模型名称映射到号池优先级。支持批量添加多个 pattern。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-4 overflow-y-auto px-5 py-6">
          <div className="space-y-2">
            <Label htmlFor="rule-patterns" className="text-xs font-medium text-foreground">模型 Pattern</Label>
            <Textarea id="rule-patterns" value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder="gpt-5*\nclaude-sonnet-4-5\ngpt-4o" className="min-h-20 rounded-md font-mono text-sm" />


            <p className="text-[11px] text-muted-foreground">支持通配符。多个 pattern 用逗号或换行分隔，共享同一优先级配置。</p>
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-medium text-foreground">号池优先级</Label>
            <PrioritySelector value={priority} onChange={setPriority} options={options} />
          </div>
          {error ? <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive" role="alert">{error}</div> : null}
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4">
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>{submitting ? "正在创建" : "创建规则"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditRuleDialog({ rule, open, onOpenChange, adminFetch, onUpdated, options }: {
  rule: ModelRouteRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onUpdated: () => void;
  options: PoolTypeOptionItem[];
}) {
  const [pattern, setPattern] = useState(rule.modelPattern);
  const [priority, setPriority] = useState<string[]>(rule.poolTypePriority);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!pattern.trim()) { setError("Pattern 不能为空"); return; }
    if (!priority.length) { setError("请选择至少一个号池类型"); return; }
    setSubmitting(true); setError(null);
    try {
      const response = await adminFetch(`/api/admin/model-routing/${encodeURIComponent(rule.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelPattern: pattern.trim(), poolTypePriority: priority }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "更新规则失败");
      onOpenChange(false);
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新规则失败");
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>编辑路由规则</DialogTitle>
          <DialogDescription>修改模型 pattern 或号池优先级。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-4 overflow-y-auto px-5 py-6">
          <div className="space-y-2">
            <Label htmlFor="edit-pattern" className="text-xs font-medium text-foreground">模型 Pattern</Label>
            <Input id="edit-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} className="h-9 rounded-md font-mono text-sm" />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-medium text-foreground">号池优先级</Label>
            <PrioritySelector value={priority} onChange={setPriority} options={options} />
          </div>
          {error ? <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive" role="alert">{error}</div> : null}
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>{submitting ? "正在保存" : "保存修改"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
