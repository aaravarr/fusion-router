"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Clock3, LoaderCircle, Pause, Play, RotateCcw, Undo2, XCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useAdmin } from "./admin-context";
import { formatDate } from "./page-kit";
import { PoolTypeBadge, StatusBadge } from "./status-ui";
import { useConfirm } from "@/components/ui/confirm-provider";

export interface ImportJobItem {
  itemIndex: number;
  label: string;
  status: string;
  step?: string | null;
  accountId?: string | null;
  accountCreated?: boolean;
  error?: string | null;
  updatedAt?: string | null;
}

export interface ImportJob {
  id: string;
  poolType: string;
  format: string;
  status: "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";
  totalItems: number;
  processedItems: number;
  succeededItems: number;
  failedItems: number;
  currentStep?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  rolledBackAt?: string | null;
  rolledBackAccounts?: number;
  rollbackAccountCount?: number;
  updatedAt: string;
  items?: ImportJobItem[];
}

export function useImportJobStream(initial: ImportJob | null, onCompleted?: () => void) {
  const [streamedJob, setStreamedJob] = useState<ImportJob | null>(null);
  const job = streamedJob && initial && streamedJob.id === initial.id && streamedJob.updatedAt >= initial.updatedAt ? streamedJob : initial;
  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus === "PAUSED" || jobStatus === "COMPLETED" || jobStatus === "FAILED") return;
    const source = new EventSource(`/api/admin/import-jobs/${encodeURIComponent(jobId)}/events`);
    const update = (event: MessageEvent<string>) => {
      const next = JSON.parse(event.data) as ImportJob;
      setStreamedJob(next);
      if (next.status === "PAUSED" || next.status === "COMPLETED" || next.status === "FAILED") {
        source.close();
        onCompleted?.();
      }
    };
    source.addEventListener("progress", update as EventListener);
    return () => source.close();
  }, [jobId, jobStatus, onCompleted]);
  return job;
}

const formatLabels: Record<string, string> = {
  "sub2api-json": "Sub2API JSON",
  "cpa-json": "CPA JSON",
  "refresh-token": "Refresh Token",
  "access-token": "Access Token",
  "xai-sso": "xAI SSO",
};

function itemStatusLabel(status: string) {
  if (status === "COMPLETED") return "成功";
  if (status === "FAILED") return "失败";
  if (status === "RUNNING") return "进行中";
  if (status === "PAUSED") return "已暂停";
  if (status === "QUEUED") return "排队中";
  return status;
}

