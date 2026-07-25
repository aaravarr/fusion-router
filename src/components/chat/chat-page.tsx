"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Blocks,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Globe2,
  MessageSquarePlus,
  Network,
  Sparkles,
} from "lucide-react"
import { useSession } from "@/components/dashboard/admin-context"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { cn, copyToClipboard } from "@/lib/utils"

interface ChatOptions {
  models: string[]
  pools: Array<{ type: string; label: string; models: string[]; readyAccounts: number }>
  accounts: Array<{ id: string; name: string; email?: string | null; poolType: string; poolLabel: string; ready: boolean; blocked: boolean }>
  capabilities: { webSearch: boolean; mcp: boolean }
}

type MessageStatus = "complete" | "streaming" | "error"
interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  status: MessageStatus
  error?: string
  model?: string
  routeLabel?: string
  reasoningLabel?: string
}

const reasoningOptions = [
  { value: "auto", label: "自动思考", detail: "由模型决定" },
  { value: "none", label: "不思考", detail: "尽快回答" },
  { value: "minimal", label: "最少", detail: "极轻量推理" },
  { value: "low", label: "低", detail: "简单任务" },
  { value: "medium", label: "中", detail: "均衡速度与质量" },
  { value: "high", label: "高", detail: "复杂问题" },
  { value: "xhigh", label: "极高", detail: "最充分推理" },
] as const

const storageKey = "opencode-dashboard-chat-v1"

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
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

