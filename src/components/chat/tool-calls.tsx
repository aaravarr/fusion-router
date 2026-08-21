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
  if (state === "ok") return <Check className="size-3.5 text-[var(--chat-success)]" strokeWidth={2.4} />
  if (state === "error") return <X className="size-3.5 text-[var(--chat-error)]" strokeWidth={2.4} />
  if (state === "stopped") return <span className="chat-state-dot warn" />
  return <span className="chat-spinner" />
}

/** 单个工具卡（ioCard IN/OUT 或 read/diff 专用排版） */
export function ToolCard({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(true)
  const time = formatDuration(call.startedAt, call.completedAt)
  return (
    <div className="mt-3.5 overflow-hidden rounded-[var(--chat-r-12)] border border-[var(--chat-border-l1)] bg-white">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full min-h-9 items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--chat-bg-layer-1)]">
        <ToolVariantIcon variant={call.variant} className="size-3.5 shrink-0 text-[var(--chat-label-secondary)]" />
        <span className="font-mono text-[12.5px] font-semibold text-[var(--chat-label-primary)]">{call.name}</span>
        <span className="size-[3px] rounded-full bg-[var(--chat-border-l3)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--chat-label-tertiary)]">{call.summary}</span>
        {time ? <span className="font-mono text-[11px] text-[var(--chat-label-caption)]">{call.state === "running" ? "运行中" : time}</span> : null}
        {stateDot(call.state)}
        <ChevronRight className="size-3.5 text-[var(--chat-label-caption)] transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="border-t border-[var(--chat-border-l1)]">
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
        <div className="grid grid-cols-[max-content_1fr] gap-3 bg-[#F8FAFC] px-3 py-2.5">
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
        <div className={`grid grid-cols-[max-content_1fr] gap-3 bg-white px-3 py-2.5 ${error ? "" : (hasArgs ? "border-t border-[var(--chat-border-l1)]" : "")}`}>
          <span className={`font-mono text-[11px] font-semibold tracking-[.06em] ${error ? "text-[var(--chat-error)]" : "text-[var(--chat-label-tertiary)]"}`}>{error ? "ERR" : "OUT"}</span>
          <pre className={`min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed ${error ? "text-[var(--chat-error)]" : "text-[var(--chat-label-secondary)]"}`}>{error ?? output}</pre>
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
    <div className="py-1.5 font-mono text-xs leading-[1.65]">
      {shown.map((line, index) => (
        <div key={index} className="flex w-full hover:bg-[var(--chat-bg-layer-1)]">
          <span className="w-11 shrink-0 select-none border-r border-[var(--chat-border-l1)] pr-2.5 text-right text-[var(--chat-label-caption)]">{index + 1}</span>
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
    <div className="font-mono text-xs leading-[1.65]">
      {hunks.map((hunk, index) => (
        <div key={index}>
          <div className="border-b border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)] px-4 py-1 text-[11px] text-[var(--chat-label-caption)]">{hunk.header}</div>
          {hunk.rows.map((row, rowIndex) => (
            <div key={rowIndex} className={`flex w-full ${row.type === "add" ? "bg-[var(--chat-success-soft)]" : row.type === "del" ? "bg-[var(--chat-error-soft)]" : ""}`}>
              <span className="w-11 shrink-0 select-none border-r border-[var(--chat-border-l1)] pr-2.5 text-right text-[var(--chat-label-caption)]">{row.newLine ?? row.oldLine ?? ""}</span>
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
    <div className="mt-3.5 overflow-hidden rounded-[var(--chat-r-12)] border border-[var(--chat-border-l1)] bg-white">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full h-9 items-center gap-2 bg-[var(--chat-bg-layer-1)] px-3 hover:bg-[var(--chat-bg-layer-2)]">
        <ToolVariantIcon variant="other" className="size-3.5 text-[var(--chat-label-secondary)]" />
        <span className="text-[12.5px] font-semibold text-[var(--chat-label-primary)]">{calls.length} 个工具</span>
        {running ? <><span className="chat-state-dot running" /><span className="text-[11.5px] text-[var(--chat-label-tertiary)]">{running} 个运行中</span></> : null}
        {failed ? <><span className="size-[3px] rounded-full bg-[var(--chat-border-l3)]" /><span className="chat-state-dot error" /><span className="text-[11.5px] text-[var(--chat-label-tertiary)]">{failed} 个失败</span></> : null}
        <ChevronRight className="ml-auto size-3.5 text-[var(--chat-label-caption)] transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="border-t border-[var(--chat-border-l1)]">
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
  return (
    <div className={last ? "" : "border-b border-[var(--chat-border-l1)]"}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        data-state={call.state}
        className="chat-tool-row relative flex min-h-8 w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left transition-colors hover:bg-[var(--chat-bg-layer-1)]"
      >
        <ToolVariantIcon variant={call.variant} className="size-3.5 shrink-0 text-[var(--chat-label-secondary)]" />
        <span className="shrink-0 font-mono text-[12.5px] font-medium text-[var(--chat-label-primary)]">{call.name}</span>
        <span className="size-[3px] shrink-0 rounded-full bg-[var(--chat-border-l3)]" />
        <span className={`min-w-0 flex-1 truncate font-mono text-xs ${call.state === "error" ? "text-[var(--chat-error)]" : "text-[var(--chat-label-tertiary)]"}`}>{call.error ?? call.summary}</span>
        <span className="shrink-0 font-mono text-[11px] text-[var(--chat-label-caption)]">{call.state === "running" ? "运行中" : time}</span>
        {stateDot(call.state)}
        <ChevronRight className="size-3.5 shrink-0 text-[var(--chat-label-caption)] transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="border-t border-[var(--chat-border-l1)]">
            {call.renderIntent === "io" ? <IoBody call={call} /> : call.renderIntent === "read" && call.readLines ? <ReadBody lines={call.readLines} /> : call.renderIntent === "diff" && call.diffHunks ? <DiffBody hunks={call.diffHunks} /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

