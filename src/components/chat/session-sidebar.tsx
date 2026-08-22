"use client"

import { Search, Trash2, X } from "lucide-react"

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
        <span className="grid size-[28px] shrink-0 place-items-center rounded-[9px] bg-[#18181B] text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-4"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M12 21V11"/><path d="M4 7.5 12 11l8-3.5"/></svg>
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[13px] font-semibold tracking-[-.02em] text-[var(--chat-label-primary)]">Fusion Router</div>
          <div className="text-[11px] font-normal text-[var(--chat-label-tertiary)]">opencode · 统一网关</div>
        </div>
        {showClose ? (
          <button type="button" onClick={onClose} aria-label="关闭会话列表" className="flex size-11 items-center justify-center rounded-xl text-[var(--chat-label-tertiary)] hover:bg-white/70 md:hidden">
            <X className="size-5" strokeWidth={1.5} />
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2.5 px-3 pb-1.5">
        <button type="button" onClick={onNew} className="flex h-11 items-center justify-center gap-[7px] rounded-[12px] bg-[#18181B] text-[13px] font-semibold text-white shadow-[var(--chat-shadow-card)] transition-[background,transform] duration-[120ms] hover:bg-[#27272A] active:scale-[.98] md:h-[36px]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-[14px]"><path d="M12 5v14M5 12h14"/></svg>新对话
        </button>
        <label className="flex h-11 items-center gap-2 rounded-[10px] bg-[var(--chat-bg-card)] px-[10px] text-[var(--chat-label-tertiary)] shadow-[var(--chat-shadow-card)] md:h-[34px]">
          <Search className="size-[14px] shrink-0 text-[var(--chat-label-caption)]" strokeWidth={1.5} />
          <input type="text" placeholder="搜索会话…" className="w-full border-none bg-transparent font-sans text-[13px] outline-none placeholder:text-[var(--chat-label-caption)]" />
          <span className="hidden shrink-0 rounded-[4px] bg-[var(--chat-bg-subtle)] px-[5px] py-[2px] font-mono text-[10px] text-[var(--chat-label-caption)] md:inline">⌘K</span>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-0.5">
        {sessions.length ? (
          <div className="mt-3">
            <div className="mb-[6px] px-2 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--chat-label-sub)]">今天</div>
            {sessions.map((session) => (
              <div key={session.id} className={"group relative flex cursor-pointer items-start gap-2 rounded-[12px] px-[10px] py-2 " + (session.id === currentId ? "bg-[var(--chat-bg-active)]" : "hover:bg-white/70") }>
                <span className={"mt-[1px] grid size-7 shrink-0 place-items-center rounded-[8px] shadow-[var(--chat-shadow-card)] " + (session.id === currentId ? "bg-[var(--chat-accent-soft)] text-[var(--chat-accent)]" : "bg-[var(--chat-bg-card)] text-[var(--chat-label-tertiary)]")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="size-[14px]"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </span>
                <button type="button" onClick={() => onSelect(session.id)} className="min-h-11 flex min-w-0 flex-1 flex-col justify-center text-left md:min-h-0 md:py-0">
                  <div className={"truncate text-[13px] leading-[1.4] " + (session.id === currentId ? "font-semibold text-[var(--chat-label-primary)]" : "font-medium text-[var(--chat-label-primary)]")}>{session.title || "新对话"}</div>
                  <div className="mt-[2px] truncate text-[11.5px] text-[var(--chat-label-caption)]">{session.model ? session.model : "···"}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="rounded-full bg-[var(--chat-bg-subtle)] px-[6px] py-[1px] font-mono text-[11px] leading-[14px] text-[var(--chat-label-caption)]">{session.model ? session.model.split("-")[0] : "···"}</span>
                    <span className={"size-[6px] shrink-0 rounded-full " + (session.model ? "bg-[var(--chat-success)]" : "bg-[var(--chat-accent)]")} />
                    <span className="text-[11px] text-[var(--chat-label-caption)]">2分钟前</span>
                  </div>
                </button>
                <button type="button" onClick={() => onDelete(session.id)} aria-label="删除" className="invisible absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--chat-label-tertiary)] hover:bg-white hover:text-[var(--chat-error)] group-hover:visible md:right-1.5 md:top-1.5 md:size-5 md:translate-y-0"><Trash2 className="size-4 md:size-3" strokeWidth={1.5} /></button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 px-2 text-xs text-[var(--chat-label-tertiary)]">暂无会话，点击「新对话」开始</p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--chat-border-l2)] px-4 py-2.5 text-[11.5px] text-[var(--chat-label-tertiary)]">
        <span className="font-mono text-[11px] text-[var(--chat-label-caption)]">v0.9.1</span>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--chat-label-tertiary)]"><span className="size-[7px] rounded-full bg-[var(--chat-success)]" /> 网关在线 · {totalPools} 池</span>
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
      {/* Desktop static 272px — v3 无竖线，用底色阶区分 */}
      <aside className="hidden min-h-0 w-[272px] shrink-0 flex-col bg-[var(--chat-bg-sidebar)] md:flex">
        <SidebarInner sessions={sessions} currentId={currentId} onlineCount={onlineCount} totalPools={totalPools} onNew={onNew} onSelect={onSelect} onDelete={onDelete} />
      </aside>
      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label="会话列表">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
          <aside className="relative flex w-[84vw] max-w-[300px] flex-col bg-[var(--chat-bg-sidebar)] shadow-xl">
            <SidebarInner sessions={sessions} currentId={currentId} onlineCount={onlineCount} totalPools={totalPools} onNew={handleNew} onSelect={handleSelect} onDelete={onDelete} onClose={onClose} showClose />
          </aside>
        </div>
      ) : null}
    </>
  )
}