export function ImportJobProgress({
  job,
  detailed = true,
  defaultExpanded = false,
  collapsible = false,
  onRetryItem,
  retryingIndex,
  onRollback,
  rollingBack = false,
  onPause,
  onResume,
  changingState = false,
  poolTypeLabels,
}: {
  job: ImportJob;
  detailed?: boolean;
  defaultExpanded?: boolean;
  collapsible?: boolean;
  onRetryItem?: (itemIndex: number) => void;
  retryingIndex?: number | null;
  onRollback?: () => void;
  rollingBack?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  changingState?: boolean;
  poolTypeLabels?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const progress = job.totalItems ? Math.round((job.processedItems / job.totalItems) * 100) : 0;
  const items = job.items ?? [];
  const failedItems = items.filter((item) => item.status === "FAILED");
  const runningItems = items.filter((item) => item.status === "RUNNING");
  const showDetails = detailed && expanded;

  return (
    <article className="rounded-lg border bg-[#fafafa]">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <PoolTypeBadge poolType={job.poolType} label={poolTypeLabels?.[job.poolType]} />
              <span className="text-xs font-medium">{formatLabels[job.format] || job.format}</span>
              <StatusBadge status={job.status} />
              {collapsible ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  {expanded ? "收起明细" : `展开明细 (${items.length || job.totalItems})`}
                </Button>
              ) : null}
            </div>
            <p className="mt-2 truncate text-xs text-muted-foreground">{job.currentStep || "等待任务调度"}</p>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">{formatDate(job.createdAt)}</span>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Progress value={progress} className="h-1.5 flex-1" />
          <span className="w-16 text-right font-mono text-[11px] tabular-nums">{job.processedItems}/{job.totalItems}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="text-success">成功 {job.succeededItems}</span>
          <span className={job.failedItems ? "text-destructive" : undefined}>失败 {job.failedItems}</span>
          {runningItems.length ? <span className="text-info">进行中 {runningItems.length}</span> : null}
          <span>{progress}%</span>
          {job.rolledBackAt ? <span className="text-destructive">已撤销，删除 {job.rolledBackAccounts ?? 0} 个账号</span> : null}
        </div>
        {job.error ? <p className="mt-3 text-xs text-destructive">{job.error}</p> : null}
        {(job.status === "RUNNING" || job.status === "QUEUED") && onPause ? (
          <div className="mt-3 flex justify-end">
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={changingState} onClick={onPause}>
              {changingState ? <LoaderCircle className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
              暂停任务
            </Button>
          </div>
        ) : null}
        {job.status === "PAUSED" && onResume ? (
          <div className="mt-3 flex justify-end">
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={changingState} onClick={onResume}>
              {changingState ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              继续任务
            </Button>
          </div>
        ) : null}
        {!job.rolledBackAt && (job.status === "COMPLETED" || job.status === "FAILED") && (job.rollbackAccountCount ?? 0) > 0 && onRollback ? (
          <div className="mt-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-destructive/30 px-2 text-[11px] text-destructive hover:bg-destructive/5 hover:text-destructive"
              disabled={rollingBack}
              onClick={onRollback}
            >
              {rollingBack ? <LoaderCircle className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
              撤销导入（删除 {job.rollbackAccountCount} 个账号）
            </Button>
          </div>
        ) : null}
      </div>

      {showDetails ? (
        <div className="max-h-64 space-y-2 overflow-y-auto border-t px-4 py-3">
          {items.length ? items.map((item) => {
            const isFailed = item.status === "FAILED";
            const isRunning = item.status === "RUNNING";
            return (
              <div key={item.itemIndex} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-2 text-xs">
                {isRunning ? (
                  <LoaderCircle className="mt-0.5 size-3.5 animate-spin text-info" />
                ) : isFailed ? (
                  <XCircle className="mt-0.5 size-3.5 text-destructive" />
                ) : (
                  <span className="mt-0.5 size-3.5 rounded-full border border-success/40 bg-success-soft" />
                )}
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    #{item.itemIndex + 1} {item.label}
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">{itemStatusLabel(item.status)}</span>
                  </p>
                  <p className={`mt-0.5 break-words text-[11px] ${item.error ? "text-destructive" : "text-muted-foreground"}`}>
                    {item.error || item.step || "—"}
                  </p>
                </div>
                {isFailed && onRetryItem ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={retryingIndex === item.itemIndex}
                    onClick={() => onRetryItem(item.itemIndex)}
                  >
                    {retryingIndex === item.itemIndex ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                    重试
                  </Button>
                ) : null}
              </div>
            );
          }) : (
            <p className="text-[11px] text-muted-foreground">
              {failedItems.length ? "仅显示摘要，明细加载中。" : "暂无明细项。"}
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function LiveJob({
  initial,
  onCompleted,
  onRetryItem,
  retryingIndex,
  onRollback,
  rollingBack,
  onPause,
  onResume,
  changingState,
  poolTypeLabels,
}: {
  initial: ImportJob;
  onCompleted: () => void;
  onRetryItem: (jobId: string, itemIndex: number) => void;
  retryingIndex: { jobId: string; itemIndex: number } | null;
  onRollback: (job: ImportJob) => void;
  rollingBack: boolean;
  onPause: (job: ImportJob) => void;
  onResume: (job: ImportJob) => void;
  changingState: boolean;
  poolTypeLabels?: Record<string, string>;
}) {
  const job = useImportJobStream(initial, onCompleted);
  if (!job) return null;
  return (
    <ImportJobProgress
      job={job}
      detailed
      collapsible
      defaultExpanded={job.status === "RUNNING" || job.status === "QUEUED" || job.status === "PAUSED"}
      onRetryItem={(itemIndex) => onRetryItem(job.id, itemIndex)}
      retryingIndex={retryingIndex?.jobId === job.id ? retryingIndex.itemIndex : null}
      onRollback={() => onRollback(job)}
      rollingBack={rollingBack}
      onPause={() => onPause(job)}
      onResume={() => onResume(job)}
      changingState={changingState}
      poolTypeLabels={poolTypeLabels}
    />
  );
}

export function ImportTaskCenter({
  version,
  onAccountsChanged,
  poolType = "all",
  poolTypeLabels,
}: {
  version: number;
  onAccountsChanged: () => void;
  poolType?: string;
  poolTypeLabels?: Record<string, string>;
}) {
  const confirm = useConfirm();
  const { adminFetch } = useAdmin();
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(true);
  const collapsedTouchedRef = useRef(false);
  const [retrying, setRetrying] = useState<{ jobId: string; itemIndex: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [rollingBackJobId, setRollingBackJobId] = useState<string | null>(null);
  const [changingStateJobId, setChangingStateJobId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "30" });
      if (poolType && poolType !== "all") params.set("poolType", poolType);
      const response = await adminFetch(`/api/admin/import-jobs?${params.toString()}`);
      const payload = await response.json().catch(() => null) as { jobs?: ImportJob[] } | null;
      const summaries = payload?.jobs ?? [];
      const detailed = await Promise.all(summaries.map(async (summary) => {
        const detailResponse = await adminFetch(`/api/admin/import-jobs/${encodeURIComponent(summary.id)}`);
        const detail = await detailResponse.json().catch(() => null) as { job?: ImportJob } | null;
        return detail?.job ?? summary;
      }));
      setJobs(detailed);
      setActionError(null);
      // Only auto-collapse/expand when the user has not manually toggled.
      // Use a ref so this does not recreate `load` and retrigger effects.
      if (!collapsedTouchedRef.current) {
        const hasActive = detailed.some((job) => job.status === "RUNNING" || job.status === "QUEUED" || job.status === "PAUSED");
        setCollapsed(!hasActive);
      }
    } finally {
      setLoading(false);
    }
  }, [adminFetch, poolType]);

  // Reset auto-collapse policy when switching pool/version, then reload.
  useEffect(() => {
    collapsedTouchedRef.current = false;
    void load();
  }, [load, version, poolType]);

  const titleHint = useMemo(() => {
    if (poolType === "all") return "当前展示全部号池的导入任务";
    return "仅展示当前号池的导入任务";
  }, [poolType]);

  async function retryItem(jobId: string, itemIndex: number) {
    setRetrying({ jobId, itemIndex });
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/import-jobs/${encodeURIComponent(jobId)}/retry`, {
        method: "POST",
        body: JSON.stringify({ itemIndex }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "重试失败");
      if (payload?.job) {
        setJobs((current) => current.map((job) => job.id === jobId ? payload.job as ImportJob : job));
      }
      await load();
      onAccountsChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "重试失败");
    } finally {
      setRetrying(null);
    }
  }

  async function rollbackJob(job: ImportJob) {
    const count = job.rollbackAccountCount ?? 0;
    const approved = await confirm({ title: "撤销这次导入任务？", description: `将永久删除该任务新建的 ${count} 个账号，此操作无法恢复。`, confirmText: "撤销并删除账号", destructive: true });
    if (!approved) return;
    setRollingBackJobId(job.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch(`/api/admin/import-jobs/${encodeURIComponent(job.id)}/rollback`, { method: "POST" });
      const payload = await response.json().catch(() => null) as {
        job?: ImportJob;
        deleted?: number;
        skippedReused?: number;
        missing?: number;
        error?: { message?: string };
        message?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "撤销导入失败");
      const suffix = payload?.skippedReused ? `，另有 ${payload.skippedReused} 个账号因被后续任务复用而保留` : "";
      setActionNotice(`已撤销导入，删除 ${payload?.deleted ?? 0} 个账号${suffix}。`);
      if (payload?.job) setJobs((current) => current.map((item) => item.id === job.id ? payload.job! : item));
      await load();
      onAccountsChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "撤销导入失败");
    } finally {
      setRollingBackJobId(null);
    }
  }

  async function changeJobState(job: ImportJob, action: "pause" | "resume") {
    setChangingStateJobId(job.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await adminFetch(`/api/admin/import-jobs/${encodeURIComponent(job.id)}/${action}`, { method: "POST" });
      const payload = await response.json().catch(() => null) as { job?: ImportJob; error?: { message?: string }; message?: string } | null;
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || (action === "pause" ? "暂停任务失败" : "继续任务失败"));
      if (payload?.job) setJobs((current) => current.map((item) => item.id === job.id ? payload.job! : item));
      setActionNotice(action === "pause" ? "任务已暂停；正在处理的账号完成后将停止领取新账号。" : "任务已继续执行。");
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : (action === "pause" ? "暂停任务失败" : "继续任务失败"));
    } finally {
      setChangingStateJobId(null);
    }
  }

  if (!loading && !jobs.length) return null;

  return (
    <section className="mb-4 rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">后台导入任务</h2>
            <span className="rounded-md border bg-[#fafafa] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {jobs.length} 个任务
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            关闭页面不会中断。{titleHint}。失败项可展开后单独重试。
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => {
            collapsedTouchedRef.current = true;
            setCollapsed((value) => !value);
          }}>
            {collapsed ? <ChevronRight /> : <ChevronDown />}
            {collapsed ? "展开" : "折叠"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setLoading(true); void load(); }}>
            {loading ? <LoaderCircle className="animate-spin" /> : <Clock3 />}刷新
          </Button>
        </div>
      </div>

      {!collapsed ? (
        <div className="max-h-[28rem] space-y-3 overflow-y-auto p-4">
          {actionError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
              {actionError}
            </div>
          ) : null}
          {actionNotice ? (
            <div className="rounded-md border border-success/20 bg-success-soft px-3 py-2 text-xs text-success" role="status">
              {actionNotice}
            </div>
          ) : null}
          {loading && !jobs.length ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />正在读取任务
            </div>
          ) : null}
          {jobs.map((job) => (
            <LiveJob
              key={job.id}
              initial={job}
              onCompleted={() => { onAccountsChanged(); void load(); }}
              onRetryItem={retryItem}
              retryingIndex={retrying}
              onRollback={rollbackJob}
              rollingBack={rollingBackJobId === job.id}
              onPause={(item) => void changeJobState(item, "pause")}
              onResume={(item) => void changeJobState(item, "resume")}
              changingState={changingStateJobId === job.id}
              poolTypeLabels={poolTypeLabels}
            />
          ))}
        </div>
      ) : (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          已折叠。运行中 {jobs.filter((job) => job.status === "RUNNING" || job.status === "QUEUED").length} ·
          已暂停 {jobs.filter((job) => job.status === "PAUSED").length} ·
          失败 {jobs.filter((job) => job.failedItems > 0 || job.status === "FAILED").length}
        </div>
      )}
    </section>
  );
}
