"use client"

import { MessageSquarePlus, Search, Trash2, Pin, X } from "lucide-react"
import { FusionMark } from "./icons"

export interface SessionItem {
  id: string
  title: string
  model?: string
  pinned?: boolean
}

function SidebarInner({
  sessions,
  currentId,
  onlineCount,
  totalPools,
  onNew,
  onSelect,
  onDelete,
  onClose,
  showClose,
}: {
  sessions: SessionItem[]
  currentId: string | null
  onlineCount: number
  totalPools: number
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onClose?: () => void
  showClose?: boolean
}) {
  return (
    <>
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 px-4">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-lg"><FusionMark className="size-[26px]" /></span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-bold tracking-[-.01em] text-[var(--chat-label-primary)]">Fusion Router</div>
          <div className="text-[10.5px] font-medium text-[var(--chat-label-tertiary)]">智能路由网关</div>
        </div>
        {showClose ? (
          <button type="button" onClick={onClose} aria-label="关闭会话列表" className="flex size-11 items-center justify-center rounded-xl text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-layer-2)] md:hidden">
            <X className="size-5" />
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-1.5">
        <button type="button" onClick={onNew} className="flex h-11 items-center justify-center gap-[7px] rounded-xl bg-[var(--chat-accent)] text-[13.5px] font-semibold text-white transition-colors hover:bg-[var(--chat-accent-hover)] md:h-[38px]">
          <MessageSquarePlus className="size-[15px]" />新对话
        </button>
        <label className="flex h-11 items-center gap-2 rounded-lg border border-[var(--chat-border-l1)] bg-white px-2.5 text-[var(--chat-label-tertiary)] md:h-8">
          <Search className="size-3.5" />
          <input type="text" placeholder="搜索会话" className="w-full border-none bg-transparent text-[13px] outline-none placeholder:text-[var(--chat-label-caption)]" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-0.5">
        {sessions.length ? (
          <div className="mt-3">
            <div className="mb-[3px] px-2 text-[11px] font-semibold uppercase tracking-[.05em] text-[var(--chat-label-tertiary)]">今天</div>
            {sessions.map((session) => (
              <div key={session.id} className={"group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-3 md:py-[7px] " + (session.id === currentId ? "bg-[var(--chat-accent-soft)]" : "hover:bg-[var(--chat-bg-layer-2)]")}>
                {session.id === currentId ? <span className="absolute left-0 top-1.5 bottom-1.5 hidden w-[3px] rounded-r-[2px] bg-[var(--chat-accent)] md:block" /> : null}
                {session.id === currentId ? <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-[2px] bg-[var(--chat-accent)] md:hidden" /> : null}
                <Pin className={"size-[13px] shrink-0 text-[var(--chat-label-caption)] " + (session.pinned ? "visible" : "invisible group-hover:visible max-md:hidden")} />
                <button type="button" onClick={() => onSelect(session.id)} className="min-h-11 flex min-w-0 flex-1 flex-col justify-center text-left md:min-h-0 md:py-0">
                  <div className={"truncate text-[13px] " + (session.id === currentId ? "font-semibold text-[var(--chat-accent-strong)]" : "font-medium text-[var(--chat-label-primary)]")}>{session.title || "新对话"}</div>
                  {session.model ? <div className="mt-px truncate font-mono text-[11px] text-[var(--chat-label-tertiary)]">{session.model}</div> : null}
                </button>
                <button type="button" onClick={() => onDelete(session.id)} aria-label="删除" className="invisible absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-layer-2)] hover:text-[var(--chat-error)] group-hover:visible md:right-1.5 md:top-1.5 md:size-5 md:translate-y-0"><Trash2 className="size-4 md:size-3" /></button>
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
    </>
  )
}

export function SessionSidebar({
  sessions,
  currentId,
  onlineCount,
  totalPools,
  onNew,
  onSelect,
  onDelete,
  mobileOpen,
  onClose,
}: {
  sessions: SessionItem[]
  currentId: string | null
  onlineCount: number
  totalPools: number
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  mobileOpen?: boolean
  onClose?: () => void
}) {
  const handleSelect = (id: string) => {
    onSelect(id)
    onClose?.()
  }
  const handleNew = () => {
    onNew()
    onClose?.()
  }
  return (
    <>
      {/* Desktop static 280px */}
      <aside className="hidden min-h-0 w-[min(280px,22vw)] min-w-[240px] shrink-0 flex-col border-r border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)] md:flex">
        <SidebarInner sessions={sessions} currentId={currentId} onlineCount={onlineCount} totalPools={totalPools} onNew={onNew} onSelect={onSelect} onDelete={onDelete} />
      </aside>
      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label="会话列表">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
          <aside className="relative flex w-[84vw] max-w-[300px] flex-col border-r border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)] shadow-xl">
            <SidebarInner sessions={sessions} currentId={currentId} onlineCount={onlineCount} totalPools={totalPools} onNew={handleNew} onSelect={handleSelect} onDelete={onDelete} onClose={onClose} showClose />
          </aside>
        </div>
      ) : null}
    </>
  )
}
