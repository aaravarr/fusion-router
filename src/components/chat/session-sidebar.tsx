"use client"

import { MessageSquarePlus, Search, Trash2, Pin } from "lucide-react"
import { FusionMark } from "./icons"

export interface SessionItem {
  id: string
  title: string
  model?: string
  pinned?: boolean
}

export function SessionSidebar({
  sessions,
  currentId,
  onlineCount,
  totalPools,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: SessionItem[]
  currentId: string | null
  onlineCount: number
  totalPools: number
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <aside className="flex min-h-0 w-[min(280px,22vw)] min-w-[240px] flex-col border-r border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)]">
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 px-4">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-lg"><FusionMark className="size-[26px]" /></span>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-[-.01em] text-[var(--chat-label-primary)]">Fusion Router</div>
          <div className="text-[10.5px] font-medium text-[var(--chat-label-tertiary)]">智能路由网关</div>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-1.5">
        <button type="button" onClick={onNew} className="flex h-[38px] items-center justify-center gap-[7px] rounded-xl bg-[var(--chat-accent)] text-[13.5px] font-semibold text-white transition-colors hover:bg-[var(--chat-accent-hover)]">
          <MessageSquarePlus className="size-[15px]" />新对话
        </button>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--chat-border-l1)] bg-white px-2.5 text-[var(--chat-label-tertiary)]">
          <Search className="size-3.5" />
          <input type="text" placeholder="搜索会话" className="w-full border-none bg-transparent text-[13px] outline-none placeholder:text-[var(--chat-label-caption)]" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-0.5">
        {sessions.length ? (
          <div className="mt-3">
            <div className="mb-[3px] px-2 text-[11px] font-semibold uppercase tracking-[.05em] text-[var(--chat-label-tertiary)]">今天</div>
            {sessions.map((session) => (
              <div key={session.id} className={"group relative flex cursor-pointer items-start gap-2 rounded-lg px-2 py-[7px] " + (session.id === currentId ? "bg-[var(--chat-accent-soft)]" : "hover:bg-[var(--chat-bg-layer-2)]")}>
                {session.id === currentId ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-[2px] bg-[var(--chat-accent)]" /> : null}
                <Pin className={"mt-0.5 size-[13px] shrink-0 text-[var(--chat-label-caption)] " + (session.pinned ? "visible" : "invisible group-hover:visible")} />
                <button type="button" onClick={() => onSelect(session.id)} className="min-w-0 flex-1 text-left">
                  <div className={"truncate text-[13px] " + (session.id === currentId ? "font-semibold text-[var(--chat-accent-strong)]" : "font-medium text-[var(--chat-label-primary)]")}>{session.title || "新对话"}</div>
                  {session.model ? <div className="mt-px font-mono text-[11px] text-[var(--chat-label-tertiary)]">{session.model}</div> : null}
                </button>
                <button type="button" onClick={() => onDelete(session.id)} aria-label="删除" className="invisible absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-layer-2)] hover:text-[var(--chat-error)] group-hover:visible"><Trash2 className="size-3" /></button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 px-2 text-xs text-[var(--chat-label-tertiary)]">暂无会话，点击「新对话」开始</p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--chat-border-l1)] px-4 py-2.5 text-[11.5px] text-[var(--chat-label-tertiary)]">
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--chat-label-secondary)]"><span className="size-[7px] rounded-full bg-[var(--chat-success)]" />{onlineCount}/{totalPools} 池在线</span>
        <span className="font-mono text-[11px]">v0.9.1</span>
      </div>
    </aside>
  )
}

