"use client"

import { useState } from "react"
import { ChevronRight, Copy, RotateCcw, Sparkles } from "lucide-react"
import { MessageResponse } from "@/components/ai-elements/message"
import { cn, copyToClipboard } from "@/lib/utils"
import type { ChatToolCall } from "@/lib/chat-stream-mapper"
import { ToolCard, ToolGroup } from "./tool-calls"

export type ChatMessageStatus = "complete" | "streaming" | "error"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  status: ChatMessageStatus
  error?: string
  model?: string
  routeLabel?: string
  reasoningLabel?: string
  interfaceLabel?: string
  toolCalls?: ChatToolCall[]
}

export function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%] rounded-[22px_22px_6px_22px] bg-[var(--chat-bubble-bg)] px-[15px] py-[9px] text-[14.5px] leading-[1.62] text-[var(--chat-label-primary)]">
        <p className="whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  )
}

export function ReasoningBlock({ text, streaming, label }: { text?: string; streaming: boolean; label?: string }) {
  const [open, setOpen] = useState(false)
  const teaser = text ? text.replace(/\s+/g, " ").slice(0, 48) : ""
  return (
    <div className="mb-3.5 mt-0.5 overflow-hidden rounded-[var(--chat-r-12)] border border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-[7px] text-left hover:bg-[var(--chat-bg-layer-2)]">
        <Sparkles className="size-3.5 text-[var(--chat-label-tertiary)]" />
        <span className="flex items-center gap-[7px] text-[12.5px] font-semibold text-[var(--chat-label-secondary)]">
          {streaming ? "正在思考" : "已思考"}
          {label ? <span className="rounded border border-[var(--chat-border-l1)] bg-white px-[5px] font-mono text-[10.5px] font-medium leading-4 text-[var(--chat-label-tertiary)]">{label}</span> : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--chat-label-tertiary)]">{teaser}</span>
        <ChevronRight className="size-3.5 text-[var(--chat-label-caption)] transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="border-t border-[var(--chat-border-l1)] px-3 pb-3 text-[12.5px] leading-[1.7] text-[var(--chat-label-secondary)]">
            <p className="mt-2 whitespace-pre-wrap">{text ?? (streaming ? "思考中…" : "（无思考内容）")}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AssistantMessage({
  message,
  canRegenerate,
  onRegenerate,
  onDiscard,
}: {
  message: ChatMessage
  canRegenerate?: boolean
  onRegenerate?: () => void
  onDiscard?: () => void
}) {
  const streaming = message.status === "streaming"
  const toolCalls = message.toolCalls ?? []
  return (
    <div className="group">
      {message.reasoning || streaming ? (
        <ReasoningBlock text={message.reasoning} streaming={streaming} label={message.reasoningLabel} />
      ) : null}
      {message.content ? (
        <div className="chat-markdown">
          <MessageResponse isAnimating={streaming}>{message.content}</MessageResponse>
          {streaming ? <span className="chat-caret" aria-hidden="true" /> : null}
        </div>
      ) : null}
      {toolCalls.length > 1 ? (
        <ToolGroup calls={toolCalls} />
      ) : toolCalls.length === 1 ? (
        <ToolCard call={toolCalls[0]} />
      ) : null}
      {message.status === "error" && message.error ? (
        <div className="mt-3.5 rounded-[var(--chat-r-12)] border border-[var(--chat-error-border)] bg-[var(--chat-error-soft)] px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--chat-error)]" />
            <span className="text-[13px] font-semibold text-[var(--chat-error)]">连接中断，响应不完整</span>
            <span className="ml-auto rounded border border-[var(--chat-error-border)] bg-white px-[5px] font-mono text-[11px] text-[var(--chat-label-tertiary)]">ERR_STREAM_ABORT</span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-[1.6] text-[var(--chat-label-secondary)]">{message.error}</p>
          <div className="mt-2.5 flex gap-2">
            {onRegenerate ? (
              <button type="button" onClick={onRegenerate} className="flex h-[30px] items-center gap-1.5 rounded-lg bg-[var(--chat-accent)] px-3 text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--chat-accent-hover)]">
                <RotateCcw className="size-[13px]" />重试
              </button>
            ) : null}
            {onDiscard ? (
              <button type="button" onClick={onDiscard} className="flex h-[30px] items-center gap-1.5 rounded-lg border border-[var(--chat-border-l1)] bg-white px-3 text-[12.5px] font-semibold text-[var(--chat-label-secondary)] transition-colors hover:bg-[var(--chat-bg-layer-2)]">丢弃并停止</button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mt-3.5 flex items-center gap-0.5 opacity-55 transition-opacity group-hover:opacity-100">
        {message.content ? (
          <button type="button" onClick={() => void copyToClipboard(message.content)} className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-layer-2)] hover:text-[var(--chat-label-primary)]">
            <Copy className="size-[13px]" />复制
          </button>
        ) : null}
        {canRegenerate && onRegenerate ? (
          <button type="button" onClick={onRegenerate} className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-layer-2)] hover:text-[var(--chat-label-primary)]">
            <RotateCcw className="size-[13px]" />重新生成
          </button>
        ) : null}
        {message.model ? <span className="ml-auto px-1 font-mono text-[11px] text-[var(--chat-label-tertiary)]">{message.model}</span> : null}
      </div>
    </div>
  )
}

