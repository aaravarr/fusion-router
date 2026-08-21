/**
 * chat-stream-mapper.ts
 *
 * 数据结构转换层：把后端 SSE 事件里的 tool_calls 结构转换成聊天页可渲染的
 * ToolGroup/工具卡模型。本文件只做「结构转换」，不伪造任何工具数据——
 * 没有 tool_calls 的消息照常渲染文本；工具状态（running/ok/error/stopped）
 * 完全由流生命周期与上游事件推导。
 */

export type ToolState = "running" | "ok" | "error" | "stopped"
export type ToolVariant = "bash" | "read" | "search" | "write" | "edit" | "code" | "other"
export type RenderIntent = "io" | "read" | "diff"

export interface DiffLine {
  type: "add" | "del" | "ctx"
  oldLine?: number
  newLine?: number
  text: string
}

export interface DiffHunk {
  header: string
  rows: DiffLine[]
}

export interface ChatToolCall {
  id: string
  name: string
  variant: ToolVariant
  title: string
  summary: string
  state: ToolState
  arguments: string
  filePath?: string
  meta?: string
  output?: string
  error?: string
  renderIntent: RenderIntent
  readLines?: string[]
  diffHunks?: DiffHunk[]
  startedAt?: number
  completedAt?: number
}

const TOOL_VARIANTS: Record<string, ToolVariant> = {
  bash: "bash", sh: "bash", shell: "bash", pwsh: "bash", powershell: "bash",
  run_command: "bash", execute_command: "bash", terminal: "bash", exec: "bash",
  read: "read", read_file: "read", read_files: "read", read_lints: "read",
  cat: "read", web_fetch: "read", fetch_url: "read", http_get: "read",
  search: "search", grep: "search", glob: "search", rg: "search", find: "search",
  web_search: "search", list_files: "search", list_dir: "search", ls: "search",
  write: "write", write_file: "write", write_to_file: "write", create_file: "write",
  new_file: "write", touch: "write",
  edit: "edit", edit_file: "edit", replace_in_file: "edit", apply_patch: "edit",
  multi_edit: "edit", patch: "edit", update_file: "edit", insert: "edit",
  run_code: "code", execute: "code", python: "code", node: "code", code: "code",
  evaluate: "code", run: "code", task: "code", subagent: "code", agent: "code",
}

const VARIANT_TITLES: Record<ToolVariant, string> = {
  bash: "Bash",
  read: "Read",
  search: "Search",
  write: "Write",
  edit: "Edit",
  code: "Code",
  other: "Tool",
}

const SUMMARY_KEYS: Record<ToolVariant, string[]> = {
  bash: ["command", "description"],
  read: ["path", "file_path", "filePath", "url", "relative_path"],
  search: ["pattern", "query", "path", "file_path", "url", "glob"],
  write: ["path", "file_path", "filePath", "relative_path"],
  edit: ["path", "file_path", "filePath", "relative_path"],
  code: ["description", "language", "command"],
  other: ["path", "file_path", "query", "pattern", "command", "description"],
}

export function deriveToolVariant(name: string): ToolVariant {
  const trimmed = name.trim()
  const normalized = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
  return TOOL_VARIANTS[normalized] ?? TOOL_VARIANTS[trimmed.toLowerCase()] ?? TOOL_VARIANTS[trimmed] ?? "other"
}

export function toolTitle(variant: ToolVariant): string {
  return VARIANT_TITLES[variant]
}