export function ChatPage() {
  const { sessionFetch } = useSession()
  const [options, setOptions] = useState<ChatOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [model, setModel] = useState("")
  const [reasoning, setReasoning] = useState<(typeof reasoningOptions)[number]["value"]>("auto")
  const [route, setRoute] = useState("auto")
  const [status, setStatus] = useState<"ready" | "submitted" | "streaming" | "error">("ready")
  const abortRef = useRef<AbortController | null>(null)
  const hydratedRef = useRef(false)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(storageKey)
        if (saved) {
          const parsed = JSON.parse(saved) as { messages?: ChatMessage[]; model?: string; reasoning?: typeof reasoning; route?: string }
          if (Array.isArray(parsed.messages)) setMessages(parsed.messages.map((message) => message.status === "streaming" ? { ...message, status: "error", error: "上次生成已中断" } : message))
          if (typeof parsed.model === "string") setModel(parsed.model)
          if (reasoningOptions.some((item) => item.value === parsed.reasoning)) setReasoning(parsed.reasoning!)
          if (typeof parsed.route === "string") setRoute(parsed.route)
        }
      } catch { /* Ignore malformed local drafts. */ }
      hydratedRef.current = true
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!hydratedRef.current) return
    window.localStorage.setItem(storageKey, JSON.stringify({ messages, model, reasoning, route }))
  }, [messages, model, reasoning, route])

  const loadOptions = useCallback(async () => {
    setOptionsError(null)
    const response = await sessionFetch("/api/chat")
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      setOptionsError(errorMessage(payload, "无法加载聊天配置"))
      return
    }
    const next = payload as ChatOptions
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

  const selectedReasoning = reasoningOptions.find((item) => item.value === reasoning) ?? reasoningOptions[0]
  const selectedPool = effectiveRoute.startsWith("pool:") ? compatiblePools.find((pool) => pool.type === effectiveRoute.slice(5)) : null
  const selectedAccount = effectiveRoute.startsWith("account:") ? compatibleAccounts.find((account) => account.id === effectiveRoute.slice(8)) : null
  const routeLabel = selectedAccount ? selectedAccount.name : selectedPool ? selectedPool.label : "自动调度"

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus("ready")
    setMessages((current) => current.map((message) => message.status === "streaming"
      ? { ...message, status: "error", error: "已停止生成" }
      : message))
  }, [])

  const submit = useCallback(async ({ text }: { text: string }) => {
    const content = text.trim()
    if (!content || !model || status === "submitted" || status === "streaming") return
    const userMessage: ChatMessage = { id: newId(), role: "user", content, status: "complete" }
    const assistantId = newId()
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
      model,
      routeLabel,
      reasoningLabel: selectedReasoning.label,
    }
    const contextMessages = [...messages.filter((message) => message.status !== "error"), userMessage]
    setMessages((current) => [...current, userMessage, assistantMessage])
    setStatus("submitted")
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const routing = effectiveRoute.startsWith("pool:")
        ? { mode: "pool", poolType: effectiveRoute.slice(5) }
        : effectiveRoute.startsWith("account:") ? { mode: "account", accountId: effectiveRoute.slice(8) } : { mode: "auto" }
      const response = await sessionFetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          model,
          reasoningEffort: reasoning,
          routing,
          messages: contextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        }),
      })
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null)
        throw new Error(errorMessage(payload, `调用失败（${response.status}）`))
      }

      setStatus("streaming")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let answer = ""
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const parsed = readSseEvents(buffer)
        buffer = parsed.rest
        for (const event of parsed.events) {
          const data = event.split("\n").filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n")
          if (!data || data === "[DONE]") continue
          const payload = JSON.parse(data) as { type?: string; delta?: string; error?: unknown; response?: { error?: unknown } }
          if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
            answer += payload.delta
            setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: answer } : message))
          } else if (payload.type === "error" || payload.type === "response.failed") {
            throw new Error(errorMessage(payload, errorMessage(payload.response, "模型返回失败")))
          }
        }
      }
      setMessages((current) => current.map((message) => message.id === assistantId
        ? answer ? { ...message, content: answer, status: "complete" } : { ...message, status: "error", error: "模型没有返回文本内容" }
        : message))
      setStatus(answer ? "ready" : "error")
    } catch (cause) {
      if (controller.signal.aborted) return
      const message = cause instanceof Error ? cause.message : "聊天请求失败"
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, status: "error", error: message } : item))
      setStatus("error")
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [effectiveRoute, messages, model, reasoning, routeLabel, selectedReasoning.label, sessionFetch, status])

  const newChat = useCallback(() => {
    stop()
    setMessages([])
    setStatus("ready")
  }, [stop])

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[#ececec] px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <ModelMenu models={options?.models ?? []} value={model} onChange={setModel} loading={!options && !optionsError} />
          <span className="hidden h-4 w-px bg-[#e5e5e5] sm:block" />
          <span className="hidden truncate text-xs text-[#8b8b8b] sm:block">{routeLabel} · {selectedReasoning.label}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={newChat} className="rounded-full text-[#555]">
          <MessageSquarePlus />新对话
        </Button>
      </div>

      {optionsError ? (
        <div className="m-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2"><CircleAlert className="size-4" />{optionsError}</span>
          <Button variant="ghost" size="sm" onClick={() => void loadOptions()}>重试</Button>
        </div>
      ) : null}

      <Conversation className="min-h-0 bg-white">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-7 px-4 pb-48 pt-8 sm:px-8 sm:pt-12">
          {!messages.length ? (
            <ConversationEmptyState className="min-h-[52vh] p-2" title="" description="">
              <div className="flex max-w-xl flex-col items-center text-center">
                <div className="mb-6 grid size-11 place-items-center rounded-full border border-[#e5e5e5] bg-[#fafafa]">
                  <Sparkles className="size-5 text-[#10a37f]" strokeWidth={1.8} />
                </div>
                <h1 className="text-2xl font-semibold tracking-[-0.035em] text-[#171717] sm:text-[28px]">今天想聊点什么？</h1>
                <p className="mt-2 max-w-md text-sm leading-6 text-[#777]">选择模型与思考等级，默认由网关在所有可用账号中自动调度。</p>
                <div className="mt-7 grid w-full gap-2 sm:grid-cols-2">
                  {["分析这段代码的潜在问题", "帮我整理一个实现方案", "解释一个复杂技术概念", "把这段内容写得更清楚"].map((prompt) => (
                    <Button key={prompt} type="button" variant="outline" onClick={() => void submit({ text: prompt })} disabled={!model}
                      className="h-auto justify-start rounded-xl bg-white px-4 py-3 text-left text-sm font-normal text-[#444]">
                      {prompt}
                    </Button>
                  ))}
                </div>
              </div>
            </ConversationEmptyState>
          ) : messages.map((message) => (
            <Message key={message.id} from={message.role} className="max-w-full">
              <MessageContent className={cn("text-[15px] leading-7", message.role === "assistant" && "w-full") }>
                {message.role === "assistant" && message.status === "streaming" && !message.content ? (
                  <Reasoning isStreaming defaultOpen>
                    <ReasoningTrigger getThinkingMessage={() => <span>正在思考</span>} />
                    <ReasoningContent>{`正在按「${message.reasoningLabel ?? "自动"}」处理，本页只展示最终回答。`}</ReasoningContent>
                  </Reasoning>
                ) : null}
                {message.content ? <MessageResponse isAnimating={message.status === "streaming"}>{message.content}</MessageResponse> : null}
                {message.status === "error" ? (
                  <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-5 text-red-700">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{message.error}</span>
                  </div>
                ) : null}
              </MessageContent>
              {message.role === "assistant" ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-[11px] text-[#999]">{message.model} · {message.routeLabel} · {message.reasoningLabel}</p>
                  <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {message.content ? <MessageAction tooltip="复制回答" onClick={() => void copyToClipboard(message.content)}><Copy /></MessageAction> : null}
                  </MessageActions>
                </div>
              ) : null}
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton className="bottom-32" />
      </Conversation>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 border-t border-[#f2f2f2] bg-white/95 px-3 pb-3 pt-3 backdrop-blur-sm sm:px-6 sm:pb-5 sm:pt-4">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl">
          <PromptInput onSubmit={submit} className="rounded-2xl border-[#dedede] bg-white shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
            <PromptInputBody>
              <PromptInputTextarea placeholder={model ? `询问 ${model}` : "正在加载模型…"} disabled={!model || status === "submitted" || status === "streaming"}
                className="min-h-[62px] resize-none px-4 pt-3 text-base leading-6 sm:text-[15px]" />
            </PromptInputBody>
            <PromptInputFooter className="px-2.5 pb-2.5">
              <PromptInputTools className="min-w-0 gap-1">
                <ReasoningMenu value={reasoning} onChange={setReasoning} />
                <RoutingMenu route={effectiveRoute} onChange={setRoute} pools={compatiblePools} accounts={compatibleAccounts} />
                <FutureTool icon={Globe2} label="联网搜索" />
                <FutureTool icon={Blocks} label="MCP" />
              </PromptInputTools>
              <PromptInputSubmit status={status === "ready" ? undefined : status} onStop={stop} disabled={!model || (!messages.length && !options)}
                className="rounded-full bg-[#171717] text-white hover:bg-[#333]" />
            </PromptInputFooter>
          </PromptInput>
          <p className="mt-2 text-center text-[11px] text-[#999]">AI 可能会犯错，请核对重要信息</p>
        </div>
      </div>
    </div>
  )
}

function ModelMenu({ models, value, onChange, loading }: { models: string[]; value: string; onChange: (value: string) => void; loading: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="min-w-0 max-w-[250px] rounded-full px-2.5 text-sm font-semibold tracking-[-0.02em]">
          <Bot className="size-4 text-[#10a37f]" />
          <span className="truncate">{value || (loading ? "加载模型…" : "暂无模型")}</span><ChevronDown className="size-3.5 text-[#888]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[360px] w-[280px] overflow-y-auto">
        <DropdownMenuLabel>选择模型</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.map((item) => <DropdownMenuItem key={item} onSelect={() => onChange(item)} className="justify-between font-mono text-xs">
          <span className="truncate">{item}</span>{item === value ? <Check className="size-4 text-[#10a37f]" /> : null}
        </DropdownMenuItem>)}
        {!models.length ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有可用模型</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ReasoningMenu({ value, onChange }: { value: string; onChange: (value: (typeof reasoningOptions)[number]["value"]) => void }) {
  const selected = reasoningOptions.find((item) => item.value === value) ?? reasoningOptions[0]
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><PromptInputButton tooltip="设置思考等级" className="rounded-full px-2.5 text-xs"><BrainCircuit /> <span className="hidden sm:inline">{selected.label}</span></PromptInputButton></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-56">
      <DropdownMenuLabel>思考等级</DropdownMenuLabel><DropdownMenuSeparator />
      {reasoningOptions.map((item) => <DropdownMenuItem key={item.value} onSelect={() => onChange(item.value)} className="justify-between">
        <span><span className="block text-sm">{item.label}</span><span className="text-xs text-muted-foreground">{item.detail}</span></span>
        {item.value === value ? <Check className="text-[#10a37f]" /> : null}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>
}

function RoutingMenu({ route, onChange, pools, accounts }: {
  route: string
  onChange: (value: string) => void
  pools: ChatOptions["pools"]
  accounts: ChatOptions["accounts"]
}) {
  const label = route.startsWith("pool:") ? pools.find((pool) => `pool:${pool.type}` === route)?.label
    : route.startsWith("account:") ? accounts.find((account) => `account:${account.id}` === route)?.name : "自动调度"
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><PromptInputButton tooltip="选择调用路由" className="max-w-32 rounded-full px-2.5 text-xs"><Network /><span className="hidden max-w-20 truncate sm:inline">{label ?? "自动调度"}</span></PromptInputButton></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="max-h-[380px] w-72 overflow-y-auto">
      <DropdownMenuLabel>本次调用路由</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => onChange("auto")} className="justify-between">
        <span><span className="block">自动调度</span><span className="text-xs text-muted-foreground">在所有兼容账号中智能切换</span></span>{route === "auto" ? <Check className="text-[#10a37f]" /> : null}
      </DropdownMenuItem>
      <DropdownMenuSeparator /><DropdownMenuLabel>指定号池</DropdownMenuLabel>
      {pools.map((pool) => <DropdownMenuItem key={pool.type} onSelect={() => onChange(`pool:${pool.type}`)} className="justify-between">
        <span><span className="block">{pool.label}</span><span className="text-xs text-muted-foreground">{pool.readyAccounts} 个可用账号</span></span>{route === `pool:${pool.type}` ? <Check className="text-[#10a37f]" /> : null}
      </DropdownMenuItem>)}
      <DropdownMenuSeparator /><DropdownMenuLabel>指定账号</DropdownMenuLabel>
      {accounts.map((account) => <DropdownMenuItem key={account.id} onSelect={() => onChange(`account:${account.id}`)} className="justify-between">
        <span className="min-w-0"><span className="block truncate">{account.name}</span><span className="block truncate text-xs text-muted-foreground">{account.poolLabel}{account.email ? ` · ${account.email}` : ""}</span></span>{route === `account:${account.id}` ? <Check className="text-[#10a37f]" /> : null}
      </DropdownMenuItem>)}
      {!pools.length ? <p className="px-2 py-3 text-xs text-muted-foreground">当前模型没有兼容的可用号池</p> : null}
    </DropdownMenuContent>
  </DropdownMenu>
}

function FutureTool({ icon: Icon, label }: { icon: typeof Globe2; label: string }) {
  return <Tooltip>
    <TooltipTrigger asChild><span><PromptInputButton disabled tooltip={`${label}即将支持`} className="rounded-full px-2.5 text-xs"><Icon /><span className="hidden lg:inline">{label}</span><Badge variant="secondary" className="h-4 px-1 text-[9px]">Soon</Badge></PromptInputButton></span></TooltipTrigger>
    <TooltipContent>{label}扩展位已预留，后续接入</TooltipContent>
  </Tooltip>
}
