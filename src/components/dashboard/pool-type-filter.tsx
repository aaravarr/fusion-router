"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export type PoolFilterOption = {
  key: string
  label: string
  description?: string
}

export function PoolTypeFilterBar({
  value,
  onChange,
  options,
  counts,
  className,
}: {
  value: string
  onChange: (next: string) => void
  options: PoolFilterOption[]
  counts?: Record<string, number | undefined>
  className?: string
}) {
  const current = options.find((option) => option.key === value) ?? options[0]
  const selectedCount = counts?.[value]

  return (
    <div className={cn("min-w-0", className)}>
      {/* Mobile: select with original short Chinese copy */}
      <div className="sm:hidden">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">号池</span>
          {typeof selectedCount === "number" ? (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{selectedCount} 个账号</span>
          ) : null}
        </div>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-10 w-full rounded-lg border bg-white px-3 text-sm shadow-none">
            <SelectValue placeholder="选择号池">
              <span className="truncate">{current?.label ?? "选择号池"}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="start"
            className="w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)]"
          >
            {options.map((option) => {
              const count = counts?.[option.key]
              return (
                <SelectItem
                  key={option.key}
                  value={option.key}
                  className="items-start rounded-md py-2 pl-3 pr-9"
                >
                  <span className="flex min-w-0 flex-col gap-0.5 text-left">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium leading-5">{option.label}</span>
                      {typeof count === "number" ? (
                        <span className="shrink-0 font-mono text-[11px] leading-5 tabular-nums text-muted-foreground">
                          {count}
                        </span>
                      ) : null}
                    </span>
                    {option.description ? (
                      <span className="line-clamp-1 text-[11px] leading-4 text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>

      {/* sm+: scrollable chips, original short labels */}
      <div className="hidden min-w-0 sm:block">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">号池</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {current?.label}
            {typeof selectedCount === "number" ? ` · ${selectedCount}` : ""}
          </span>
        </div>
        <div className="relative min-w-0">
          <div
            role="tablist"
            aria-label="号池筛选"
            className="flex max-w-full gap-1.5 overflow-x-auto overscroll-x-contain scroll-smooth pb-0.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            {options.map((option) => {
              const active = value === option.key
              const count = counts?.[option.key]
              return (
                <button
                  key={option.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={option.description || option.label}
                  onClick={() => onChange(option.key)}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-white text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                  )}
                >
                  <span>{option.label}</span>
                  {typeof count === "number" ? (
                    <span
                      className={cn(
                        "font-mono text-[10px] tabular-nums",
                        active ? "text-background/75" : "text-muted-foreground",
                      )}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent"
          />
        </div>
      </div>
    </div>
  )
}