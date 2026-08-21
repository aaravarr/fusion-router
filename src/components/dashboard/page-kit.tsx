import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
  showTitle = true,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
  showTitle?: boolean;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {showTitle ? (
          <>
            <p className="mb-2 font-mono text-[10px] font-medium tracking-[0.1em] text-muted-foreground">{eyebrow}</p>
            <h1 className="text-2xl font-semibold tracking-[-0.04em] sm:text-[28px]">{title}</h1>
          </>
        ) : null}
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`dashboard-surface overflow-hidden rounded-lg ${className}`}>
      {title || description || action ? (
        <header className="flex min-h-12 flex-wrap items-center gap-3 border-b bg-[#fafafa] px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-sm font-medium tracking-[-0.015em]">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function LoadingTable({ rows = 5, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-0" aria-label="正在加载">
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="grid min-h-12 items-center gap-4 border-b px-4 last:border-b-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(70px, 1fr))` }}>
          {Array.from({ length: columns }).map((__, column) => (
            <Skeleton key={column} className="h-3.5 w-full max-w-28 rounded-sm" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 grid size-9 place-items-center rounded-md border bg-[#fafafa]">
        <Inbox className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-6 py-12 text-center" role="alert">
      <div className="mb-4 grid size-9 place-items-center rounded-md border border-destructive/20 bg-destructive/5">
        <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-medium">无法载入数据</h3>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" />重试
        </Button>
      ) : null}
    </div>
  );
}

export function formatDate(value?: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(0, Math.ceil(seconds))} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)} 小时`;
  return `${Math.ceil(seconds / 86400)} 天`;
}

export function StatsStrip({
  items,
  className = "",
}: {
  items: Array<{ label: string; value: React.ReactNode; hint?: string; tone?: "default" | "success" | "warning" | "danger" }>
  className?: string
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  } as const
  return (
    <div className={`dashboard-surface grid overflow-hidden rounded-lg bg-white sm:grid-cols-2 xl:grid-cols-4 ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-b border-r border-border/70 px-4 py-3 last:border-b-0 sm:border-b xl:border-b-0">
          <p className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">{item.label}</p>
          <p className={`mt-1 text-xl font-semibold tracking-[-0.03em] ${toneClass[item.tone || "default"]}`}>{item.value}</p>
          {item.hint ? <p className="mt-1 text-[11px] text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </div>
  )
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
  loading = false,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: number[]
  loading?: boolean
}) {
  const totalPages = Math.max(1, Math.ceil(Math.max(total, 0) / Math.max(pageSize, 1)))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const end = total === 0 ? 0 : Math.min(total, currentPage * pageSize)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-[#fafafa] px-4 py-2.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-3">
        <span>显示 {start}-{end} / 共 {total}</span>
        {onPageSizeChange ? (
          <div className="inline-flex items-center gap-1.5">
            <span>每页</span>
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))} disabled={loading}>
              <SelectTrigger size="sm" className="w-[72px] bg-white text-xs"><SelectValue /></SelectTrigger>
              <SelectContent align="start">
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={currentPage <= 1 || loading} onClick={() => onPageChange(currentPage - 1)}>
          上一页
        </Button>
        <span className="px-2 font-mono text-[11px]">{currentPage} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={currentPage >= totalPages || loading} onClick={() => onPageChange(currentPage + 1)}>
          下一页
        </Button>
      </div>
    </div>
  )
}
