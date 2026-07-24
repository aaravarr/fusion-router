"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  CircleOff,
  Download,
  Eye,
  KeyRound,
  MoreHorizontal,
  Power,
  Puzzle,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageIntro, Panel, ErrorState, LoadingTable, EmptyState, PaginationBar, StatsStrip, formatDate } from "./page-kit";
import { QuotaForecastPanel } from "./quota-forecast-panel";
import { AccountBadges, BillingSafetyBadge, getPoolLabel, getPoolQuotaKinds, getQuota, PoolTypeBadge, POOL_TYPE_META, QuotaStatus, StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import { useAdmin } from "./admin-context";
import type { Account } from "./types";
import { ImportJobProgress, ImportTaskCenter, type ImportJob, useImportJobStream } from "./import-task-center";
import { PoolTypeFilterBar, type PoolFilterOption } from "./pool-type-filter";

interface AccountStats {
  total: number;
  ready: number;
  blocked: number;
  disabled: number;
  banned: number;
  authError: number;
  inactive: number;
  overQuota: number;
  avgUsagePercent: number | null;
  byPoolType?: Record<string, { total: number; ready: number; blocked: number; inactive: number; overQuota?: number }>;
}

interface AccountsPayload {
  items?: Account[];
  accounts?: Account[];
  total?: number;
  page?: number;
  pageSize?: number;
  stats?: AccountStats;
  poolPreferences?: Record<string, string | null>;
  poolTypes?: { type: string; label: string; description: string; quotaKinds: string[] }[];
}

const POOL_FILTERS = [
  { key: "all", label: "全部" },
  { key: "opencode-go", label: "OpenCode Go" },
  { key: "openai", label: "OpenAI" },
  { key: "xai-grok", label: "xAI Grok" },
  { key: "kimi-code", label: "Kimi Code" },
] as const;

const STATUS_FILTERS = [
  { key: "all", label: "全部状态" },
  { key: "ready", label: "可路由" },
  { key: "blocked", label: "额度阻塞" },
  { key: "over_quota", label: "已超限" },
  { key: "disabled", label: "已停用" },
  { key: "banned", label: "已封禁" },
  { key: "auth_error", label: "认证异常" },
  { key: "inactive", label: "不可用" },
] as const;

const SORT_OPTIONS = [
  { key: "recent", label: "最近活跃" },
  { key: "usage", label: "用量从高到低" },
  { key: "name", label: "名称" },
  { key: "created", label: "创建时间" },
] as const;

type TokenImportFormat = "cpa-json" | "refresh-token" | "access-token" | "xai-sso";
type TokenImportSpec = {
  poolType: string;
  format: TokenImportFormat;
  title: string;
  description: string;
  placeholder: string;
};

function poolOf(account: Account) {
  return account.poolType || "opencode-go";
}

export function AccountsPage() {
  const { adminFetch } = useAdmin();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sort, setSort] = useState<string>("recent");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Account | null>(null);
  const [connectorOpen, setConnectorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tokenImport, setTokenImport] = useState<TokenImportSpec | null>(null);
  const [openaiOauthOpen, setOpenaiOauthOpen] = useState(false);
  const [kimiOauthOpen, setKimiOauthOpen] = useState(false);
  const [kimiRefreshOpen, setKimiRefreshOpen] = useState(false);
  const [jobVersion, setJobVersion] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<"enable" | "disable" | "delete" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [downloadInfo, setDownloadInfo] = useState<{ version: string | null; downloadUrl: string } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const listPath = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sort,
    });
    if (poolFilter !== "all") params.set("poolType", poolFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    return `/api/admin/accounts?${params.toString()}`;
  }, [page, pageSize, poolFilter, statusFilter, sort, debouncedQuery]);

  const resource = useAdminResource<AccountsPayload>(listPath);
  const accounts = resource.data?.items ?? resource.data?.accounts ?? [];
  const total = resource.data?.total ?? accounts.length;
  const stats = resource.data?.stats;
  const visibleAccountIds = accounts.map((account) => account.id);
  const allVisibleSelected = visibleAccountIds.length > 0 && visibleAccountIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleAccountIds.some((id) => selectedIds.has(id));

  const poolOptions = useMemo<PoolFilterOption[]>(() => {
    const fromApi = (resource.data?.poolTypes ?? [])
      .map((item) => {
        const meta = POOL_TYPE_META[item.type]
        return {
          key: item.type,
          label: item.label || meta?.label || item.type,
          // Prefer short Chinese copy for the mobile dropdown; API descriptions are English ops notes.
          description: meta?.description || item.description,
        }
      })
      .filter((item) => item.key);
    const fallback = POOL_FILTERS.filter((item) => item.key !== "all").map((item) => ({
      key: item.key,
      label: item.label,
      description: POOL_TYPE_META[item.key]?.description,
    }));
    const options = fromApi.length > 0 ? fromApi : fallback;
    return [{ key: "all", label: "全部", description: "查看所有 Provider 账号" }, ...options];
  }, [resource.data?.poolTypes]);

  const poolCounts = useMemo(() => {
    const byPool = stats?.byPoolType ?? {};
    const counts: Record<string, number | undefined> = {};
    let all = 0;
    for (const [key, value] of Object.entries(byPool)) {
      const total = value?.total ?? 0;
      counts[key] = total;
      all += total;
    }
    // Prefer sum of per-pool totals so chip badges stay stable when a single pool is selected.
    counts.all = all;
    return counts;
  }, [stats]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/extension/latest").then((r) => r.json().catch(() => null)).then((data) => {
      if (!cancelled && data?.downloadUrl) setDownloadInfo({ version: data.version ?? null, downloadUrl: data.downloadUrl });
    }).catch(() => undefined);
    return () => { cancelled = true };
  }, []);

  // Show monthly column only when opencode-go accounts are in the visible set
  const showMonthly = accounts.some((a) => poolOf(a) === "opencode-go") || poolFilter === "opencode-go" || poolFilter === "all";

  async function patchAccount(account: Account, body: Record<string, unknown>) {
    setBusyId(account.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "账号更新失败");
      await resource.refresh();
      if (selected?.id === account.id) setSelected((payload?.account as Account) || null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "账号更新失败");
    } finally {
      setBusyId(null);
    }
  }

  async function setPreferred(account: Account) {
    setBusyId(account.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch("/api/admin/routing", {
        method: "PATCH",
        body: JSON.stringify({ preferredAccountId: account.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "优先账号设置失败");
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "优先账号设置失败");
    } finally {
      setBusyId(null);
    }
  }

  async function refreshAccount(account: Account) {
    setBusyId(account.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/refresh`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "账号同步失败");
      if (payload?.account) setSelected(payload.account as Account);
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "账号同步失败");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAccount(account: Account) {
    if (!window.confirm(`确认删除 ${account.name || account.email || account.id}？该账号的连接信息将被清除，此操作不可恢复。`)) return;
    setBusyId(account.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || payload?.message || "账号删除失败");
      }
      if (selected?.id === account.id) setSelected(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(account.id);
        return next;
      });
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "账号删除失败");
    } finally {
      setBusyId(null);
    }
  }

  function toggleAccountSelection(accountId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else if (next.size < 500) next.add(accountId);
      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const id of visibleAccountIds) next.delete(id);
      } else {
        for (const id of visibleAccountIds) {
          if (next.size >= 500) break;
          next.add(id);
        }
      }
      return next;
    });
  }

  async function runBulkAction(action: "enable" | "disable" | "delete") {
    const accountIds = [...selectedIds];
    if (!accountIds.length) return;
    if (action === "delete" && !window.confirm(`确认永久删除选中的 ${accountIds.length} 个账号？关联凭据和额度记录也会一并清除，此操作不可恢复。`)) return;
    setBulkBusy(action);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch("/api/admin/accounts/bulk", {
        method: "POST",
        body: JSON.stringify({ action, accountIds }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "批量操作失败");
      const affected = Number(action === "delete" ? payload?.deleted : payload?.updated) || 0;
      const skippedBanned = Number(payload?.skippedBanned) || 0;
      const notFound = Number(payload?.notFound) || 0;
      const actionLabel = action === "enable" ? "启用" : action === "disable" ? "停用" : "删除";
      const details = [skippedBanned ? `跳过永久封禁 ${skippedBanned} 个` : "", notFound ? `未找到 ${notFound} 个` : ""].filter(Boolean);
      setActionNotice(`已${actionLabel} ${affected} 个账号${details.length ? `，${details.join("，")}` : ""}。`);
      setSelectedIds(new Set());
      if (selected && accountIds.includes(selected.id)) setSelected(null);
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "批量操作失败");
    } finally {
      setBulkBusy(null);
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="ACCOUNT POOL"
        title="多 Provider 账号池"
        description="按 Provider 独立管理凭据、额度、导入与调度。先选择号池，再使用该 Provider 支持的接入方式。"
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
              <RefreshCw data-icon="inline-start" />刷新缓存
            </Button>
            {downloadInfo && poolFilter === "opencode-go" ? (
              <Button variant="outline" size="sm" asChild>
                <a href={downloadInfo.downloadUrl} target="_blank" rel="noopener noreferrer" download>
                  <Download data-icon="inline-start" />下载插件{downloadInfo.version ? ` v${downloadInfo.version}` : ""}
                </a>
              </Button>
            ) : null}
            {poolFilter === "opencode-go" ? (
              <Button size="sm" onClick={() => setConnectorOpen(true)}><Puzzle data-icon="inline-start" />连接 Go 账号</Button>
            ) : poolFilter === "openai" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="sm"><Upload data-icon="inline-start" />导入 OpenAI 账号</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-44">
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setOpenaiOauthOpen(true)}><KeyRound />OpenAI OAuth 登录</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setImportOpen(true)}><FileUp />Sub2API JSON</DropdownMenuItem>
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    onSelect={() => setTokenImport({
                      poolType: "openai",
                      format: "refresh-token",
                      title: "导入 OpenAI OAuth Refresh Token",
                      description: "每行一个 OAuth refresh token。后台会刷新 access_token 并写入统一 OpenAI 号池。",
                      placeholder: "每行一个 refresh token",
                    })}
                  ><KeyRound />OAuth Refresh Token</DropdownMenuItem>
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    onSelect={() => setTokenImport({
                      poolType: "openai",
                      format: "access-token",
                      title: "导入 OpenAI Access Token",
                      description: "每行一个 Access Token（支持 at-* PAT）。无 refresh token，无法自动刷新。",
                      placeholder: "每行一个 access token（如 at-...）",
                    })}
                  ><KeyRound />Access Token</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : poolFilter === "xai-grok" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="sm"><Upload data-icon="inline-start" />导入 xAI 账号</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-44">
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setTokenImport({
                    poolType: "xai-grok",
                    format: "cpa-json",
                    title: "导入 xAI CPA JSON",
                    description: "兼容 CLIProxyAPI xAI auth JSON 与 grok2api Grok Build JSON/JSONL 导出。",
                    placeholder: "粘贴 JSON，或选择一个或多个 JSON 文件",
                  })}><FileUp />CPA JSON</DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setImportOpen(true)}><FileUp />Sub2API JSON</DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setTokenImport({
                    poolType: "xai-grok",
                    format: "refresh-token",
                    title: "导入 xAI Refresh Token",
                    description: "每行一个 refresh token。后台会刷新凭据、识别账号并探测真实额度。",
                    placeholder: "每行一个 refresh token",
                  })}><KeyRound />Refresh Token</DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setTokenImport({
                    poolType: "xai-grok",
                    format: "xai-sso",
                    title: "导入 xAI SSO",
                    description: "每行一个 Grok Web SSO Key，后台通过 Device Flow 转换为 OAuth 凭据。",
                    placeholder: "每行一个 SSO Token（eyJ...）",
                  })}><KeyRound />xAI SSO</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : poolFilter === "kimi-code" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="sm"><KeyRound data-icon="inline-start" />连接 Kimi 账号</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-44">
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setKimiOauthOpen(true)}><KeyRound />Kimi OAuth 登录</DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => setKimiRefreshOpen(true)}><FileUp />Refresh Token</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 min-w-0 rounded-xl border bg-card p-3 sm:p-3.5">
        <PoolTypeFilterBar
          value={poolFilter}
          onChange={(next) => {
            setPoolFilter(next);
            setPage(1);
          }}
          options={poolOptions}
          counts={poolCounts}
        />
      </div>

      <div className="mb-4">
        <StatsStrip
          items={[
            { label: "账号总数", value: stats?.total ?? total, hint: poolFilter === "all" ? "当前筛选范围" : "当前号池" },
            { label: "可路由", value: stats?.ready ?? "—", hint: "可立即承载请求", tone: "success" },
            { label: "额度阻塞", value: stats?.blocked ?? "—", hint: "等待恢复 / 当天不可用", tone: "warning" },
            { label: "已超限", value: stats?.overQuota ?? "—", hint: poolFilter === "xai-grok" ? "滚动 24h ≥ 100%" : "主额度窗口 ≥ 100%", tone: "danger" },
            { label: "不可用", value: stats?.inactive ?? "—", hint: `停用 ${stats?.disabled ?? 0} · 封禁 ${stats?.banned ?? 0} · 认证异常 ${stats?.authError ?? 0}` },
            { label: "平均用量", value: stats?.avgUsagePercent == null ? "—" : `${stats.avgUsagePercent.toFixed(2)}%`, hint: "主额度窗口均值" },
          ]}
          className="sm:grid-cols-3 xl:grid-cols-6"
        />
      </div>

      <div className="mb-4">
        <QuotaForecastPanel
          poolType={poolFilter}
          showPoolFilter={false}
          compact
        />
      </div>

      {actionError ? <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">{actionError}</div> : null}
      {actionNotice ? <div className="mb-4 rounded-md border border-success/20 bg-success-soft px-4 py-3 text-sm text-success" role="status">{actionNotice}</div> : null}

      <ImportTaskCenter version={jobVersion} poolType={poolFilter} onAccountsChanged={() => void resource.refresh()} />

      <Panel
        title="账号"
        description={`${total} 个匹配账号。额度耗尽和账号异常会自动切换，永久封禁账号会从调度中移除。`}
        action={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative w-full min-w-0 sm:w-64 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、邮箱或标识" className="h-8 w-full rounded-md bg-white pl-8 text-xs" />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <select
                className="h-8 w-full rounded-md border bg-white px-2 text-xs sm:w-auto"
                value={statusFilter}
                onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
              >
                {STATUS_FILTERS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
              <select
                className="h-8 w-full rounded-md border bg-white px-2 text-xs sm:w-auto"
                value={sort}
                onChange={(event) => { setSort(event.target.value); setPage(1); }}
              >
                {SORT_OPTIONS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </div>
          </div>
        }
      >
        {selectedIds.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-[#fafafa] px-4 py-3">
            <span className="mr-auto text-xs text-muted-foreground">已选择 <span className="font-medium text-foreground">{selectedIds.size}</span> 个账号</span>
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())} disabled={Boolean(bulkBusy)}>取消选择</Button>
            <Button variant="outline" size="sm" onClick={() => void runBulkAction("enable")} disabled={Boolean(bulkBusy)}><Power data-icon="inline-start" />{bulkBusy === "enable" ? "启用中" : "批量启用"}</Button>
            <Button variant="outline" size="sm" onClick={() => void runBulkAction("disable")} disabled={Boolean(bulkBusy)}><CircleOff data-icon="inline-start" />{bulkBusy === "disable" ? "停用中" : "批量停用"}</Button>
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => void runBulkAction("delete")} disabled={Boolean(bulkBusy)}><Trash2 data-icon="inline-start" />{bulkBusy === "delete" ? "删除中" : "批量删除"}</Button>
          </div>
        ) : null}
        {resource.loading ? <LoadingTable rows={6} columns={showMonthly ? 10 : 9} /> : null}
        {resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : null}
        {!resource.loading && !resource.error && !total ? (
          <EmptyState
            title={query || statusFilter !== "all" || poolFilter !== "all" ? "没有匹配的账号" : "还没有账号"}
            description={query || statusFilter !== "all" || poolFilter !== "all" ? "调整搜索条件、状态或号池筛选后重试。" : "先选择号池，再使用该 Provider 支持的方式接入账号。"}
            action={query || statusFilter !== "all" ? undefined : poolFilter === "opencode-go" ? (
              <Button size="sm" onClick={() => setConnectorOpen(true)}><Puzzle />连接 Go 账号</Button>
            ) : poolFilter === "xai-grok" ? (
              <Button size="sm" onClick={() => setTokenImport({
                poolType: "xai-grok",
                format: "cpa-json",
                title: "导入 xAI CPA JSON",
                description: "兼容 CLIProxyAPI xAI auth JSON 与 grok2api Grok Build JSON/JSONL 导出。",
                placeholder: "粘贴 JSON，或选择一个或多个 JSON 文件",
              })}><Upload />导入 xAI 账号</Button>
            ) : poolFilter === "kimi-code" ? (
              <Button size="sm" onClick={() => setKimiOauthOpen(true)}><KeyRound />Kimi OAuth 登录</Button>
            ) : poolFilter === "openai" ? (
              <Button size="sm" onClick={() => setOpenaiOauthOpen(true)}><KeyRound />OpenAI OAuth 登录</Button>
            ) : <span className="text-xs text-muted-foreground">请先在上方选择一个号池。</span>}
          />
        ) : null}
        {!resource.loading && !resource.error && total ? (
          <Table className={showMonthly ? "min-w-[1244px]" : "min-w-[1124px]"}>
            <TableHeader className="bg-[#fafafa]">
              <TableRow className="hover:bg-[#fafafa]">
                <TableHead className="w-11 px-4">
                  <input
                    ref={(node) => { if (node) node.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisibleSelection}
                    aria-label="选择当前页全部账号"
                    className="size-4 cursor-pointer accent-foreground"
                  />
                </TableHead>
                <TableHead className="w-[230px] px-4 text-xs text-muted-foreground">账号</TableHead>
                <TableHead className="w-[110px] text-xs text-muted-foreground">号池</TableHead>
                <TableHead className="w-[150px] text-xs text-muted-foreground">状态</TableHead>
                <TableHead className="text-xs text-muted-foreground">{poolFilter === "xai-grok" ? "滚动 24 小时" : poolFilter === "all" ? "主额度窗口" : "5 小时"}</TableHead>
                <TableHead className="text-xs text-muted-foreground">{poolFilter === "xai-grok" ? "其他窗口" : poolFilter === "all" ? "次额度窗口" : "周"}</TableHead>
                {showMonthly ? <TableHead className="text-xs text-muted-foreground">月</TableHead> : null}
                <TableHead className="w-[150px] text-xs text-muted-foreground">订阅 / 凭据</TableHead>
                <TableHead className="w-[130px] text-xs text-muted-foreground">最近同步</TableHead>
                <TableHead className="w-14 px-4 text-right text-xs text-muted-foreground">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => {
                const isGo = poolOf(account) === "opencode-go";
                return (
                  <TableRow key={account.id} className={selectedIds.has(account.id) ? "bg-muted/50" : account.isCurrent ? "bg-info-soft/60 hover:bg-info-soft" : undefined}>
                    <TableCell className="px-4">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(account.id)}
                        onChange={() => toggleAccountSelection(account.id)}
                        aria-label={`选择账号 ${account.name || account.email || account.id}`}
                        className="size-4 cursor-pointer accent-foreground"
                      />
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <button type="button" className="group block max-w-[210px] text-left" onClick={() => setSelected(account)}>
                        <span className="flex items-center gap-1.5 truncate text-sm font-medium group-hover:underline group-hover:underline-offset-4">
                          {account.name || account.email || "未命名账号"}
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{account.workspaceId || account.id}</span>
                      </button>
                    </TableCell>
                    <TableCell><PoolTypeBadge poolType={account.poolType} /></TableCell>
                    <TableCell><AccountBadges account={account} /></TableCell>
                    {account.poolType === "xai-grok" ? (
                      <>
                        <TableCell><QuotaStatus label="24H" quota={getQuota(account, "rolling24h")} /></TableCell>
                        <TableCell><span className="font-mono text-[10px] text-muted-foreground">—</span></TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell><QuotaStatus label="5H" quota={getQuota(account, "fiveHour")} /></TableCell>
                        <TableCell><QuotaStatus label="WEEK" quota={getQuota(account, "weekly")} /></TableCell>
                      </>
                    )}
                    {showMonthly ? (
                      <TableCell>{isGo ? <QuotaStatus label="MONTH" quota={getQuota(account, "monthly")} /> : (account.poolType === "xai-grok" ? <span className="font-mono text-[10px] text-muted-foreground">滚动</span> : <span className="font-mono text-[10px] text-muted-foreground">—</span>)}</TableCell>
                    ) : null}
                    <TableCell className="space-y-1.5">
                      <StatusBadge status={account.subscriptionState} />
                      <BillingSafetyBadge account={account} />
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{formatDate(account.lastSyncedAt || account.lastUsageCheckAt)}</TableCell>
                    <TableCell className="px-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" disabled={busyId === account.id} aria-label={`操作 ${account.name || account.id}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setSelected(account)}><Eye />查看详情</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void setPreferred(account)}><Star />设为优先账号</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {account.disabledReason !== "XAI_ACCOUNT_BANNED" ? <DropdownMenuItem onSelect={() => void patchAccount(account, { adminState: account.adminState === "DISABLED" ? "ENABLED" : "DISABLED" })}>
                            <CircleOff />{account.adminState === "DISABLED" ? "启用账号" : "停用账号"}
                          </DropdownMenuItem> : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onSelect={() => void deleteAccount(account)}>
                            <Trash2 />删除账号
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
        {!resource.loading && !resource.error && total > 0 ? (
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={total}
            loading={resource.loading}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        ) : null}
      </Panel>

      <ConnectorSheet open={connectorOpen} onOpenChange={setConnectorOpen} downloadInfo={downloadInfo} />
     <Sub2ApiImportDialog open={importOpen} poolType={poolFilter === "all" ? "openai" : poolFilter} onOpenChange={setImportOpen} onCreated={() => setJobVersion((value) => value + 1)} />
      <OpenAIOauthLoginDialog open={openaiOauthOpen} onOpenChange={setOpenaiOauthOpen} onCreated={() => { setJobVersion((v) => v + 1); void resource.refresh(); }} />
      <KimiOauthLoginDialog open={kimiOauthOpen} onOpenChange={setKimiOauthOpen} onCreated={() => { setJobVersion((v) => v + 1); void resource.refresh(); }} />
      <KimiRefreshTokenDialog open={kimiRefreshOpen} onOpenChange={setKimiRefreshOpen} onCreated={() => { setJobVersion((v) => v + 1); void resource.refresh(); }} />
      <TokenLineImportDialog spec={tokenImport} open={Boolean(tokenImport)} onOpenChange={(open) => { if (!open) setTokenImport(null); }} onCreated={() => setJobVersion((value) => value + 1)} />
     <AccountDetailSheet
        account={selected}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        onPreferred={setPreferred}
        onToggle={(account) => patchAccount(account, { adminState: account.adminState === "DISABLED" ? "ENABLED" : "DISABLED" })}
        onRefresh={refreshAccount}
        onDelete={deleteAccount}
        busy={Boolean(selected && busyId === selected.id)}
      />
    </>
  );
}

function ConnectorSheet({ open, onOpenChange, downloadInfo }: { open: boolean; onOpenChange: (open: boolean) => void; downloadInfo: { version: string | null; downloadUrl: string } | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>通过浏览器插件连接账号</DialogTitle>
          <DialogDescription>Google 登录发生在你的浏览器中，后端不会接触 Google 密码。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-3 overflow-y-auto px-5 py-6">
          <ConnectorStep index="01" icon={Puzzle} title="下载并加载插件" description="下载插件压缩包并解压，在 Chrome / Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”指向解压后的目录。">
            {downloadInfo ? (
              <Button variant="outline" size="sm" asChild className="mt-2 w-fit">
                <a href={downloadInfo.downloadUrl} target="_blank" rel="noopener noreferrer" download>
                  <Download data-icon="inline-start" />下载插件{downloadInfo.version ? ` v${downloadInfo.version}` : ""}
                </a>
              </Button>
            ) : null}
          </ConnectorStep>
          <ConnectorStep index="02" icon={KeyRound} title="配置连接" description="打开插件，填写本系统的访问地址，以及当前用户在“API 密钥”页面创建的统一入口 Key。" />
          <ConnectorStep index="03" icon={Star} title="使用 Google 登录" description="点击插件中的 Google 登录。完成 OpenCode 授权并进入 workspace 后，插件会自动上报并同步额度。" />
          <div className="mt-5 rounded-md border border-info/20 bg-info-soft px-4 py-3 text-xs leading-5 text-muted-foreground">
            后端会查找名为 <code className="font-mono text-foreground">OpenCode to API</code> 的 Go Key；已存在则复用，否则自动创建。Cookie 和完整 Go Key 只会加密保存在后端。
          </div>
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4 sm:mx-0 sm:justify-start">
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorStep({ index, icon: Icon, title, description, children }: { index: string; icon: typeof Puzzle; title: string; description: string; children?: React.ReactNode }) {
  return (
    <section className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 rounded-md border bg-[#fafafa] p-4">
      <span className="grid size-9 place-items-center rounded-md border bg-white"><Icon className="size-4" strokeWidth={1.75} aria-hidden="true" /></span>
      <div><p className="font-mono text-[9px] text-muted-foreground">STEP {index}</p><h3 className="mt-1 text-sm font-medium">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>{children}</div>
    </section>
  );
}

function AccountDetailSheet({ account, onOpenChange, onPreferred, onToggle, onRefresh, onDelete, busy }: {
  account: Account | null;
  onOpenChange: (open: boolean) => void;
  onPreferred: (account: Account) => Promise<void>;
  onToggle: (account: Account) => Promise<void>;
  onRefresh: (account: Account) => Promise<void>;
  onDelete: (account: Account) => Promise<void>;
  busy: boolean;
}) {
  const quotaKinds = account ? getPoolQuotaKinds(account.poolType) : ["fiveHour", "weekly", "monthly"];
  const isGo = account ? poolOf(account) === "opencode-go" : false;

  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {account ? (
          <>
            <DialogHeader className="border-b px-5 py-4">
              <div className="min-w-0 pr-8"><DialogTitle className="truncate" title={account.name || account.email || "未命名账号"}>{account.name || account.email || "未命名账号"}</DialogTitle><DialogDescription className="mt-1 truncate font-mono text-[11px]" title={account.workspaceId || account.id}>{account.workspaceId || account.id}</DialogDescription></div>
            </DialogHeader>
            <div className="scrollbar-thin max-h-[calc(88dvh-160px)] space-y-5 overflow-y-auto px-5 py-5">
              <div className="flex flex-wrap gap-2"><PoolTypeBadge poolType={account.poolType} /><AccountBadges account={account} /><BillingSafetyBadge account={account} /></div>
              {isGo && account.billingGuard !== "VERIFIED_GO_ONLY" ? (
                <div className="rounded-md border border-warning/25 bg-warning-soft px-3.5 py-3 text-xs leading-5 text-foreground">
                  {account.useBalance === true
                    ? "按量回退已开启。为避免产生额外费用，该账号不会参与路由；请先在 OpenCode Go 控制台关闭 Use balance，再立即同步。"
                    : "尚未取得 Use balance 状态，因此暂不参与路由。服务重启完成字段升级后，点击下方“立即同步”即可重新读取，无需重新录入账号。"}
                </div>
              ) : null}
              <DetailSection title="额度窗口" description={isGo ? "来自最近一次 Console 同步。" : "来自真实上游响应头；立即同步会发送一次最小额度探测。"}>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-2.5">
                  {quotaKinds.includes("fiveHour") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="5 小时" quota={getQuota(account, "fiveHour")} variant="card" /></div> : null}
                  {quotaKinds.includes("weekly") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="每周" quota={getQuota(account, "weekly")} variant="card" /></div> : null}
                  {quotaKinds.includes("monthly") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="每月" quota={getQuota(account, "monthly")} variant="card" /></div> : null}
                  {quotaKinds.includes("rolling24h") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="滚动 24 小时" quota={getQuota(account, "rolling24h")} variant="card" /></div> : null}
                </div>
              </DetailSection>
              {isGo ? (
                <>
                  <DetailSection title="订阅与计费">
                    <div className="divide-y rounded-md border">
                      <DetailRow label="订阅状态" value={account.subscriptionState || "未知"} />
                      <DetailRow label="Go Subscription ID" value={account.goSubscriptionId || "未返回"} mono />
                      <DetailRow label="Zen 订阅" value={account.isZenSubscribed ? account.zenSubscriptionId || "已订阅" : "未订阅"} mono={Boolean(account.zenSubscriptionId)} />
                      <DetailRow label="订阅管理入口" value={account.hasManageSubscriptionButton ? "可用" : "未检测到"} />
                      <DetailRow label="Use balance" value={account.useBalance === false ? "已关闭" : account.useBalance === true ? "已开启（禁止路由）" : "未知（禁止路由）"} />
                    </div>
                  </DetailSection>
                  <DetailSection title="连接信息">
                    <div className="divide-y rounded-md border">
                      <DetailRow label="Workspace" value={account.workspaceId || "未知"} mono />
                      <DetailRow label="Go Key ID" value={account.goKeyId || "未知"} mono />
                      <DetailRow label="插件版本" value={account.extensionVersion || "未记录"} mono />
                      <DetailRow label="最近同步" value={formatDate(account.lastSyncedAt)} mono />
                      <DetailRow label="最近额度检查" value={formatDate(account.lastUsageCheckAt)} mono />
                    </div>
                  </DetailSection>
                </>
              ) : (
                <DetailSection title="连接信息">
                  <div className="divide-y rounded-md border">
                    <DetailRow label="号池类型" value={getPoolLabel(account.poolType)} />
                    <DetailRow label="凭据状态" value={account.authState === "VALID" ? "有效" : account.authState || "未知"} />
                    {account.disabledReason ? <DetailRow label="停用原因" value={account.disabledReason === "XAI_ACCOUNT_BANNED" ? "xAI 上游已封禁此账号" : account.disabledReason} /> : null}
                    {account.lastError ? <DetailRow label="最近错误" value={account.lastError} /> : null}
                    <DetailRow label="最近同步" value={formatDate(account.lastSyncedAt)} mono />
                    <DetailRow label="最近额度检查" value={formatDate(account.lastUsageCheckAt)} mono />
                  </div>
                </DetailSection>
              )}
            </div>
            <DialogFooter className="mb-0 flex-row flex-wrap border-t bg-[#fafafa] px-5 py-4 sm:mx-0 sm:justify-start">
              <Button variant="outline" onClick={() => void onRefresh(account)} disabled={busy}><RefreshCw className={busy ? "animate-spin" : undefined} data-icon="inline-start" />{busy ? "同步中" : "立即同步"}</Button>
              <Button variant="outline" onClick={() => void onToggle(account)} disabled={busy || account.disabledReason === "XAI_ACCOUNT_BANNED"}>{account.disabledReason === "XAI_ACCOUNT_BANNED" ? "账号已永久封禁" : account.adminState === "DISABLED" ? "启用账号" : "停用账号"}</Button>
              <Button onClick={() => void onPreferred(account)} disabled={busy}><Star data-icon="inline-start" />设为优先</Button>
              <Button variant="outline" className="text-destructive" onClick={() => void onDelete(account)} disabled={busy}><Trash2 data-icon="inline-start" />删除账号</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <section><div className="mb-2.5"><h3 className="text-xs font-medium text-foreground">{title}</h3>{description ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{description}</p> : null}</div>{children}</section>;
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid gap-1 px-3 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-xs text-muted-foreground">{label}</span><span className={`min-w-0 break-all text-sm sm:text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span></div>;
}

function Sub2ApiImportDialog({ open, poolType, onOpenChange, onCreated }: { open: boolean; poolType: string; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const { adminFetch } = useAdmin();
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const liveJob = useImportJobStream(job, onCreated);
  const [dragOver, setDragOver] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [detectedAccounts, setDetectedAccounts] = useState(0);

  function reset() {
    setJsonText(""); setError(null); setJob(null); setFileCount(0); setDetectedAccounts(0);
  }

  // Merge a parsed Sub2API payload (or array) into whatever is currently in
  // the textarea. The textarea stays the single source of truth so users can
  // still hand-edit after dropping files; multiple files accumulate.
  function accountsFromPayload(parsed: unknown, label: string): { accounts: unknown[]; extras: Record<string, unknown> } {
    let incomingAccounts: unknown;
    let incomingExtras: Record<string, unknown> = {};
    if (Array.isArray(parsed)) {
      incomingAccounts = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).accounts)) {
      const obj = parsed as Record<string, unknown>;
      incomingAccounts = obj.accounts;
      incomingExtras = { ...obj };
      delete incomingExtras.accounts;
    } else {
      throw new Error(`${label}: JSON 顶层不是对象且不含 accounts 数组，也不是数组`);
    }
    return { accounts: incomingAccounts as unknown[], extras: incomingExtras };
  }

  function mergeIntoTextarea(payloads: Array<{ parsed: unknown; label: string }>) {
    const incoming = payloads.map(({ parsed, label }) => accountsFromPayload(parsed, label));
    let existing: Record<string, unknown> = {};
    try {
      const cur = jsonText.trim() ? JSON.parse(jsonText) : null;
      if (cur && typeof cur === "object" && !Array.isArray(cur) && Array.isArray((cur as Record<string, unknown>).accounts)) {
        existing = { ...(cur as Record<string, unknown>) };
      }
    } catch { /* current textarea not valid JSON — start fresh */ }
    const mergedAccounts = [...((existing.accounts as unknown[]) ?? []), ...incoming.flatMap((item) => item.accounts)];
    const merged = { ...existing, ...Object.assign({}, ...incoming.map((item) => item.extras)), accounts: mergedAccounts };
    setJsonText(JSON.stringify(merged, null, 2));
    setDetectedAccounts(mergedAccounts.length);
  }

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    const list = Array.from(files).filter((f) => f.type === "application/json" || f.name.toLowerCase().endsWith(".json") || f.type === "");
    if (!list.length) { setError("请选择 .json 文件"); return; }
    const parsedFiles: Array<{ parsed: unknown; label: string }> = [];
    let firstErr: string | null = null;
    for (const file of list) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        parsedFiles.push({ parsed, label: file.name });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : "解析失败";
        if (!firstErr) firstErr = `${file.name}: ${msg}`;
      }
    }
    if (parsedFiles.length) mergeIntoTextarea(parsedFiles);
    setFileCount((c) => c + parsedFiles.length);
    if (firstErr) setError(firstErr);
  }

  async function handleSubmit() {
    if (!jsonText.trim()) { setError("请粘贴 Sub2API JSON 内容"); return; }
    try {
      JSON.parse(jsonText);
    } catch {
      setError("JSON 格式无效，请检查输入内容"); return;
    }
    setSubmitting(true); setError(null); setJob(null);
    try {
      const response = await adminFetch("/api/admin/import-jobs", {
        method: "POST",
        body: JSON.stringify({ poolType, format: "sub2api-json", input: jsonText }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "导入账号失败");
      setJob(payload.job as ImportJob);
      setJsonText("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入账号失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>导入 Sub2API JSON</DialogTitle>
        <DialogDescription>粘贴 Sub2API 导出的 JSON，自动识别 platform=openai 与 platform=grok（xAI）的账号并导入。</DialogDescription>
      </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-4 overflow-y-auto px-5 py-6">
          {/* 拖拽 / 选择 / 粘贴文件区域 */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const item of items) {
                if (item.kind === "file") {
                  const f = item.getAsFile();
                  if (f) files.push(f);
                }
              }
              if (files.length) { e.preventDefault(); void handleFiles(files); }
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-border bg-[#fafafa] hover:bg-[#f4f4f4]"}`}
          >
            <FileUp className="size-7 text-muted-foreground" />
            <div className="text-sm font-medium">
              {dragOver ? "松开即可导入文件" : "拖拽 JSON 文件到此处，或点击选择"}
            </div>
            <div className="text-[11px] text-muted-foreground">支持 .json 文件，可多选；可直接粘贴文件</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              className="hidden"
              onChange={(e) => { if (e.target.files?.length) void handleFiles(e.target.files); e.currentTarget.value = ""; }}
            />
          </div>
          {fileCount > 0 || detectedAccounts > 0 ? (
            <div className="rounded-md border bg-[#fafafa] px-3.5 py-2 text-xs text-muted-foreground">
              已载入 {fileCount} 个文件，检测到 <span className="font-medium text-foreground">{detectedAccounts}</span> 个账号
            </div>
          ) : null}
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder={'{\n  "type": "sub2api-data",\n  "accounts": [...]\n}'}
            className="min-h-[280px] resize-y rounded-md font-mono text-xs leading-5"
            spellCheck={false}
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            也可以直接粘贴 Sub2API 导出的完整 JSON。系统会自动识别 platform=openai（AT token / OAuth）和 platform=grok（xAI）的账号并批量导入，其余账号将被跳过。支持一次导入多个账号。
          </p>
          {error ? <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive" role="alert">{error}</div> : null}
          {liveJob ? <ImportJobProgress job={liveJob} /> : null}
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4">
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || liveJob?.status === "RUNNING" || liveJob?.status === "QUEUED"}>
            {submitting ? "正在创建任务" : liveJob ? "重新导入" : "开始后台导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenLineImportDialog({
  spec,
  open,
  onOpenChange,
  onCreated,
}: {
  spec: TokenImportSpec | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { adminFetch } = useAdmin();
  const [tokenText, setTokenText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const liveJob = useImportJobStream(job, onCreated);

  function reset() {
    setTokenText("");
    setError(null);
    setJob(null);
  }

  async function handleSubmit() {
    if (!spec || !tokenText.trim()) {
      setError("请填写要导入的凭据");
      return;
    }
    setSubmitting(true);
    setError(null);
    setJob(null);
    try {
      const response = await adminFetch("/api/admin/import-jobs", {
        method: "POST",
        body: JSON.stringify({ poolType: spec.poolType, format: spec.format, input: tokenText }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "导入任务创建失败");
      setJob(payload.job as ImportJob);
      setTokenText("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入任务创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{spec?.title || "导入凭据"}</DialogTitle>
          <DialogDescription>{spec?.description || "粘贴凭据后开始导入。"}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-4 overflow-y-auto px-5 py-6">
          <Textarea
            value={tokenText}
            onChange={(e) => setTokenText(e.target.value)}
            placeholder={spec?.placeholder || "每行一条凭据"}
            className="min-h-[200px] resize-y rounded-md font-mono text-xs leading-5"
            spellCheck={false}
          />
          {error ? <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive" role="alert">{error}</div> : null}
          {liveJob ? <ImportJobProgress job={liveJob} /> : null}
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4">
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || liveJob?.status === "RUNNING" || liveJob?.status === "QUEUED"}>
            {submitting ? "正在创建任务" : liveJob ? "重新导入" : "开始后台导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpenAIOauthLoginDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const { adminFetch } = useAdmin();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function reset() {
    setSessionId(null);
    setAuthorizationUrl(null);
    setCallbackUrl("");
    setLoading(false);
    setError(null);
    setSuccess(false);
  }

  function close(next: boolean) {
    if (!next) {
      if (sessionId && !success) {
        void adminFetch("/api/admin/accounts/openai-oauth/cancel", {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        }).catch(() => undefined);
      }
      reset();
    }
    onOpenChange(next);
  }

  async function startAuthorization() {
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/accounts/openai-oauth/start", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "生成 OpenAI 授权链接失败");
      setSessionId(payload.sessionId);
      setAuthorizationUrl(payload.authorizationUrl);
      window.open(payload.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成 OpenAI 授权链接失败");
    } finally {
      setLoading(false);
    }
  }

  async function completeAuthorization() {
    if (!sessionId || !callbackUrl.trim()) {
      setError("请先打开授权页，并粘贴授权后的完整回调 URL");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/accounts/openai-oauth/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId, callbackUrl: callbackUrl.trim() }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "OpenAI OAuth 登录失败");
      setSuccess(true);
      onCreated();
      window.setTimeout(() => close(false), 900);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenAI OAuth 登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>OpenAI OAuth 登录</DialogTitle>
          <DialogDescription>使用 Codex CLI 官方 OAuth + PKCE 授权，成功后自动写入 OpenAI 号池。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-4 overflow-y-auto px-5 py-6">
          <div className="rounded-md border bg-[#fafafa] p-3 text-xs leading-5 text-muted-foreground">
            <p><span className="font-medium text-foreground">1.</span> 打开授权页并完成 OpenAI 登录。</p>
            <p><span className="font-medium text-foreground">2.</span> 浏览器跳转到 localhost 后可能显示无法访问，这是正常现象。</p>
            <p><span className="font-medium text-foreground">3.</span> 复制地址栏中的完整 URL，粘贴到下方完成授权。</p>
          </div>
          {!authorizationUrl ? (
            <Button onClick={() => void startAuthorization()} disabled={loading}>
              <KeyRound data-icon="inline-start" />{loading ? "正在生成" : "生成并打开授权链接"}
            </Button>
          ) : (
            <div className="space-y-3">
              <Button variant="outline" asChild>
                <a href={authorizationUrl} target="_blank" rel="noopener noreferrer"><KeyRound data-icon="inline-start" />重新打开授权页</a>
              </Button>
              <div className="space-y-1.5">
                <label htmlFor="openai-oauth-callback" className="text-xs font-medium">完整回调 URL</label>
                <Textarea
                  id="openai-oauth-callback"
                  value={callbackUrl}
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                  className="min-h-28 resize-y font-mono text-xs"
                  spellCheck={false}
                />
              </div>
            </div>
          )}
          {error ? <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive" role="alert">{error}</div> : null}
          {success ? <div className="rounded-md border border-success/20 bg-success-soft px-3.5 py-2.5 text-xs text-success">授权成功，账号已写入 OpenAI 号池。</div> : null}
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4">
          <Button variant="outline" onClick={() => close(false)}>取消</Button>
          {authorizationUrl ? <Button onClick={() => void completeAuthorization()} disabled={loading || success || !callbackUrl.trim()}>{loading ? "正在兑换凭据" : "完成授权"}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function KimiOauthLoginDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const { adminFetch } = useAdmin();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "success">("idle");
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      pollRef.current = null;
      const resetTimer = window.setTimeout(() => {
        setLoading(false);
        setError(null);
        setUserCode(null);
        setVerifyUrl(null);
        setStatus("idle");
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    let cancelled = false;
    async function start() {
      setLoading(true);
      setError(null);
      setStatus("idle");
      try {
        const response = await adminFetch("/api/admin/accounts/kimi-oauth/start", { method: "POST" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || "启动 Kimi OAuth 失败");
        if (cancelled) return;
        setUserCode(payload.userCode);
        setVerifyUrl(payload.verificationUriComplete || payload.verificationUri);
        setStatus("waiting");
        if (payload.verificationUriComplete) {
          window.open(payload.verificationUriComplete, "_blank", "noopener,noreferrer");
        }
        const poll = async (id: string) => {
          if (cancelled) return;
          try {
            const pollResp = await adminFetch("/api/admin/accounts/kimi-oauth/poll", {
              method: "POST",
              body: JSON.stringify({ sessionId: id }),
            });
            const pollPayload = await pollResp.json().catch(() => ({}));
            if (!pollResp.ok) throw new Error(pollPayload?.error?.message || "轮询失败");
            if (pollPayload.status === "success") {
              setStatus("success");
              onCreated();
              window.setTimeout(() => onOpenChange(false), 800);
              return;
            }
            if (pollPayload.status === "expired") throw new Error("设备码已过期，请重试");
            if (pollPayload.status === "denied") throw new Error(pollPayload.description || "授权被拒绝");
            const waitSec = Math.max(1, Number(pollPayload.interval || 5));
            pollRef.current = window.setTimeout(() => void poll(id), waitSec * 1000);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "轮询失败");
            setStatus("idle");
          }
        };
        pollRef.current = window.setTimeout(() => void poll(payload.sessionId), Math.max(1, Number(payload.interval || 5)) * 1000);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "启动失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void start();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [open, adminFetch, onCreated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kimi OAuth 登录</DialogTitle>
          <DialogDescription>
            模拟 Kimi Code CLI 设备码登录。浏览器完成授权后，账号会自动写入号池。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {loading ? <p className="text-muted-foreground">正在申请设备码…</p> : null}
          {error ? <p className="text-destructive">{error}</p> : null}
          {userCode ? (
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">用户码</p>
              <p className="mt-1 font-mono text-lg tracking-[0.2em]">{userCode}</p>
              {verifyUrl ? (
                <a className="mt-2 inline-block text-xs text-info underline" href={verifyUrl} target="_blank" rel="noreferrer">
                  打开授权页
                </a>
              ) : null}
            </div>
          ) : null}
          {status === "waiting" ? <p className="text-muted-foreground">等待浏览器授权完成…</p> : null}
          {status === "success" ? <p className="text-success">登录成功，账号已导入。</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KimiRefreshTokenDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const { adminFetch } = useAdmin();
  const [tokenText, setTokenText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const liveJob = useImportJobStream(job, onCreated);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/import-jobs", {
        method: "POST",
        body: JSON.stringify({ poolType: "kimi-code", format: "refresh-token", input: tokenText }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "创建导入任务失败");
      setJob(payload.job as ImportJob);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); if (!next) { setTokenText(""); setJob(null); setError(null); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入 Kimi Refresh Token</DialogTitle>
          <DialogDescription>每行一个 refresh token。后台会刷新 access_token 并写入 kimi-code 号池。</DialogDescription>
        </DialogHeader>
        <Textarea value={tokenText} onChange={(e) => setTokenText(e.target.value)} rows={8} placeholder={"refresh_token_1\nrefresh_token_2"} />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {liveJob ? <ImportJobProgress job={liveJob} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => void onSubmit()} disabled={busy || !tokenText.trim()}>{busy ? "提交中…" : "开始导入"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
