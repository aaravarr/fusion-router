"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, PaginationBar, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { PoolTypeBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { EventRecord } from "./types";

interface EventsPayload { items?: EventRecord[]; total?: number; page?: number; pageSize?: number; poolTypes?: Array<{ type: string; label: string }> }

const levelStatus: Record<string, string> = {
  INFO: "active",
  WARN: "blocked",
  ERROR: "failed",
};

function poolTypeOf(event: EventRecord): string | null {
  const meta = event.metadata as Record<string, unknown> | null | undefined;
  if (!meta) return null;
  const value = meta.poolType ?? meta.pool_type;
  return typeof value === "string" ? value : null;
}

export function EventsPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const path = useMemo(() => `/api/admin/events?page=${page}&pageSize=${pageSize}`, [page, pageSize]);
  const resource = useAdminResource<EventsPayload>(path);
  const events = resource.data?.items ?? [];
  const total = resource.data?.total ?? events.length;
  const poolLabels = useMemo(
    () => Object.fromEntries((resource.data?.poolTypes ?? []).map((item) => [item.type, item.label])),
    [resource.data?.poolTypes],
  );

  return (
    <>
      <PageIntro
        eyebrow="ACCOUNT EVENTS"
        title="账户事件"
        description="聚合各 Provider 的同步、凭据、订阅、额度阻塞和自动恢复记录。"
        actions={<Button variant="outline" size="sm" onClick={() => void resource.refresh()}><RefreshCw data-icon="inline-start" />刷新</Button>}
      />
      <Panel title="最近事件" description={`共 ${total} 条事件，来自本地状态变化，不会额外调用上游接口。`}>
        {resource.loading ? (
          <LoadingTable rows={7} columns={4} />
        ) : resource.error ? (
          <ErrorState message={resource.error} onRetry={() => void resource.refresh()} />
        ) : !events.length ? (
          <EmptyState title="暂无账户事件" description="账号连接或状态变化后，事件会按时间倒序显示。" />
        ) : (
          <>
            <div className="divide-y">
              {events.map((event) => (
                <article key={event.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[130px_140px_minmax(0,1fr)_auto] sm:items-center sm:px-5">
                  <time className="font-mono text-[11px] text-muted-foreground">{formatDate(event.createdAt)}</time>
                  <span className="inline-flex items-center gap-1.5 truncate font-mono text-[11px]">
                    {event.accountName || event.accountId || "SYSTEM"}
                    {(() => { const pt = poolTypeOf(event); return pt ? <PoolTypeBadge poolType={pt} label={poolLabels[pt]} /> : null; })()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{event.message || event.type || "系统事件"}</p>
                    {event.detail ? <p className="mt-0.5 truncate text-xs text-muted-foreground" title={event.detail}>{event.detail}</p> : null}
                  </div>
                  <StatusBadge status={levelStatus[event.level || ""] || event.level || event.type || "unknown"} />
                </article>
              ))}
            </div>
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={total}
              loading={resource.loading}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
              pageSizeOptions={[20, 50, 100]}
            />
          </>
        )}
      </Panel>
    </>
  );
}
