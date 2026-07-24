"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, GripVertical, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAdmin } from "./admin-context";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { AccountBadges, BillingSafetyBadge, getPoolLabel, PoolTypeBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { Account, ModelRouteRule, RoutingConfig } from "./types";

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

const POOL_OPTIONS = ["opencode-go", "openai-cpa", "openai-oauth", "xai-grok", "kimi-code"] as const;

export function RoutingPage() {
  const routingResource = useAdminResource<RoutingPayload>("/api/admin/routing");
  const accountsResource = useAdminResource<AccountsPayload>("/api/admin/accounts?pageSize=500&sort=name");
  const modelRoutingResource = useAdminResource<ModelRoutingPayload>("/api/admin/model-routing");
  const providerModelsResource = useAdminResource<ProviderModelsPayload>("/api/admin/provider-models");
  const { adminFetch } = useAdmin();
  const routing = routingResource.data?.routing ?? routingResource.data;
  const accounts = accountsResource.data?.items ?? accountsResource.data?.accounts ?? [];
  const rules = modelRoutingResource.data?.rules ?? [];
  const catalogs = providerModelsResource.data?.catalogs ?? [];
  // per-pool-type 首选账号：从 routing data 取当前配置与号池类型列表
  const rawPoolTypes = routing?.poolTypes ?? accountsResource.data?.poolTypes ?? Array.from(new Set(accounts.map((a) => a.poolType || "opencode-go"))) ?? [...POOL_OPTIONS];
  // Normalize: accounts API may return poolTypes as objects { type, label, ... }, extract .type
  const poolTypes = Array.from(new Set(rawPoolTypes.map((pt: unknown) => typeof pt === "string" ? pt : (pt as { type?: string }).type ?? "").filter(Boolean)));
  const poolPreferences = routing?.poolPreferences ?? accountsResource.data?.poolPreferences ?? {};
  const [updatingPool, setUpdatingPool] = useState<string | null>(null);
  const [poolMessage, setPoolMessage] = useState<string | null>(null);

  async function savePoolPreferred(poolType: string, value: string) {
    setUpdatingPool(poolType); setPoolMessage(null);
    const preferredAccountId = value === "none" ? null : value;
    try {
      const response = await adminFetch("/api/admin/routing", { method: "PATCH", body: JSON.stringify({ poolType, preferredAccountId }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "保存失败");
      setPoolMessage(`${getPoolLabel(poolType)} 首选账号已更新`);
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
                    <PoolTypeBadge poolType={poolType} />
                    {poolAccounts.length === 0 ? (
                      <span className="text-xs text-muted-foreground">暂无账号</span>
                    ) : (
                      <Select value={current} onValueChange={(value) => void savePoolPreferred(poolType, value)} disabled={isUpdating}>
                        <SelectTrigger className="flex-1 max-w-xs w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">不指定</SelectItem>
                          {poolAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name || account.email || account.id}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })}
              <div className="mt-3 rounded-md border bg-[#fafafa] p-3 text-xs leading-5 text-muted-foreground">当前服务账号：<span className="font-mono text-foreground">{routing?.currentAccountId || "暂无"}</span><br />最早恢复：<span className="font-mono text-foreground">{formatDate((routing as RoutingConfig & { nextRecoveryAt?: string })?.nextRecoveryAt)}</span></div>
              {poolMessage ? <p className="text-xs text-muted-foreground" role="status">{poolMessage}</p> : null}
            </div>
          </Panel>
          <Panel title="候选账号" description="显示缓存状态，不额外触发上游额度请求。">
            {loading ? <LoadingTable rows={5} columns={3} /> : accounts.length ? <div className="divide-y">{accounts.map((account, index) => <div key={account.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:items-center sm:px-5"><span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><div className="min-w-0"><p className="truncate text-sm font-medium">{account.name || account.email || account.id}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{account.workspaceId || account.id}</p></div><div className="flex flex-wrap gap-1.5"><PoolTypeBadge poolType={account.poolType} /><AccountBadges account={account} /><BillingSafetyBadge account={account} /></div></div>)}</div> : <EmptyState title="没有候选账号" description="先在账号池中添加并验证至少一个 Provider 账号。" />}
          </Panel>
        </div> : null}

        <ModelRoutingSection rules={rules} loading={modelRoutingResource.loading} error={modelRoutingResource.error} adminFetch={adminFetch} onRefresh={() => void modelRoutingResource.refresh()} />
        <ProviderModelsSection
          catalogs={catalogs}
          loading={providerModelsResource.loading}
          error={providerModelsResource.error}
          adminFetch={adminFetch}
          onRefresh={() => void providerModelsResource.refresh()}
        />
      </div>
    </>
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

  async function refreshCatalog(poolType?: string) {
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
      setActionMessage(poolType ? `${getPoolLabel(poolType)} 模型列表已刷新` : "全部 Provider 模型列表已刷新");
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
                  <PoolTypeBadge poolType={catalog.poolType} />
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
                onClick={() => void refreshCatalog(catalog.poolType)}
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

function ModelRoutingSection({ rules, loading, error, adminFetch, onRefresh }: {
  rules: ModelRouteRule[];
  loading: boolean;
  error: string | null;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onRefresh: () => void;
}) {
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
    if (!window.confirm(`确认删除路由规则 ${rule.modelPattern}？`)) return;
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
              onToggle={() => void toggleRule(rule)}
              onEdit={() => setEditRule(rule)}
              onDelete={() => void deleteRule(rule)}
              onReorder={(newPriority) => void updatePriority(rule, newPriority)}
            />
          ))}
        </div>
      ) : null}
      <AddRuleDialog open={addOpen} onOpenChange={setAddOpen} adminFetch={adminFetch} onCreated={onRefresh} />
      {editRule ? (
        <EditRuleDialog rule={editRule} open={Boolean(editRule)} onOpenChange={(o) => { if (!o) setEditRule(null); }} adminFetch={adminFetch} onUpdated={onRefresh} />
      ) : null}
    </Panel>
  );
}

function ModelRouteRow({ rule, onToggle, onEdit, onDelete, onReorder }: {
  rule: ModelRouteRule;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReorder: (newPriority: string[]) => void;
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
                  {getPoolLabel(pool)}
                </span>
                <div className="flex flex-col">
                  <button type="button" onClick={() => moveUp(idx)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="上移">
                    <ArrowUp className="size-3" />
                  </button>
                  <button type="button" onClick={() => moveDown(idx)} disabled={idx === priority.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="下移">
                    <ArrowDown className="size-3" />
                  </button>
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

function PrioritySelector({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {POOL_OPTIONS.map((pool) => (
          <button
            key={pool}
            type="button"
            onClick={() => toggle(pool)}
            className={`h-7 rounded-md border px-2.5 text-xs font-medium transition-colors ${
              selected.includes(pool) ? "border-foreground bg-foreground text-white" : "border-border bg-white text-muted-foreground hover:text-foreground"
            }`}
          >
            {getPoolLabel(pool)}
          </button>
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
                <span className="text-xs font-medium">{getPoolLabel(pool)}</span>
                <div className="ml-auto flex gap-0.5">
                  <button type="button" onClick={() => moveUp(idx)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="上移"><ArrowUp className="size-3.5" /></button>
                  <button type="button" onClick={() => moveDown(idx)} disabled={idx === selected.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="下移"><ArrowDown className="size-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : <p className="text-[11px] text-muted-foreground">选择至少一个号池类型</p>}
    </div>
  );
}

function AddRuleDialog({ open, onOpenChange, adminFetch, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onCreated: () => void;
}) {
  const [patterns, setPatterns] = useState("");
  const [priority, setPriority] = useState<string[]>([...POOL_OPTIONS]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setPatterns(""); setPriority([...POOL_OPTIONS]); setError(null); }

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
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
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
            <PrioritySelector value={priority} onChange={setPriority} />
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

function EditRuleDialog({ rule, open, onOpenChange, adminFetch, onUpdated }: {
  rule: ModelRouteRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onUpdated: () => void;
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
            <PrioritySelector value={priority} onChange={setPriority} />
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
