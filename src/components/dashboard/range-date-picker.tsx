"use client";

import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/** 本地日期 yyyy-mm-dd 转字符串：直接用本地年月日拼，避免 new Date("yyyy-mm-dd") 的 UTC 零点语义。 */
function toDateString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 解析 yyyy-mm-dd 为本地时区日期（零点）。 */
function parseDateString(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function todayString(): string {
  return toDateString(new Date());
}

function addDays(value: string, delta: number): string {
  const date = parseDateString(value);
  date.setDate(date.getDate() + delta);
  return toDateString(date);
}

interface RangeDatePickerProps {
  /** 已选范围开始（yyyy-mm-dd）；null 表示未选。 */
  startDate: string | null;
  /** 已选范围结束（yyyy-mm-dd）；null 表示未选。 */
  endDate: string | null;
  /** 范围变化回调：start/end 同时为 null 表示清除。 */
  onChange: (range: { start: string | null; end: string | null }) => void;
  /** 激活态高亮（与预设按钮组互斥时由调用方控制）。 */
  highlighted?: boolean;
}

export function RangeDatePicker({ startDate, endDate, onChange, highlighted = false }: RangeDatePickerProps) {
  const [open, setOpen] = useState(false);
  // 等待结束日期：非 null 表示已点过开始、正在等第二次点击。
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  // 当前展示的月份（始终为该月 1 日）。
  const [view, setView] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const today = todayString();
  // 92 天前的日期（后端自定义范围上限），日历不允许早于它。
  const minDate = addDays(today, -92);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    setPendingStart(null);
    if (next) {
      // 打开时把日历跳到当前范围（或今天）所在的月份。
      const anchor = startDate || today;
      const date = parseDateString(anchor);
      setView(new Date(date.getFullYear(), date.getMonth(), 1));
    }
  }

  const viewYear = view.getFullYear();
  const viewMonth = view.getMonth();
  const minMonthStart = parseDateString(minDate);
  const now = new Date();
  // 上月可回到 92 天前所在月；下月不可越过今天所在月。
  const canGoPrev =
    viewYear > minMonthStart.getFullYear() ||
    (viewYear === minMonthStart.getFullYear() && viewMonth > minMonthStart.getMonth());
  const canGoNext = viewYear < now.getFullYear() || (viewYear === now.getFullYear() && viewMonth < now.getMonth());

  function goPrevMonth() {
    if (canGoPrev) setView(new Date(viewYear, viewMonth - 1, 1));
  }
  function goNextMonth() {
    if (canGoNext) setView(new Date(viewYear, viewMonth + 1, 1));
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  function pickDay(dateString: string) {
    if (pendingStart) {
      if (dateString < pendingStart) {
        // 第二次点击早于开始：把当前日期作为新的开始，继续等待第二次点击。
        setPendingStart(dateString);
        return;
      }
      // 第二次点击：确定 end，立即生效并关闭。
      onChange({ start: pendingStart, end: dateString });
      setPendingStart(null);
      setOpen(false);
      return;
    }
    // 第一次点击：设置开始，进入等待态。
    setPendingStart(dateString);
  }

  function applyQuick(start: string, end: string) {
    onChange({ start, end });
    setPendingStart(null);
    setOpen(false);
  }

  function clearRange() {
    onChange({ start: null, end: null });
    setPendingStart(null);
    setOpen(false);
  }

  const triggerLabel = startDate
    ? endDate
      ? `${startDate} ~ ${endDate}`
      : `${startDate} ~ 选择结束`
    : "选择时间范围";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-label="选择时间范围"
          className={cn(
            "gap-1.5 font-normal",
            highlighted && "border-primary bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
          )}
        >
          <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="max-w-56 truncate">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-auto p-0">
        <div className="w-[272px] p-3 text-xs text-foreground">
          {/* 月份导航 */}
          <div className="mb-2 flex items-center justify-between">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="上个月" disabled={!canGoPrev} onClick={goPrevMonth}>
              <ChevronLeft />
            </Button>
            <span className="text-sm font-medium tabular">
              {viewYear} 年 {viewMonth + 1} 月
            </span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="下个月" disabled={!canGoNext} onClick={goNextMonth}>
              <ChevronRight />
            </Button>
          </div>
          {/* 星期表头 + 日期网格（7 列） */}
          <div className="grid grid-cols-7">
            {WEEKDAY_LABELS.map((label, index) => (
              <span
                key={label}
                className={cn(
                  "py-1 text-center text-muted-foreground",
                  index === 0 || index === 6 ? "text-destructive/70" : "",
                )}
              >
                {label}
              </span>
            ))}
            {cells.map((day, index) => {
              if (day === null) return <span key={`blank-${index}`} aria-hidden="true" />;
              const dateString = toDateString(new Date(viewYear, viewMonth, day));
              const disabled = dateString > today || dateString < minDate;
              const isToday = dateString === today;
              const inRange = Boolean(
                startDate && endDate && dateString >= startDate && dateString <= endDate,
              );
              // 等待结束态：pendingStart、已选 start/end 边界统一实底。
              const isBoundary = dateString === pendingStart || dateString === startDate || dateString === endDate;
              return (
                <button
                  key={dateString}
                  type="button"
                  disabled={disabled}
                  aria-label={dateString}
                  onClick={() => pickDay(dateString)}
                  className={cn(
                    "mx-auto grid size-8 place-items-center rounded-md tabular transition-colors",
                    disabled
                      ? "cursor-not-allowed text-muted-foreground/35"
                      : "hover:bg-muted hover:text-foreground",
                    isToday && !isBoundary && "ring-1 ring-inset ring-primary/40",
                    inRange && !isBoundary && "bg-primary/10",
                    isBoundary && "bg-primary font-medium text-primary-foreground",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
          {/* 等待提示 + 快捷项 + 清除 */}
          <div className="mt-2 border-t pt-2">
            {pendingStart ? (
              <p className="mb-2 text-xs text-muted-foreground">再点一次选择结束日期（开始：{pendingStart}）</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button type="button" variant="outline" size="xs" onClick={() => applyQuick(today, today)}>
                今天
              </Button>
              <Button type="button" variant="outline" size="xs" onClick={() => applyQuick(addDays(today, -6), today)}>
                最近 7 天
              </Button>
              <Button type="button" variant="outline" size="xs" onClick={() => applyQuick(addDays(today, -29), today)}>
                最近 30 天
              </Button>
              <Button type="button" variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={clearRange}>
                <X data-icon="inline-start" />清除
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
