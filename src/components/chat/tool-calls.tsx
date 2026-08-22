"use client"

import { useState } from "react"
import { Check, ChevronRight, X } from "lucide-react"
import type { ChatToolCall, DiffHunk } from "@/lib/chat-stream-mapper"
import { parseToolArguments } from "@/lib/chat-stream-mapper"
import { ToolVariantIcon } from "./icons"

function formatDuration(startedAt?: number, completedAt?: number): string {
  if (!startedAt) return ""
  const end = completedAt ?? Date.now()
  const seconds = Math.max(0, (end - startedAt) / 1000)
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : "<1s"
}

function stateDot(state: ChatToolCall["state"]) {
  if (state === "ok") return <Check className="size-[14px] text-[var(--chat-success)]" strokeWidth={2.2} />
  if (state === "error") return <X className="size-[14px] text-[var(--chat-error)]" strokeWidth={2.2} />
  if (state === "stopped") return <span className="chat-state-dot warn" />
  return <span className="chat-spinner" />
}

/** 单个工具卡（ioCard IN/OUT 或 read/diff 专用排版） — §7.3：#FAFBFC + #E7EAEE + 8px + hairline双保险 */
export function ToolCard({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(true)
  const time = formatDuration(call.startedAt, call.completedAt)
  return (
    <div className="mt-4 overflow-hidden rounded-[8px] border border-[#E7EAEE] bg-[#FAFBFC] shadow-[var(--chat-shadow-xs)]">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-[30px] w-full items-center gap-2 px-[11px] py-1.5 text-left hover:bg-[#F3F5F8] transition-colors duration-[120ms]">
        <ToolVariantIcon variant={call.variant} className="size-[14px] shrink-0 text-[var(--chat-label-secondary)]" />
        <span className="font-mono text-[12.5px] font-semibold text-[var(--chat-label-primary)]">{call.name}</span>
        <span className="size-[3px] rounded-full bg-[var(--chat-border-l3)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--chat-label-tertiary)]">{call.summary}</span>
        {time ? <span className="font-mono text-[11px] text-[var(--chat-label-caption)]">{call.state === "running" ? "运行中" : time}</span> : null}
        {stateDot(call.state)}
        <ChevronRight className="size-[14px] shrink-0 text-[var(--chat-label-caption)] transition-transform" strokeWidth={1.5} style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="">
            {call.renderIntent === "diff" && call.diffHunks ? <DiffBody hunks={call.diffHunks} /> : null}
            {call.renderIntent === "read" && call.readLines ? <ReadBody lines={call.readLines} /> : null}
            {call.renderIntent === "io" ? <IoBody call={call} /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function IoBody({ call }: { call: ChatToolCall }) {
  const args = parseToolArguments(call.arguments)
  const entries = Object.entries(args)
  const hasArgs = entries.length > 0
  const output = call.output ?? ""
  const error = call.error
  return (
    <div>
      {hasArgs ? (
        <div className="grid grid-cols-[max-content_1fr] gap-3 border-t border-[#F0F2F5] bg-[#F3F5F8] px-3 py-2.5">
          <span className="font-mono text-[11px] font-semibold tracking-[.06em] text-[var(--chat-label-tertiary)]">IN</span>
          <div className="min-w-0 space-y-1.5">
            {entries.map(([key, value]) => (
              <div key={key} className="flex gap-2.5 font-mono text-xs leading-relaxed">
                <span className="shrink-0 text-[var(--chat-label-tertiary)]">{key}</span>
                <span className="min-w-0 break-all text-[var(--chat-label-primary)]">{stringify(value)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {output || error ? (
        <div className={"grid grid-cols-[max-content_1fr] gap-3 border-t bg-white px-3 py-2.5 " + (hasArgs ? "border-[#F0F2F5]" : "border-transparent")}>
          <span className={"font-mono text-[11px] font-semibold tracking-[.06em] " + (error ? "text-[var(--chat-error)]" : "text-[var(--chat-label-tertiary)]")}>{error ? "ERR" : "OUT"}</span>
          <div className="min-w-0">
            <pre className={"whitespace-pre-wrap break-all font-mono text-xs leading-relaxed " + (error ? "text-[var(--chat-error)]" : "text-[var(--chat-label-secondary)]")}>{error ?? output}</pre>
            {!error && output ? (
              <a href="#" onClick={(e) => { e.preventDefault(); const el = e.currentTarget.previousElementSibling as HTMLElement; if (el) { el.style.whiteSpace = el.style.whiteSpace === "pre-wrap" ? "pre" : "pre-wrap" } }} className="mt-[10px] inline-flex items-center gap-1 border-0 text-xs font-medium text-[var(--chat-accent)] hover:underline">
                查看完整内容 <ChevronRight className="size-3" />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {!hasArgs && !output && !error ? (
        <div className="px-3 py-2.5 font-mono text-xs text-[var(--chat-label-caption)]">无参数与输出</div>
      ) : null}
    </div>
  )
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function ReadBody({ lines }: { lines: string[] }) {
  const shown = lines.slice(0, 24)
  return (
    <div className="border-t border-[#F0F2F5] bg-white py-1.5 font-mono text-[13px] leading-[1.65]">
      {shown.map((line, index) => (
        <div key={index} className="flex w-full hover:bg-[#F3F5F8]">
          <span className="w-11 shrink-0 select-none border-r border-[#F0F2F5] pr-2.5 text-right text-[var(--chat-label-caption)]">{index + 1}</span>
          <span className="whitespace-pre px-4 text-[var(--chat-label-secondary)]">{stripGutter(line)}</span>
        </div>
      ))}
      {lines.length > shown.length ? (
        <div className="px-4 py-1 text-[var(--chat-label-caption)]">… 共 {lines.length} 行</div>
      ) : null}
    </div>
  )
}

function stripGutter(line: string): string {
  const match = /^\s*\d+\s*[|│:]\s?/.exec(line)
  return match ? line.slice(match[0].length) : line
}

function DiffBody({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="border-t border-[#F0F2F5] bg-white font-mono text-[13px] leading-[1.65]">
      {hunks.map((hunk, index) => (
        <div key={index}>
          <div className="border-b border-[#F0F2F5] bg-[#F3F5F8] px-4 py-1 text-[11px] text-[var(--chat-label-caption)]">{hunk.header}</div>
          {hunk.rows.map((row, rowIndex) => (
            <div key={rowIndex} className={`flex w-full ${row.type === "add" ? "bg-[var(--chat-success-soft)]" : row.type === "del" ? "bg-[var(--chat-error-soft)]" : ""}`}>
              <span className="w-11 shrink-0 select-none border-r border-[#F0F2F5] pr-2.5 text-right text-[var(--chat-label-caption)]">{row.newLine ?? row.oldLine ?? ""}</span>
              <span className={`w-[18px] shrink-0 text-center ${row.type === "add" ? "text-[var(--chat-success)]" : row.type === "del" ? "text-[var(--chat-error)]" : "text-[var(--chat-label-caption)]"}`}>{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
              <span className={`whitespace-pre px-4 ${row.type === "ctx" ? "text-[var(--chat-label-secondary)]" : "text-[var(--chat-label-primary)]"}`}>{row.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** ToolGroup 聚合卡：组头 + 堆叠工具行（四态） */
export function ToolGroup({ calls }: { calls: ChatToolCall[] }) {
  const [open, setOpen] = useState(true)
  const running = calls.filter((call) => call.state === "running").length
  const failed = calls.filter((call) => call.state === "error").length
  const ok = calls.filter((call) => call.state === "ok").length
  const statusParts: string[] = []
  if (running) statusParts.push(`${running} 个运行中`)
  if (failed) statusParts.push(`${failed} 个失败`)
  if (ok && !running && !failed) statusParts.push(`${ok} 个完成`)
  return (
    <div className="mt-4 overflow-hidden rounded-[8px] border border-[#E7EAEE] bg-[#FAFBFC] shadow-[var(--chat-shadow-xs)]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex h-10 w-full items-center gap-2.5 bg-[#FAFBFC] px-[11px] hover:bg-[#F3F5F8] transition-colors duration-[120ms]">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="size-4 shrink-0 text-[var(--chat-label-secondary)]"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        <span className="text-[13px] font-semibold text-[var(--chat-label-primary)]">{calls.length} 个工具调用</span>
        <span className="text-xs text-[var(--chat-label-tertiary)]">{running ? running + " 个运行中" : ok + " 个完成"}{failed ? " · " + failed + " 个失败" : ""}</span>
        {running ? <span className="size-[3px] rounded-full bg-[var(--chat-border-l3)]" /> : null}
        {running ? <span className="font-mono text-[11px] text-[var(--chat-label-caption)]">{running} 运行中</span> : null}
        <ChevronRight className="ml-auto size-[14px] text-[var(--chat-label-caption)] transition-transform" strokeWidth={1.5} style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="flex flex-col gap-px bg-[#F0F2F5]">
            {calls.map((call, index) => <ToolRow key={call.id} call={call} last={index === calls.length - 1} />)}
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolRow({ call, last }: { call: ChatToolCall; last: boolean }) {
  const [open, setOpen] = useState(false)
  const time = formatDuration(call.startedAt, call.completedAt)
  const isError = call.state === "error"
  const isRunning = call.state === "running"
  return (
    <div className="border-t border-[#F0F2F5] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        data-state={call.state}
        className={"chat-tool-row relative flex min-h-[38px] w-full items-center gap-2.5 overflow-hidden px-[11px] py-2 text-left transition-colors " + (isRunning ? "bg-[#F9F9F8] hover:bg-[#F9F9F8]" : "bg-[#FAFBFC] hover:bg-[#F3F5F8]")}
      >
        <ToolVariantIcon variant={call.variant} className="size-[14px] shrink-0 text-[var(--chat-label-secondary)]" />
        <span className="shrink-0 font-mono text-[12.5px] font-medium text-[var(--chat-label-primary)]">{call.name}</span>
        <span className="size-[3px] shrink-0 rounded-full bg-[var(--chat-border-l3)]" />
        {isError ? (
          <span className="inline-flex max-w-fit items-center gap-1.5 truncate rounded-full bg-[var(--chat-error-soft)] px-2 py-[2px] font-mono text-xs font-medium text-[var(--chat-error)]"><span className="size-[6px] shrink-0 rounded-full bg-[var(--chat-error)]" />{call.error ?? call.summary}</span>
        ) : isRunning ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--chat-label-tertiary)]">{call.summary}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--chat-label-tertiary)]">{call.summary}</span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--chat-label-caption)]">{call.state === "running" ? "· " + time : time}</span>
        {isRunning ? (
          <>
            <span className="chat-spinner" />
            <span className="size-[7px] shrink-0 rounded-full bg-[var(--chat-accent)] animate-[chat-pulse-dot_1.4s_ease-in-out_infinite]" />
          </>
        ) : stateDot(call.state)}
        <ChevronRight className="size-3 shrink-0 text-[var(--chat-label-caption)] transition-transform" strokeWidth={1.5} style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="bg-white">
            {call.renderIntent === "io" ? <IoBody call={call} /> : call.renderIntent === "read" && call.readLines ? <ReadBody lines={call.readLines} /> : call.renderIntent === "diff" && call.diffHunks ? <DiffBody hunks={call.diffHunks} /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}