export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw !== "string") return typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function pickString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function asString(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

export function summarizeToolCall(name: string, rawArguments: string): string {
  const variant = deriveToolVariant(name)
  const args = parseToolArguments(rawArguments)
  const primary = pickString(args, SUMMARY_KEYS[variant])

  if (variant === "bash") {
    const cmd = primary || asString(args.command ?? args.description ?? "")
    return truncate(cmd || name, 96)
  }
  if (variant === "read") {
    const lines = readLineCount(args)
    return primary ? (lines ? primary + " · " + lines + " 行" : primary) : name
  }
  if (variant === "search") {
    const hits = readHitCount(args)
    const label = primary ? (args.pattern || args.query ? "pattern: " + primary : primary) : name
    return hits ? label + " · " + hits + " 处命中" : label
  }
  if (variant === "write" || variant === "edit") {
    return primary || name
  }
  if (variant === "code") {
    const desc = primary || asString(args.language ?? "")
    return desc ? truncate(desc, 96) : name
  }
  return primary || name
}

function readLineCount(args: Record<string, unknown>): number | null {
  const value = args.totalLines ?? args.line_count ?? args.lines ?? args.total_lines
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  return null
}

function readHitCount(args: Record<string, unknown>): number | null {
  const value = args.match_count ?? args.hits ?? args.count ?? args.total ?? args.num_results
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  return null
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

export function extractFilePath(name: string, rawArguments: string): string {
  const variant = deriveToolVariant(name)
  if (variant !== "read" && variant !== "write" && variant !== "edit") return ""
  const args = parseToolArguments(rawArguments)
  return pickString(args, ["path", "file_path", "filePath", "relative_path"])
}

export function extractMeta(name: string, rawArguments: string): string {
  const args = parseToolArguments(rawArguments)
  const variant = deriveToolVariant(name)
  if (variant === "read") {
    const lines = readLineCount(args)
    const lang = asString(args.language ?? "").trim()
    const parts: string[] = []
    if (lines) parts.push(lines + " 行")
    if (lang) parts.push(lang)
    return parts.join(" · ")
  }
  return ""
}

export function detectRenderIntent(name: string, output?: string): RenderIntent {
  if (output && looksLikeDiff(output)) return "diff"
  if (deriveToolVariant(name) === "read" && output && looksLikeNumberedCode(output)) return "read"
  return "io"
}

function looksLikeDiff(output: string): boolean {
  const head = output.slice(0, 400)
  return /(^|\n)(diff --git |@@ |--- |\+\+\+ )/.test(head) && /(^|\n)[+-]/.test(output)
}

function looksLikeNumberedCode(output: string): boolean {
  const head = output.slice(0, 400)
  return /(^|\n)\s*\d+\s*[|│:]\s*/.test(head)
}

export function parseUnifiedDiff(output: string): DiffHunk[] {
  if (!output) return []
  const lines = output.split("\n")
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    if (line.startsWith("@@")) {
      current = { header: line, rows: [] }
      hunks.push(current)
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldLine = match ? Number(match[1]) : 0
      newLine = match ? Number(match[2]) : 0
      continue
    }
    if (!current) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.rows.push({ type: "add", newLine: newLine++, text: line.slice(1) })
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.rows.push({ type: "del", oldLine: oldLine++, text: line.slice(1) })
    } else if (line.startsWith(" ")) {
      current.rows.push({ type: "ctx", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) })
    }
  }
  return hunks
}

export function parseReadLines(output: string): string[] {
  if (!output) return []
  return output.split("\n").map((line) => line.replace(/\r$/, "")).slice(0, 200)
}

function buildToolCall(input: {
  id: string
  name: string
  arguments: string
  output?: string
  error?: string
  state: ToolState
  now?: number
}): ChatToolCall {
  const variant = deriveToolVariant(input.name)
  const renderIntent = detectRenderIntent(input.name, input.output)
  const call: ChatToolCall = {
    id: input.id,
    name: input.name,
    variant,
    title: toolTitle(variant),
    summary: summarizeToolCall(input.name, input.arguments),
    state: input.state,
    arguments: input.arguments,
    renderIntent,
    startedAt: input.now,
  }
  const filePath = extractFilePath(input.name, input.arguments)
  if (filePath) call.filePath = filePath
  const meta = extractMeta(input.name, input.arguments)
  if (meta) call.meta = meta
  if (input.output !== undefined) {
    call.output = input.output
    if (renderIntent === "read") call.readLines = parseReadLines(input.output)
    if (renderIntent === "diff") call.diffHunks = parseUnifiedDiff(input.output)
  }
  if (input.error) call.error = input.error
  return call
}

interface ChatDeltaBuffer {
  id: string
  name: string
  arguments: string
}

export interface ChatStreamState {
  content: string
  reasoning: string
  toolCalls: ChatToolCall[]
  deltaBuffer: Map<number, ChatDeltaBuffer>
}

export function createChatStreamState(): ChatStreamState {
  return { content: "", reasoning: "", toolCalls: [], deltaBuffer: new Map() }
}

function normalizeFunctionName(name: unknown): string {
  return typeof name === "string" && name.trim() ? name.trim() : "unknown"
}

function normalizeArguments(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

export function extractStreamError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>
  if (typeof p.error === "string") return p.error
  if (p.error && typeof p.error === "object") {
    const e = p.error as Record<string, unknown>
    if (typeof e.message === "string") return e.message
  }
  if (typeof p.message === "string" && p.type === "error") return p.message
  return null
}

