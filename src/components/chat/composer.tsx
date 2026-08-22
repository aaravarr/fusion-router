"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Paperclip, Search, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ComposerOptions {
  models: string[]
  pools: Array<{ type: string; label: string; models: string[]; readyAccounts: number }>
  accounts: Array<{ id: string; name: string; email?: string | null; poolType: string; poolLabel: string; ready: boolean }>
}

const REASONING_LEVELS = ["auto", "none", "minimal", "low", "medium", "high", "xhigh"] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

function groupModelsByProvider(models: string[]): Array<{ provider: string; models: string[] }> {
  const groups = new Map<string, string[]>()
  for (const model of models) {
    const provider = model.split("-")[0] || "其他"
    const list = groups.get(provider) ?? []
    list.push(model)
    groups.set(provider, list)
  }
  return [...groups.entries()].map(([provider, items]) => ({ provider, models: items }))
}

function supportsTools(model: string): boolean {
  const unsupported = /gpt-3|text-|embedding/i
  return !unsupported.test(model)
}

export function Composer(props: {
  options: ComposerOptions | null
  model: string
  onModelChange: (value: string) => void
  reasoning: ReasoningLevel
  onReasoningChange: (value: ReasoningLevel) => void
  route: string
  onRouteChange: (value: string) => void
  status: "ready" | "submitted" | "streaming" | "error"
  onSend: (text: string, immediate: boolean) => void
  onStop: () => void
  queuedCount: number
}) {
  const {
    options,
    model,
    onModelChange,
    reasoning,
    onReasoningChange,
    route,
    onRouteChange,
    status,
    onSend,
    onStop,
    queuedCount,
  } = props
  const [draft, setDraft] = useState("")
  const [modelOpen, setModelOpen] = useState(false)
  const [routeOpen, setRouteOpen] = useState(false)
  const [query, setQuery] = useState("")
  const popRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const busy = status === "submitted" || status === "streaming"
  const groups = useMemo(() => groupModelsByProvider(options?.models ?? []), [options?.models])
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((g) => ({ ...g, models: g.models.filter((m) => m.toLowerCase().includes(q)) }))
      .filter((g) => g.models.length > 0)
  }, [groups, query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setModelOpen((v) => !v)
        setRouteOpen(false)
      }
      if (event.key === "Escape") {
        setModelOpen(false)
        setRouteOpen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (!modelOpen && !routeOpen) return
    const onDown = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) {
        setModelOpen(false)
        setRouteOpen(false)
      }
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [modelOpen, routeOpen])

  // auto-resize textarea: 24px min, 160px (25vh) max, then scroll
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    const max = 160
    const next = Math.min(el.scrollHeight, max)
    el.style.height = next + "px"
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
  }, [draft])

  const submit = (immediate: boolean) => {
    const text = draft.trim()
    if (!text || !model) return
    setDraft("")
    onSend(text, immediate)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (busy) {
        if (event.metaKey || event.ctrlKey) submit(true)
        else submit(false)
      } else submit(true)
    }
  }

  const compatiblePools = options?.pools.filter((pool) => pool.readyAccounts > 0) ?? []
  const selectedPool = route.startsWith("pool:") ? compatiblePools.find((pool) => pool.type === route.slice(5)) : null
  const selectedAccount = route.startsWith("account:")
    ? options?.accounts.find((a) => a.id === route.slice(8))
    : null
  const routeLabel = selectedAccount ? selectedAccount.name : selectedPool ? selectedPool.label : "自动"
  const onlineCount = compatiblePools.reduce((sum, pool) => sum + pool.readyAccounts, 0)

  return (
    <div className="relative flex-none px-3 pb-[calc(12px+env(safe-area-inset-bottom))] pt-2 md:px-6 md:pb-3">
      <div className="relative mx-auto w-full max-w-[780px] max-md:max-w-none">
        {queuedCount > 0 ? (
          <div className="mb-3 flex items-center gap-2 rounded-[var(--chat-r-12)] border border-[var(--chat-warn-border)] bg-[var(--chat-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--chat-label-secondary)]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-3.5 shrink-0 text-[var(--chat-warn)]"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
            <span>
              <b className="text-[var(--chat-warn)]">排队中 {queuedCount} 条</b>，上一条仍在生成
            </span>
            <span className="flex-1" />
            <span className="whitespace-nowrap rounded-md border border-[var(--chat-warn-border)] bg-white px-[7px] py-[2px] font-mono text-[11px] font-semibold text-[var(--chat-warn)]">
              Enter = 排队 · ⌘+Enter = 立即发送
            </span>
          </div>
        ) : null}
        <div
          className={cn(
            "rounded-[22px] border bg-white shadow-[var(--chat-shadow-lv2)] transition-[border-color,box-shadow] duration-120 ease-[cubic-bezier(.16,1,.3,1)]",
            "border-[var(--chat-border-l2)] focus-within:border-[var(--chat-accent)] focus-within:shadow-[0_0_0_3px_var(--chat-accent-soft)]",
          )}
        >
          {/* 输入区：min-height 44, padding 12/16/4, textarea 14.5/1.6 单行起步自适应 max 160 / 25vh */}
          <div className="min-h-[44px] px-4 pb-1 pt-3 md:px-4">
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={model ? "询问 " + model : "正在加载模型…"}
              disabled={!model}
              className="block max-h-[160px] min-h-[24px] w-full resize-none border-none bg-transparent text-[14.5px] leading-[1.6] outline-none placeholder:text-[var(--chat-label-caption)] md:max-h-[25vh]"
              style={{ overflowY: "hidden" }}
            />
          </div>
          {/* 底栏：padding 6/8/8, gap 10, 左 gap6 右 gap8, 行高 30 */}
          <div className="flex flex-wrap items-center justify-between gap-[10px] px-2 pb-2 pt-[6px] md:gap-[10px] md:px-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-label="附件"
                className="flex size-7 items-center justify-center rounded-lg text-[var(--chat-label-tertiary)] transition-colors hover:bg-[var(--chat-bg-layer-2)] hover:text-[var(--chat-label-primary)]"
              >
                <Paperclip className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setRouteOpen((v) => !v)
                  setModelOpen(false)
                }}
                className="flex h-7 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-xs font-medium text-[var(--chat-label-secondary)] transition-colors hover:bg-black/5"
              >
                <ShieldCheck className="size-3.5 shrink-0 text-[var(--chat-label-tertiary)]" />
                <span className="whitespace-nowrap">
                  路由 <span className="font-semibold text-[var(--chat-label-primary)]">{routeLabel}</span>
                </span>
                <ChevronDown
                  className={cn(
                    "size-[13px] shrink-0 text-[var(--chat-label-tertiary)] transition-transform duration-120",
                    routeOpen && "rotate-180",
                  )}
                />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setModelOpen((v) => !v)
                  setRouteOpen(false)
                }}
                className="flex h-7 items-center gap-[7px] rounded-lg border-0 bg-transparent py-0 pl-2 pr-1.5 transition-colors hover:bg-black/5"
              >
                <span className="size-2 shrink-0 rounded-full bg-[var(--chat-accent)]" />
                <span className="max-w-[120px] truncate text-[12.5px] font-medium leading-none text-[var(--chat-label-primary)] md:max-w-[160px]">
                  {model || "选择模型"}
                </span>
                <span className="shrink-0 rounded bg-[var(--chat-bg-layer-2)] px-[5px] py-[1px] font-mono text-[10px] font-medium leading-[14px] text-[var(--chat-label-tertiary)]">
                  {reasoning}
                </span>
                <ChevronDown
                  className={cn(
                    "mr-0.5 size-[13px] shrink-0 text-[var(--chat-label-tertiary)] transition-transform duration-120",
                    modelOpen && "rotate-180",
                  )}
                />
              </button>
              {busy ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="停止"
                  className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[var(--chat-gray-900)] text-white transition-[background,transform] duration-120 hover:bg-[var(--chat-gray-800)] active:scale-[.94]"
                >
                  <span className="size-3 rounded-[2px] bg-white" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => submit(true)}
                  disabled={!model || !draft.trim()}
                  aria-label="发送"
                  className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[var(--chat-accent)] text-white transition-[background,transform] duration-120 hover:bg-[var(--chat-accent-hover)] active:scale-[.94] disabled:opacity-40"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-4"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-[7px] hidden items-center gap-2 px-2 font-mono text-[11px] text-[var(--chat-label-caption)] md:flex">
          <span>
            <span className="kbd-chip">Enter</span> 发送
          </span>
          <span className="text-[var(--chat-border-l3)]">·</span>
          <span>
            <span className="kbd-chip">Shift+Enter</span> 换行
          </span>
          <span className="text-[var(--chat-border-l3)]">·</span>
          <span>
            路由：{routeLabel} · {compatiblePools.length}/{compatiblePools.length} 池在线
          </span>
        </div>
        {modelOpen ? (
          <div
            ref={popRef}
            className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-30 overflow-hidden rounded-[var(--chat-r-12)] border border-[var(--chat-border-l2)] bg-white shadow-[var(--chat-shadow-lv3)] md:left-0 md:right-0"
          >
            <div className="mx-3 mb-1.5 mt-2.5 flex h-[34px] items-center gap-2 rounded-lg border border-[var(--chat-border-l1)] bg-white px-2.5 text-[var(--chat-label-tertiary)]">
              <Search className="size-3.5 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索模型"
                className="w-full border-none bg-transparent text-[13px] outline-none placeholder:text-[var(--chat-label-caption)]"
              />
              <span className="kbd-chip shrink-0">⌘K</span>
            </div>
            <div className="grid max-h-[min(60vh,360px)] grid-cols-1 overflow-hidden border-t border-[var(--chat-border-l1)] md:max-h-[360px] md:grid-cols-[150px_1fr]">
              <div className="overflow-y-auto p-1.5 pb-2 min-h-0 max-h-[360px]">
                <div className="sticky top-0 bg-white px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[.04em] text-[var(--chat-label-tertiary)]">
                  Provider
                </div>
                {filteredGroups.map((group) => (
                  <div
                    key={group.provider}
                    className="flex items-center gap-[7px] rounded-lg px-2 py-[7px] text-[12.5px] text-[var(--chat-label-primary)] hover:bg-[var(--chat-bg-layer-2)]"
                  >
                    <span className="truncate">{group.provider}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-[var(--chat-label-caption)]">
                      {group.models.length}
                    </span>
                  </div>
                ))}
              </div>
              <div className="overflow-y-auto border-l border-[var(--chat-border-l1)] p-1.5 pb-2 min-h-0 max-h-[360px]">
                <div className="sticky top-0 bg-white px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[.04em] text-[var(--chat-label-tertiary)]">
                  模型
                </div>
                {filteredGroups.flatMap((group) => group.models).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      onModelChange(item)
                      setModelOpen(false)
                    }}
                    className={cn(
                      "grid w-full grid-cols-[1fr_max-content] items-center gap-x-2 gap-y-1 rounded-lg px-2 py-[7px] text-left transition-colors",
                      item === model ? "bg-[var(--chat-accent-soft)]" : "hover:bg-[var(--chat-bg-layer-2)]",
                    )}
                  >
                    <span
                      className={cn(
                        "flex min-w-0 items-center gap-[7px] text-[13px] font-medium",
                        item === model ? "text-[var(--chat-accent-strong)]" : "text-[var(--chat-label-primary)]",
                      )}
                    >
                      <span className="truncate">{item}</span>
                    </span>
                    {item === model ? <Check className="size-[15px] shrink-0 text-[var(--chat-accent)]" /> : null}
                    <span className="col-span-full text-left text-[11px] leading-[1.4] text-[var(--chat-label-tertiary)]">
                      {supportsTools(item) ? "支持工具调用" : "不支持工具调用"}
                    </span>
                  </button>
                ))}
                {!filteredGroups.length ? (
                  <p className="px-2 py-4 text-center text-xs text-[var(--chat-label-tertiary)]">没有匹配的模型</p>
                ) : null}
                <div className="mt-1 border-t border-[var(--chat-border-l1)] p-2">
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[.04em] text-[var(--chat-label-tertiary)]">
                    推理强度
                  </div>
                  <div className="flex flex-wrap gap-1 rounded-lg bg-[var(--chat-bg-layer-2)] p-[3px]">
                    {REASONING_LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => onReasoningChange(level)}
                        className={cn(
                          "h-6 flex-1 rounded-md px-1 text-[11.5px] font-medium text-[var(--chat-label-tertiary)] transition-colors hover:text-[var(--chat-label-primary)]",
                          level === reasoning
                            ? "bg-white font-semibold text-[var(--chat-label-primary)] shadow-sm"
                            : "",
                        )}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)] px-3 py-[9px] text-[11px] text-[var(--chat-label-tertiary)]">
              {groups.length} 个 provider · {options?.models.length ?? 0} 个模型 · 不支持工具的模型会禁用 tool_calls 渲染
            </div>
          </div>
        ) : null}
        {routeOpen ? (
          <div
            ref={popRef}
            className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-30 overflow-hidden rounded-[var(--chat-r-12)] border border-[var(--chat-border-l2)] bg-white shadow-[var(--chat-shadow-lv3)]"
          >
            <div className="p-2">
              <RouteItem
                name="自动（智能路由）"
                desc="按成本、池健康度与失败重试自动分发"
                selected={route === "auto"}
                onSelect={() => {
                  onRouteChange("auto")
                  setRouteOpen(false)
                }}
              />
              <RouteItem name="按池" desc="锁定到某个模型池" selected={route.startsWith("pool:")} onSelect={() => {}} />
              {compatiblePools.length ? (
                <div className="mx-2 mb-2 ml-8 flex flex-col gap-0.5 border-l-2 border-[var(--chat-border-l1)] px-2 py-1.5">
                  {compatiblePools.map((pool) => (
                    <button
                      key={pool.type}
                      type="button"
                      onClick={() => {
                        onRouteChange("pool:" + pool.type)
                        setRouteOpen(false)
                      }}
                      className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] text-[var(--chat-label-secondary)] hover:bg-[var(--chat-bg-layer-2)]"
                    >
                      <span className="size-[7px] shrink-0 rounded-full bg-[var(--chat-success)]" />
                      <span>{pool.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--chat-label-caption)]">
                        {pool.readyAccounts} 账号
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              <RouteItem name="按账号" desc="锁定到某个具体账号" selected={route.startsWith("account:")} onSelect={() => {}} />
              {options?.accounts.length ? (
                <div className="mx-2 mb-2 ml-8 flex flex-col gap-0.5 border-l-2 border-[var(--chat-border-l1)] px-2 py-1.5">
                  {options.accounts.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => {
                        onRouteChange("account:" + account.id)
                        setRouteOpen(false)
                      }}
                      className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] text-[var(--chat-label-secondary)] hover:bg-[var(--chat-bg-layer-2)]"
                    >
                      <span
                        className={
                          "size-[7px] shrink-0 rounded-full " +
                          (account.ready ? "bg-[var(--chat-success)]" : "bg-[var(--chat-warn)]")
                        }
                      />
                      <span className="truncate">
                        {account.name} · {account.poolLabel}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="border-t border-[var(--chat-border-l1)] bg-[var(--chat-bg-layer-1)] px-3 py-[9px] text-[11px] text-[var(--chat-label-tertiary)]">
              失败自动切换在「按池 / 按账号」模式下仍然生效 · 当前 {onlineCount} 个可用账号
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function RouteItem(props: { name: string; desc: string; selected: boolean; onSelect: () => void }) {
  const { name, desc, selected, onSelect } = props
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg px-2 py-[9px] text-left transition-colors",
        selected ? "bg-[var(--chat-accent-soft)]" : "hover:bg-[var(--chat-bg-layer-2)]",
      )}
    >
      <span
        className={cn(
          "relative mt-0.5 size-[14px] shrink-0 rounded-full border-[1.5px]",
          selected ? "border-[var(--chat-accent)]" : "border-[var(--chat-border-l2)]",
        )}
      >
        {selected ? <span className="absolute inset-[3px] rounded-full bg-[var(--chat-accent)]" /> : null}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-[13px] font-semibold",
            selected ? "text-[var(--chat-accent-strong)]" : "text-[var(--chat-label-primary)]",
          )}
        >
          {name}
        </span>
        <span className="block text-[11.5px] text-[var(--chat-label-tertiary)]">{desc}</span>
      </span>
    </button>
  )
}
