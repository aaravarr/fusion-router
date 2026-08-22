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
      <div className="max-w-[78%] rounded-[16px_16px_6px_16px] border border-[#CFE6FF] bg-[#E8F3FF] px-[15px] py-[11px] text-[15px] leading-[1.5] font-medium text-[var(--chat-label-primary)] shadow-[var(--chat-shadow-xs)]">
        <p className="whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  )
}

export function ReasoningBlock({ text, streaming, label }: { text?: string; streaming: boolean; label?: string }) {
  const [open, setOpen] = useState(false)
  const teaser = text ? text.replace(/\s+/g, " ").slice(0, 64) : ""
  return (
    <div className="mb-4 mt-0.5 overflow-hidden rounded-[8px] border border-[#E7EAEE] bg-[#FAFBFC] shadow-[var(--chat-shadow-xs)]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-[11px] py-[10px] text-left hover:bg-[#F3F5F8] transition-colors duration-[120ms]">
        <Sparkles className="size-4 shrink-0 text-[var(--chat-label-tertiary)]" strokeWidth={1.5} />
        <span className="inline-flex items-center rounded-[6px] bg-[var(--chat-bg-subtle)] px-2 py-0.5 font-mono text-[10px] font-medium leading-none text-[var(--chat-label-tertiary)]">{label || (streaming ? "思考中" : "已思考")}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--chat-label-tertiary)]">{teaser}</span>
        <ChevronRight className="size-[14px] shrink-0 text-[var(--chat-label-caption)] transition-transform" strokeWidth={1.5} style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      <div className="chat-disclose" data-open={open}>
        <div className="chat-disclose-inner">
          <div className="border-t border-[#E7EAEE] bg-[#F3F5F8] px-[14px] pb-[14px] pt-3 text-[13px] leading-[1.65] text-[var(--chat-label-secondary)]">
            <p className="whitespace-pre-wrap">{text ?? (streaming ? "思考中…" : "（无思考内容）")}</p>
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
        <div className="mt-4 flex items-start gap-2.5 rounded-[8px] border border-[#E7EAEE] bg-[#FAFBFC] px-4 py-[14px] shadow-[var(--chat-shadow-xs)] md:bg-white md:border-[#E7EAEE] md:border-l-[3px] md:border-l-[#FECACA] md:shadow-[var(--chat-shadow-xs)]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[var(--chat-label-primary)]">连接中断，响应不完整</span>
              <span className="ml-auto font-mono text-[10px] leading-none tracking-[.02em] text-[var(--chat-label-caption)]">ERR_STREAM_ABORT</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-[1.65] text-[#991B1B]">{message.error}</p>
            <div className="mt-2.5 flex gap-2">
              {onRegenerate ? (
                <button type="button" onClick={onRegenerate} className="flex h-[30px] items-center gap-1.5 rounded-[8px] border border-[var(--chat-accent)] bg-white px-[13px] text-[12.5px] font-semibold text-[var(--chat-accent)] transition-colors hover:bg-[var(--chat-accent-soft)]">
                  <RotateCcw className="size-[13px]" strokeWidth={1.5} />重试
                </button>
              ) : null}
              {onDiscard ? (
                <button type="button" onClick={onDiscard} className="flex h-[30px] items-center gap-1.5 rounded-[8px] border border-[#E7EAEE] bg-[var(--chat-bg-card)] px-[13px] text-[12.5px] font-semibold text-[var(--chat-label-secondary)] shadow-[var(--chat-shadow-xs)] transition-colors hover:shadow-[var(--chat-shadow-sm)]">丢弃并停止</button>
            ) : null}
          </div>
        </div>
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-0.5 opacity-55 transition-opacity group-hover:opacity-100">
        {message.content ? (
          <button type="button" onClick={() => void copyToClipboard(message.content)} className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-subtle)] hover:text-[var(--chat-label-primary)]">
            <Copy className="size-[13px]" strokeWidth={1.5} />复制
          </button>
        ) : null}
        {canRegenerate && onRegenerate ? (
          <button type="button" onClick={onRegenerate} className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-subtle)] hover:text-[var(--chat-label-primary)]">
            <RotateCcw className="size-[13px]" strokeWidth={1.5} />重新生成
          </button>
        ) : null}
        {message.model ? <span className="ml-auto px-1 font-mono text-[11px] text-[var(--chat-label-tertiary)]">{message.model}</span> : null}
      </div>
    </div>
  )
}