"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CircleAlert, Menu, PanelRightClose, PanelRightOpen } from "lucide-react"
import { useSession } from "@/components/dashboard/admin-context"
import {
  createChatStreamState,
  extractStreamError,
  finalizeStreamState,
  reduceChatStreamEvent,
  type ChatStreamState,
  type ChatToolCall,
} from "@/lib/chat-stream-mapper"
import {
  Composer,
  type ComposerOptions,
  type ReasoningLevel,
} from "./composer"
import {
  AssistantMessage,
  UserBubble,
  type ChatMessage,
} from "./message"
import { DetailsPanel, type UsageInfo } from "./details-panel"
import { SessionSidebar, type SessionItem } from "./session-sidebar"
import { FusionMark } from "./icons"

type ChatInterface = "chat" | "responses"
type Status = "ready" | "submitted" | "streaming" | "error"

const storageKey = "opencode-dashboard-chat-v2"

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? (Date.now() + "-" + Math.random())
}

function preferredModel(models: string[]): string {
  return models.find((model) => model === "gpt-5.6-luna")
    ?? models.find((model) => model.startsWith("gpt-5.6"))
    ?? models.find((model) => model.startsWith("gpt-5"))
    ?? models[0]
    ?? ""
}

function readSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replaceAll("\r\n", "\n")
  const parts = normalized.split("\n\n")
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? "" }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback
  const error = (payload as { error?: unknown }).error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return fallback
}

function completedReasoning(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const response = (payload as { response?: unknown }).response
  if (!response || typeof response !== "object") return ""
  const output = (response as { output?: unknown }).output
  if (!Array.isArray(output)) return ""
  return output.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "reasoning") return []
    const parts = [(item as { summary?: unknown }).summary, (item as { content?: unknown }).content].flatMap((value) => Array.isArray(value) ? value : [])
    return parts.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : [])
  }).join("\n\n")
}