export function reduceChatStreamEvent(state: ChatStreamState, payload: unknown): ChatStreamState {
  if (!payload || typeof payload !== "object") return state
  const p = payload as Record<string, unknown>
  const type = typeof p.type === "string" ? p.type : ""

  if (type === "response.output_text.delta" && typeof p.delta === "string") {
    return { ...state, content: state.content + p.delta }
  }
  if (type.includes("reasoning") && type.endsWith(".delta") && typeof p.delta === "string") {
    return { ...state, reasoning: state.reasoning + p.delta }
  }
  if (type === "response.output_item.added") {
    const item = asRecord(p.item)
    if (item && item.type === "function_call") {
      const id = asString(item.id || item.call_id || ("fc-" + state.toolCalls.length))
      if (!state.toolCalls.some((call) => call.id === id)) {
        const call = buildToolCall({
          id,
          name: normalizeFunctionName(item.name),
          arguments: normalizeArguments(item.arguments),
          state: "running",
          now: Date.now(),
        })
        return { ...state, toolCalls: [...state.toolCalls, call] }
      }
    }
    return state
  }
  if (type === "response.function_call_arguments.delta" && typeof p.delta === "string") {
    const id = asString(p.item_id)
    return {
      ...state,
      toolCalls: state.toolCalls.map((call) => call.id === id
        ? { ...call, arguments: call.arguments + p.delta, summary: summarizeToolCall(call.name, call.arguments + p.delta) }
        : call),
    }
  }
  if (type === "response.output_item.done") {
    const item = asRecord(p.item)
    if (item && item.type === "function_call") {
      const id = asString(item.id || item.call_id)
      const rawArgs = normalizeArguments(item.arguments)
      const output = typeof item.output === "string" ? item.output : item.output !== undefined ? JSON.stringify(item.output) : undefined
      const error = typeof item.error === "string" ? item.error : undefined
      const failed = item.status === "incomplete" || item.status === "failed"
      return {
        ...state,
        toolCalls: state.toolCalls.map((call) => call.id === id
          ? { ...buildToolCall({ id, name: call.name, arguments: rawArgs || call.arguments, output, error, state: error || failed ? "error" : "ok", now: call.startedAt }), completedAt: Date.now() }
          : call),
      }
    }
    return state
  }

  const choices = Array.isArray(p.choices) ? (p.choices as Array<Record<string, unknown>>) : []
  const choice = choices[0] ?? {}
  const part = asRecord(choice.delta) ?? asRecord(choice.message)
  if (!part) return state

  let next = state
  if (typeof part.content === "string") next = { ...next, content: next.content + part.content }
  const reasoningPart = [part.reasoning_content, part.reasoning, part.thinking].find((value): value is string => typeof value === "string")
  if (reasoningPart) next = { ...next, reasoning: next.reasoning + reasoningPart }

  const toolCallsDelta = part.tool_calls
  if (Array.isArray(toolCallsDelta)) {
    for (const delta of toolCallsDelta) {
      next = applyChatToolCallDelta(next, delta)
    }
  }
  return next
}

function applyChatToolCallDelta(state: ChatStreamState, delta: unknown): ChatStreamState {
  if (!delta || typeof delta !== "object") return state
  const d = delta as Record<string, unknown>
  const index = typeof d.index === "number" ? d.index : state.deltaBuffer.size
  const existing = state.deltaBuffer.get(index)
  const id = asString(d.id || existing?.id || ("call-" + index))
  const fn = asRecord(d.function)
  const name = typeof fn?.name === "string" ? fn.name : existing?.name ?? ""
  const argsDelta = typeof fn?.arguments === "string" ? fn.arguments : ""

  const buffer: ChatDeltaBuffer = {
    id,
    name: name || existing?.name || "unknown",
    arguments: (existing?.arguments ?? "") + argsDelta,
  }
  const newBuffer = new Map(state.deltaBuffer)
  newBuffer.set(index, buffer)

  const updated = state.toolCalls.some((call) => call.id === id)
  const toolCalls = updated
    ? state.toolCalls.map((call) => call.id === id
      ? { ...call, name: buffer.name, arguments: buffer.arguments, summary: summarizeToolCall(buffer.name, buffer.arguments) }
      : call)
    : [...state.toolCalls, buildToolCall({ id, name: buffer.name, arguments: buffer.arguments, state: "running", now: Date.now() })]

  return { ...state, deltaBuffer: newBuffer, toolCalls }
}

export function finalizeStreamState(state: ChatStreamState): ChatStreamState {
  return {
    ...state,
    toolCalls: state.toolCalls.map((call) => call.state === "running" ? { ...call, state: "stopped" as ToolState, completedAt: Date.now() } : call),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

