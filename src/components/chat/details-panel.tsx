"use client"

import { X } from "lucide-react"
import type { ChatToolCall } from "@/lib/chat-stream-mapper"
import { ToolVariantIcon } from "./icons"

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

function formatTokens(value?: number): string {
  if (value === undefined || value === null) return "—"
  if (value >= 1000) return (value / 1000).toFixed(1) + "k"
  return String(value)
}

function formatDuration(startedAt?: number, completedAt?: number): string {
  if (!startedAt) return ""
  const end = completedAt ?? Date.now()
  const seconds = Math.max(0, (end - startedAt) / 1000)
  return seconds >= 1 ? seconds.toFixed(1) + "s" : "<1s"
}

function PanelInner({
  onClose,
  toolCalls,
  usage,
}: {
  onClose: () => void
  toolCalls: ChatToolCall[]
  usage?: UsageInfo | null
}) {
  const ok = toolCalls.filter((call) => call.state === "ok").length
  const running = toolCalls.filter((call) => call.state === "running").length
  const failed = toolCalls.filter((call) => call.state === "error").length
  const total = toolCalls.length
  const totalTokens = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  const hasUsage = totalTokens > 0
  return (
    <>
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#E9EDF3] bg-[var(--chat-bg-detail)] px-4 max-md:h-14">
        <span className="text-[13px] font-semibold tracking-[-.01em] text-[var(--chat-label-primary)]">运行详情</span>
        <button type="button" onClick={onClose} aria-label="关闭" className="flex size-11 items-center justify-center rounded-xl text-[var(--chat-label-tertiary)] hover:bg-white hover:text-[var(--chat-label-primary)] md:size-[26px] md:rounded-lg"><X className="size-5 md:size-4" strokeWidth={1.5} /></button>
      </div>
      <div className="flex gap-1 px-3 pb-3 pt-3 bg-[var(--chat-bg-detail)]">
        <button type="button" className="flex-1 h-7 rounded-[8px] border border-[#E7EAEE] bg-[var(--chat-bg-card)] text-xs font-semibold text-[var(--chat-label-primary)] shadow-[var(--chat-shadow-xs)]">工具</button>
        <button type="button" className="flex-1 h-7 rounded-[8px] border border-transparent text-xs font-medium text-[var(--chat-label-secondary)] hover:bg-white/60 hover:border-[#E7EAEE]">上下文</button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[var(--chat-bg-detail)] p-[14px] pt-3">
        <section className="rounded-[8px] border border-[#E7EAEE] bg-[var(--chat-bg-card)] p-[14px] shadow-[var(--chat-shadow-xs)]">
          <div className="mb-2 text-[12px] font-semibold tracking-[-.01em] text-[var(--chat-label-primary)]">工具调用</div>
          {total ? (
            <>
              <div className="grid grid-cols-4 gap-1.5">
                <StatBlock num={String(total)} label="调用" />
                <StatBlock num={String(ok)} label="成功" tone="ok" />
                <StatBlock num={String(running)} label="运行中" tone="run" />
                <StatBlock num={String(failed)} label="失败" tone="err" />
              </div>
              <ul className="mt-3 flex flex-col">
                {toolCalls.map((call) => (
                  <li key={call.id} className="flex items-center gap-2 rounded-lg px-2 py-[7px] hover:bg-[var(--chat-bg-subtle)]">
                    <ToolVariantIcon variant={call.variant} className="size-[14px] text-[var(--chat-label-secondary)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--chat-label-primary)]">{call.name}</span>
                    <span className="font-mono text-[11px] text-[var(--chat-label-caption)]">{call.state === "running" ? "运行中" : formatDuration(call.startedAt, call.completedAt)}</span>
                    <StateIcon state={call.state} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#E7EAEE] bg-[var(--chat-bg-subtle)] px-4 py-8 text-center">
              <span className="grid size-8 place-items-center rounded-full bg-white text-[var(--chat-label-tertiary)] shadow-[var(--chat-shadow-xs)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              </span>
              <p className="text-xs font-medium text-[var(--chat-label-secondary)]">本轮暂无工具调用</p>
              <p className="text-[11px] leading-[1.5] text-[var(--chat-label-tertiary)]">运行一轮后展示工具调用与上下文</p>
            </div>
          )}
        </section>

        <section className="rounded-[8px] border border-[#E7EAEE] bg-[var(--chat-bg-card)] p-[14px] shadow-[var(--chat-shadow-xs)]">
          <div className="mb-2 text-[12px] font-semibold tracking-[-.01em] text-[var(--chat-label-primary)]">上下文</div>
          {hasUsage ? (
            <>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xl font-bold tracking-[-.02em]">{formatTokens(totalTokens)}<span className="ml-1 text-xs font-medium text-[var(--chat-label-tertiary)]">tokens</span></span>
                <span className="font-mono text-[11.5px] text-[var(--chat-label-tertiary)]">输入 {formatTokens(usage?.inputTokens)} · 输出 {formatTokens(usage?.outputTokens)}</span>
              </div>
              <div className="flex h-1.5 overflow-hidden rounded-full bg-[#F1F5F9]">
                <span className="h-full bg-[#BFDBFE]" style={{ width: usage?.totalTokens ? Math.min(100, (totalTokens / Math.max(4096, totalTokens)) * 100) + "%" : "0%" }} />
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs text-[var(--chat-label-secondary)]"><span className="size-[9px] rounded-[2.5px] bg-[#BFDBFE]" />总量<span className="ml-auto font-mono text-[11.5px] text-[var(--chat-label-tertiary)]">{formatTokens(totalTokens)}</span></div>
                <div className="flex items-center gap-2 text-xs text-[var(--chat-label-tertiary)]">输入 {formatTokens(usage?.inputTokens)} · 输出 {formatTokens(usage?.outputTokens)}</div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#E7EAEE] bg-[var(--chat-bg-subtle)] px-4 py-8 text-center">
              <span className="grid size-8 place-items-center rounded-full bg-white text-[var(--chat-label-tertiary)] shadow-[var(--chat-shadow-xs)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>
              </span>
              <p className="text-xs font-medium text-[var(--chat-label-secondary)]">暂无上下文数据</p>
              <p className="text-[11px] leading-[1.5] text-[var(--chat-label-tertiary)]">完成一轮生成后显示 token 用量分解</p>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

export function DetailsPanel({
  open,
  onClose,
  toolCalls,
  usage,
}: {
  open: boolean
  onClose: () => void
  toolCalls: ChatToolCall[]
  usage?: UsageInfo | null
}) {
  if (!open) return null
  return (
    <>
      {/* Desktop side panel — hairline左分隔，底色区分 */}
      <aside className="hidden min-h-0 w-[340px] shrink-0 flex-col border-l border-[#E9EDF3] bg-[var(--chat-bg-detail)] md:flex">
        <PanelInner onClose={onClose} toolCalls={toolCalls} usage={usage} />
      </aside>
      {/* Mobile drawer/overlay from right */}
      <div className="fixed inset-0 z-40 flex justify-end md:hidden" role="dialog" aria-modal="true" aria-label="运行详情">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
        <aside className="relative flex w-[88vw] max-w-[360px] flex-col bg-[var(--chat-bg-detail)] shadow-xl">
          <PanelInner onClose={onClose} toolCalls={toolCalls} usage={usage} />
        </aside>
      </div>
    </>
  )
}

function StatBlock({ num, label, tone }: { num: string; label: string; tone?: "ok" | "run" | "err" }) {
  const isActive = num !== "0"
  const color =
    tone === "err"
      ? isActive
        ? "text-[var(--chat-error)]"
        : "text-[var(--chat-label-primary)]"
      : tone === "run"
        ? isActive
          ? "text-[var(--chat-accent)]"
          : "text-[var(--chat-label-primary)]"
        : "text-[var(--chat-label-primary)]"
  return (
    <div className="rounded-lg border border-[#E7EAEE] bg-[var(--chat-bg-subtle)] px-[9px] py-1.5">
      <div className={"font-mono text-sm font-bold tracking-[-.01em] " + color}>{num}</div>
      <div className="mt-0.5 text-[10.5px] text-[var(--chat-label-tertiary)]">{label}</div>
    </div>
  )
}

function StateIcon({ state }: { state: ChatToolCall["state"] }) {
  if (state === "ok") return <span className="size-[7px] shrink-0 rounded-full bg-[var(--chat-success)]" />
  if (state === "error") return <span className="size-[7px] shrink-0 rounded-full bg-[var(--chat-error)]" />
  if (state === "stopped") return <span className="size-[7px] shrink-0 rounded-full bg-[var(--chat-warn)]" />
  return <span className="size-[7px] shrink-0 rounded-full bg-[var(--chat-accent)] animate-[chat-pulse-dot_1.4s_ease-in-out_infinite]" />
}