function completedUsage(payload: unknown): UsageInfo | null {
  if (!payload || typeof payload !== "object") return null
  const response = (payload as { response?: unknown }).response
  if (!response || typeof response !== "object") return null
  const usage = (response as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object") return null
  const u = usage as Record<string, unknown>
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined
  const totalTokens = typeof u.total_tokens === "number" ? u.total_tokens : (inputTokens ?? 0) + (outputTokens ?? 0)
  if (!inputTokens && !outputTokens && !totalTokens) return null
  return { inputTokens, outputTokens, totalTokens }
}

export function ChatPage() {
  const { sessionFetch } = useSession()
  const [options, setOptions] = useState<ComposerOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [model, setModel] = useState("")
  const [reasoning, setReasoning] = useState<ReasoningLevel>("auto")
  const [interfaceType, setInterfaceType] = useState<ChatInterface>("chat")
  const [route, setRoute] = useState("auto")
  const [status, setStatus] = useState<Status>("ready")
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [queue, setQueue] = useState<string[]>([])
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const queueRef = useRef<string[]>([])
  const hydratedRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)

  // ---- localStorage 会话持久化 ----
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(storageKey)
        if (saved) {
          const parsed = JSON.parse(saved) as { sessions?: SessionItem[]; currentId?: string; messages?: ChatMessage[]; model?: string; reasoning?: ReasoningLevel; interfaceType?: ChatInterface; route?: string }
          const restoredSessions = Array.isArray(parsed.sessions) ? parsed.sessions : []
          const restoredId = typeof parsed.currentId === "string" ? parsed.currentId : null
          const restoredMessages = Array.isArray(parsed.messages) ? parsed.messages.map((message) => message.status === "streaming" ? { ...message, status: "error" as const, error: "上次生成已中断" } : message) : []
          setSessions(restoredSessions)
          setCurrentId(restoredId)
          activeIdRef.current = restoredId
          setMessages(restoredMessages)
          if (typeof parsed.model === "string") setModel(parsed.model)
          if (typeof parsed.reasoning === "string") setReasoning(parsed.reasoning as ReasoningLevel)
          if (parsed.interfaceType === "chat" || parsed.interfaceType === "responses") setInterfaceType(parsed.interfaceType)
          if (typeof parsed.route === "string") setRoute(parsed.route)
        }
      } catch { /* ignore malformed drafts */ }
      hydratedRef.current = true
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  // 移动端：详情默认收起，抽屉交互
  useEffect(() => {
    if (typeof window === "undefined") return
    const m = window.matchMedia("(max-width: 767px)")
    const sync = () => {
      if (m.matches) setDetailsOpen(false)
    }
    sync()
    // 仅初始化时同步一次，避免桌面端后续状态被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hydratedRef.current) return
    window.localStorage.setItem(storageKey, JSON.stringify({ sessions, currentId, messages, model, reasoning, interfaceType, route }))
  }, [sessions, currentId, messages, model, reasoning, interfaceType, route])

  // ---- 加载选项 ----
  const loadOptions = useCallback(async () => {
    setOptionsError(null)
    const response = await sessionFetch("/api/chat")
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      setOptionsError(errorMessage(payload, "无法加载聊天配置"))
      return
    }
    const next = payload as ComposerOptions
    setOptions(next)
    setModel((current) => current && next.models.includes(current) ? current : preferredModel(next.models))
  }, [sessionFetch])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOptions(), 0)
    return () => window.clearTimeout(timer)
  }, [loadOptions])

  const compatiblePools = useMemo(() => options?.pools.filter((pool) => pool.readyAccounts > 0 && (!model || pool.models.includes(model))) ?? [], [model, options])
  const compatiblePoolTypes = useMemo(() => new Set(compatiblePools.map((pool) => pool.type)), [compatiblePools])
  const compatibleAccounts = useMemo(() => options?.accounts.filter((account) => account.ready && compatiblePoolTypes.has(account.poolType)) ?? [], [compatiblePoolTypes, options])

  const effectiveRoute = route.startsWith("pool:") && !compatiblePoolTypes.has(route.slice(5))
    ? "auto"
    : route.startsWith("account:") && !compatibleAccounts.some((account) => account.id === route.slice(8)) ? "auto" : route

  const selectedPool = effectiveRoute.startsWith("pool:") ? compatiblePools.find((pool) => pool.type === effectiveRoute.slice(5)) : null
  const selectedAccount = effectiveRoute.startsWith("account:") ? compatibleAccounts.find((account) => account.id === effectiveRoute.slice(8)) : null
  const routeLabel = selectedAccount ? selectedAccount.name : selectedPool ? selectedPool.label : "自动"
  const onlineCount = options?.pools.reduce((sum, pool) => sum + pool.readyAccounts, 0) ?? 0
  const totalPools = options?.pools.length ?? 0

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus("ready")
    setMessages((current) => current.map((message) => message.status === "streaming" ? { ...message, status: "error" as const, error: "已停止生成" } : message))
  }, [])

  const runGeneration = useCallback(async (contextMessages: ChatMessage[], assistantId: string) => {
    setStatus("submitted")
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const routing = effectiveRoute.startsWith("pool:")
        ? { mode: "pool" as const, poolType: effectiveRoute.slice(5) }
        : effectiveRoute.startsWith("account:") ? { mode: "account" as const, accountId: effectiveRoute.slice(8) } : { mode: "auto" as const }
      const response = await sessionFetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          model,
          interfaceType,
          reasoningEffort: reasoning,
          routing,
          messages: contextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        }),
      })
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null)
        throw new Error(errorMessage(payload, "调用失败（" + response.status + "）"))
      }

      setStatus("streaming")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let stream: ChatStreamState = createChatStreamState()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const parsed = readSseEvents(buffer)
        buffer = parsed.rest
        for (const event of parsed.events) {
          const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
          if (!data || data === "[DONE]") continue
          const payload = JSON.parse(data)
          const err = extractStreamError(payload)
          if (err) throw new Error(err)
          if (payload.type === "response.completed" && !stream.reasoning) {
            const reasoningText = completedReasoning(payload)
            if (reasoningText) stream = { ...stream, reasoning: reasoningText }
          }
          stream = reduceChatStreamEvent(stream, payload)
          const usageInfo = completedUsage(payload)
          if (usageInfo) setUsage(usageInfo)
          setMessages((current) => current.map((message) => message.id === assistantId ? {
            ...message,
            content: stream.content,
            reasoning: stream.reasoning || undefined,
            toolCalls: stream.toolCalls,
          } : message))
        }
      }
      stream = finalizeStreamState(stream)
      setMessages((current) => current.map((message) => message.id === assistantId
        ? stream.content ? { ...message, content: stream.content, reasoning: stream.reasoning || undefined, toolCalls: stream.toolCalls, status: "complete" } : { ...message, reasoning: stream.reasoning || undefined, toolCalls: stream.toolCalls, status: "error", error: "模型没有返回文本内容" }
        : message))
      setStatus(stream.content ? "ready" : "error")
    } catch (cause) {
      if (controller.signal.aborted) return
      const message = cause instanceof Error ? cause.message : "聊天请求失败"
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, status: "error", error: message } : item))
      setStatus("error")
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [effectiveRoute, interfaceType, model, reasoning, sessionFetch])

  // 队列消费：上一轮结束后自动发送下一条
  const messagesRef = useRef<ChatMessage[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => {
    if (status !== "ready" && status !== "error") return
    const next = queueRef.current.shift()
    if (!next) return
    setQueue([...queueRef.current])
    const assistantId = newId()
    const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", status: "streaming", model, routeLabel, reasoningLabel: reasoning }
    const contextMessages = messagesRef.current.filter((message) => message.status !== "error")
    setMessages((current) => [...current, assistantMessage])
    void runGeneration(contextMessages, assistantId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, model, routeLabel, reasoning, runGeneration])

  const submit = useCallback((text: string, immediate: boolean) => {
    if (!model) return
    const userMessage: ChatMessage = { id: newId(), role: "user", content: text, status: "complete" }
    if (status === "submitted" || status === "streaming") {
      if (immediate) queueRef.current.unshift(text)
      else queueRef.current.push(text)
      setQueue([...queueRef.current])
      setMessages((current) => [...current, userMessage])
      return
    }
    const assistantId = newId()
    const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", status: "streaming", model, routeLabel, reasoningLabel: reasoning }
    const contextMessages = [...messages.filter((message) => message.status !== "error"), userMessage]
    setMessages((current) => [...current, userMessage, assistantMessage])
    void runGeneration(contextMessages, assistantId)
  }, [messages, model, routeLabel, reasoning, runGeneration, status])

  const regenerate = useCallback(async (assistantId: string) => {
    if (!model || status === "submitted" || status === "streaming") return
    const assistantIndex = messages.findIndex((message) => message.id === assistantId && message.role === "assistant")
    if (assistantIndex < 0) return
    const contextMessages = messages.slice(0, assistantIndex).filter((message) => message.status !== "error")
    if (!contextMessages.some((message) => message.role === "user")) return
    setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: "", reasoning: undefined, error: undefined, toolCalls: undefined, status: "streaming", model, routeLabel, reasoningLabel: reasoning } : message))
    await runGeneration(contextMessages, assistantId)
  }, [messages, model, routeLabel, reasoning, runGeneration, status])

  const newChat = useCallback(() => {
    stop()
    const id = newId()
    setSessions((current) => [{ id, title: "新对话" }, ...current])
    setCurrentId(id)
    activeIdRef.current = id
    setMessages([])
    setUsage(null)
    setStatus("ready")
    queueRef.current = []
    setQueue([])
    setSidebarOpen(false)
  }, [stop])

  const selectSession = useCallback((id: string) => {
    if (id === currentId) {
      setSidebarOpen(false)
      return
    }
    setCurrentId(id)
    activeIdRef.current = id
    setMessages([])
    setUsage(null)
    setSidebarOpen(false)
  }, [currentId])

  const discardError = useCallback((messageId: string) => {
    setMessages((current) => current.map((message) => message.id === messageId && message.status === "error"
      ? { ...message, status: "complete" as const, error: undefined }
      : message))
    setStatus("ready")
  }, [])

  const deleteSession = useCallback((id: string) => {
    setSessions((current) => current.filter((session) => session.id !== id))
    if (id === currentId) {
      setCurrentId(null)
      activeIdRef.current = null
      setMessages([])
    }
  }, [currentId])

  const lastAssistantId = useMemo(() => [...messages].reverse().find((message) => message.role === "assistant")?.id, [messages])
  const lastToolCalls: ChatToolCall[] = useMemo(() => {
    const last = [...messages].reverse().find((message) => message.role === "assistant")
    return last?.toolCalls ?? []
  }, [messages])

  const sessionTitle = useMemo(() => {
    const firstUser = messages.find((message) => message.role === "user")
    if (firstUser?.content) return firstUser.content.slice(0, 32)
    return "新对话"
  }, [messages])

  return (
    <div className="flex h-full min-h-0 w-full bg-[var(--chat-bg-page)]">
      <SessionSidebar
        sessions={sessions}
        currentId={currentId}
        onlineCount={onlineCount}
        totalPools={totalPools}
        onNew={newChat}
        onSelect={selectSession}
        onDelete={deleteSession}
        mobileOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--chat-bg-main)]">
        <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 bg-[var(--chat-bg-main)] px-3 md:gap-3 md:px-5 max-md:h-14">
          <div className="flex min-w-0 items-center gap-1.5 md:gap-2">
            <button type="button" onClick={() => setSidebarOpen(true)} aria-label="打开会话列表" className="flex size-11 shrink-0 items-center justify-center rounded-xl text-[var(--chat-label-primary)] hover:bg-[var(--chat-bg-layer-2)] md:hidden">
              <Menu className="size-5" />
            </button>
            <span className="hidden text-[12.5px] text-[var(--chat-label-tertiary)] md:inline">工作区</span>
            <span className="hidden text-xs text-[var(--chat-border-l3)] md:inline">/</span>
            <span className="hidden text-[12.5px] text-[var(--chat-label-tertiary)] md:inline">聊天</span>
            <span className="hidden text-xs text-[var(--chat-border-l3)] md:inline">/</span>
            <span className="max-w-[60vw] truncate text-[13.5px] font-medium text-[#3F3F46] md:max-w-[340px]">{sessionTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="hidden h-7 items-center gap-1.5 rounded-full bg-[var(--chat-bg-subtle)] px-2.5 text-xs font-medium text-[var(--chat-label-secondary)] md:flex"><span className="size-[7px] rounded-full bg-[var(--chat-success)]" />{onlineCount}/{totalPools} 池在线</span>
            <span className="flex h-7 items-center gap-1 rounded-full bg-[var(--chat-bg-subtle)] px-2 text-[11px] font-medium text-[var(--chat-label-secondary)] md:hidden"><span className="size-[6px] rounded-full bg-[var(--chat-success)]" />{onlineCount}/{totalPools}</span>
            <button type="button" onClick={() => setDetailsOpen((value) => !value)} aria-label="详情" className={"flex size-11 items-center justify-center rounded-xl md:size-7 md:rounded-lg " + (detailsOpen ? "bg-[var(--chat-accent-soft)] text-[var(--chat-accent)]" : "text-[var(--chat-label-tertiary)] hover:bg-[var(--chat-bg-layer-2)]")}>
              {detailsOpen ? <PanelRightClose className="size-5 md:size-4" /> : <PanelRightOpen className="size-5 md:size-4" />}
            </button>
          </div>
        </header>

        {optionsError ? (
          <div className="mx-4 mt-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span className="flex items-center gap-2"><CircleAlert className="size-4" />{optionsError}</span>
            <button type="button" onClick={() => void loadOptions()} className="rounded-full text-sm text-red-700 underline">重试</button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--chat-bg-main)]">
          <div className="mx-auto w-full max-w-[740px] px-6 pb-8 pt-5">
            {!messages.length ? <EmptyState onPick={(text) => submit(text, true)} disabled={!model} /> : (
              <div className="flex flex-col gap-6">
                {messages.map((message) => message.role === "user" ? (
                  <UserBubble key={message.id} content={message.content} />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    canRegenerate={message.id === lastAssistantId && message.status !== "streaming"}
                    onRegenerate={message.id === lastAssistantId ? () => void regenerate(message.id) : undefined}
                    onDiscard={message.status === "error" ? () => discardError(message.id) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <Composer
          options={options}
          model={model}
          onModelChange={setModel}
          reasoning={reasoning}
          onReasoningChange={setReasoning}
          route={effectiveRoute}
          onRouteChange={setRoute}
          status={status}
          onSend={submit}
          onStop={stop}
          queuedCount={queue.length}
        />
      </main>
      <DetailsPanel open={detailsOpen} onClose={() => setDetailsOpen(false)} toolCalls={lastToolCalls} usage={usage} />
    </div>
  )
}

const EMPTY_PROMPTS = [
  { title: "接入新模型池", desc: "为网关添加一个上游 provider", icon: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" },
  { title: "排查请求失败", desc: "定位一条请求的报错根因", icon: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M21 21l-4.3-4.3" },
  { title: "对比出口差异", desc: "chat 与 responses 入口行为", icon: "M8 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1M12 3v6M9 6h6" },
  { title: "写路由测试", desc: "为池路由策略补单元测试", icon: "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0-4h18" },
]

function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center px-1 pb-1 pt-2 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-[14px] bg-[#18181B] text-white"><FusionMark className="size-6 [&_path]:stroke-white [&_circle]:fill-white" /></span>
      <h2 className="text-[17px] font-semibold tracking-[-.01em] text-[var(--chat-label-primary)]">今天想做什么？</h2>
      <p className="mb-5 mt-1.5 max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--chat-label-tertiary)]">Fusion Router 聚合多个模型池，统一 OpenAI 与 Anthropic 兼容出口。选择一个任务开始。</p>
      <div className="grid w-full grid-cols-2 gap-3">
        {EMPTY_PROMPTS.map((prompt) => (
          <button key={prompt.title} type="button" disabled={disabled} onClick={() => onPick(prompt.desc)} className="rounded-[12px] bg-[var(--chat-bg-card)] p-4 text-left shadow-[var(--chat-shadow-card)] transition-[box-shadow,transform] duration-120 hover:shadow-[0_2px_8px_rgba(16,24,40,.06)] hover:translate-y-[-1px] disabled:opacity-50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="mb-2 size-[14px] text-[var(--chat-label-caption)]"><path d={prompt.icon} /></svg>
            <span className="block text-[13px] font-semibold text-[var(--chat-label-primary)]">{prompt.title}</span>
            <span className="text-[12.5px] leading-[1.5] text-[var(--chat-label-secondary)]">{prompt.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
