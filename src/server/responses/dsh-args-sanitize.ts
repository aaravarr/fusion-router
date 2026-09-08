/**
 * DSH（DeepSeek Harness）+ GPT 组合的 function_call 参数清洗。
 *
 * 背景：DSH 的 pwsh/edit/write 工具 JSON schema 里 `justification` 与
 * `sandbox_permissions` 是可选字段（仅用于沙箱拒绝后的一次性提权重试）。
 * GPT 模型在正常工具调用里多余地带上这两个属性，触发 DSH 的提权审批流
 *（审批被禁的会话里工具调用直接被拒），导致 DSH+GPT 组合工具调用异常。
 *
 * 范围（两个条件同时满足才处理）：
 * 1. 请求走 openai 池（Codex 原生直通路径）
 * 2. 入站请求 User-Agent 包含 deepseek（不区分大小写）
 *
 * 清洗内容：响应里 function_call 类型 output item 的 `arguments`
 *（JSON 字符串）解析后删除顶层 `justification` 与 `sandbox_permissions`
 * 两个 key，再序列化回去；解析失败则原样放行（防御性，绝不影响正常流量）。
 *
 * DSH 消费方式调研结论（决定 delta 原样透传，只改 done）：
 * - pi-ai `openai-responses-shared.js:541-548`：`response.function_call_arguments.delta`
 *   只做 `slot.block.partialJson += delta` + `pushToolCallDelta`（过程增量）；
 * - pi-ai `openai-responses-shared.js:603-618`：`response.output_item.done`
 *  （`item.type === "function_call"`）用 `parseStreamingJson(item.arguments)`
 *   生成最终 `toolCall.arguments` 并以 `toolcall_end` 发出；
 * - dsh-llm-pi-ai `lib/index.js:1446-1467`：`toolcall_delta` 转 `tool-call-delta`
 *  （`argumentsDelta`），`toolcall_end` 转 `block-end`（`arguments: JSON.stringify(...)`）；
 * - dsh-llm `assembler.js:54-72,94-96`：`tool-call-delta` 累积到
 *   `partial.toolCallArguments`，但 `block-end` 到达后 `assemble()` 直接返回
 *   `partial.block`（first close wins），即 done 的完整 item 覆盖 delta 累积；
 * - agent 执行 `dsh-agent-loop/lib/index.js:122-127` 用组装后 message 的
 *   `block.arguments` 调度工具。
 * 因此 DSH 最终执行参数读的是 done 事件的完整 arguments，delta 仅作
 * 中间累积/回放。网关侧 delta 原样透传，只改写 `output_item.done`、
 * `function_call_arguments.done`（完整快照，非增量）以及 completed 等终态
 * `response.output` 里的完整 item；增量流式完整保留。
 */

export const DSH_ARGS_SANITIZE_KEYS = ["justification", "sandbox_permissions"] as const
export type DshSanitizeKey = (typeof DSH_ARGS_SANITIZE_KEYS)[number]

/** transformSummary 观测标记。 */
export const DSH_ARGS_SANITIZE_TAG = "dsh-args-sanitize"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * 范围判定：openai 池 + UA 含 deepseek（不区分大小写）。
 * poolType 显式比较 "openai"，UA 缺失/非字符串一律 false（原样放行）。
 */
export function isDshSanitizeScope(poolType: unknown, userAgent: unknown): boolean {
  if (poolType !== "openai") return false
  if (typeof userAgent !== "string" || !userAgent) return false
  return userAgent.toLowerCase().includes("deepseek")
}

/**
 * 清洗单个 function_call arguments JSON 字符串。
 * - 解析失败 → null（原样放行，绝不抛错）；
 * - 解析后非普通对象 → null（数组等不动）；
 * - 无目标 key → null（调用方可据此判断“无变化”，避免无意义重写）；
 * - 命中 → 返回清洗后的序列化文本 + 去掉的 key 名。
 */
export function sanitizeFunctionCallArgumentsString(raw: string): { text: string; removed: string[] } | null {
  if (typeof raw !== "string" || !raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const removed: string[] = []
  for (const key of DSH_ARGS_SANITIZE_KEYS) {
    if (Object.hasOwn(parsed, key)) {
      removed.push(key)
      delete parsed[key]
    }
  }
  if (removed.length === 0) return null
  try {
    return { text: JSON.stringify(parsed), removed }
  } catch {
    return null
  }
}

/**
 * 清洗单个 output item（仅 `type === "function_call"` 且 `arguments` 为字符串时处理；
 * arguments 为对象形态时同样删除顶层目标 key，属防御性兼容）。
 * 返回去掉的 key 名（空数组 = 无变化），原地改写传入的 item。
 */
export function sanitizeFunctionCallItem(item: unknown): string[] {
  if (!isRecord(item)) return []
  if (String(item.type ?? "").toLowerCase() !== "function_call") return []
  const args = (item as Record<string, unknown>).arguments
  if (typeof args === "string") {
    const cleaned = sanitizeFunctionCallArgumentsString(args)
    if (!cleaned) return []
    ;(item as Record<string, unknown>).arguments = cleaned.text
    return cleaned.removed
  }
  if (isRecord(args)) {
    const removed: string[] = []
    for (const key of DSH_ARGS_SANITIZE_KEYS) {
      if (Object.hasOwn(args, key)) {
        removed.push(key)
        delete args[key]
      }
    }
    return removed
  }
  return []
}

/**
 * 清洗聚合后 responses 载荷的 output 数组（非流式 JSON 路径用）。
 * 支持顶层 `{ output: [...] }` 形态；非对象/无 output 时无变化。
 */
export function sanitizeResponsesPayload(payload: unknown): { sanitizedItems: number; removedKeys: string[] } {
  const removedKeys: string[] = []
  let sanitizedItems = 0
  if (!isRecord(payload)) return { sanitizedItems, removedKeys }
  const output = (payload as Record<string, unknown>).output
  if (!Array.isArray(output)) return { sanitizedItems, removedKeys }
  for (const item of output) {
    const removed = sanitizeFunctionCallItem(item)
    if (removed.length > 0) {
      sanitizedItems += 1
      removedKeys.push(...removed)
    }
  }
  return { sanitizedItems, removedKeys }
}

/**
 * 清洗单个 SSE data 事件对象：
 * - `response.output_item.done` / `response.output_item.added` 的 function_call item；
 * - `response.function_call_arguments.done` 的完整 `arguments`（快照，非增量 delta）；
 * - `response.completed` / `response.incomplete` / `response.failed` 终态
 *   `response.output` 里的完整 item。
 * `response.function_call_arguments.delta`（增量）故意不动，由调用方保证不传入。
 * 返回本事件去掉的 key 名（去重前）。
 */
export function sanitizeSseEventObject(obj: unknown): string[] {
  if (!isRecord(obj)) return []
  const removed: string[] = []
  const type = String(obj.type ?? "")

  if (type === "response.output_item.done" || type === "response.output_item.added") {
    const item = (obj as Record<string, unknown>).item
    removed.push(...sanitizeFunctionCallItem(item))
    return removed
  }

  if (type === "response.function_call_arguments.done") {
    const args = (obj as Record<string, unknown>).arguments
    if (typeof args === "string") {
      const cleaned = sanitizeFunctionCallArgumentsString(args)
      if (cleaned) {
        ;(obj as Record<string, unknown>).arguments = cleaned.text
        removed.push(...cleaned.removed)
      }
    } else if (isRecord(args)) {
      for (const key of DSH_ARGS_SANITIZE_KEYS) {
        if (Object.hasOwn(args, key)) {
          removed.push(key)
          delete args[key]
        }
      }
    }
    return removed
  }

  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = (obj as Record<string, unknown>).response
    if (isRecord(response)) {
      const nested = sanitizeResponsesPayload(response)
      removed.push(...nested.removedKeys)
    }
    return removed
  }

  return removed
}

/**
 * 清洗整段 SSE 文本（Codex 无头 LF 与标准 \\n\\n 分帧通用）：
 * 逐 `data:` 行解析 JSON，命中则重写该行载荷；`[DONE]`/空行/注释行/非法 JSON
 * 原样放行。`response.function_call_arguments.delta` 行显式跳过（增量透传）。
 * 多 `data:` 行拼接的事件（非 Codex 主流形态）按行独立解析，失败即放行，
 * 绝不影响正常流量。
 */
export function sanitizeSseText(rawText: string): { text: string; sanitizedEvents: number; removedKeys: string[] } {
  const removedKeys: string[] = []
  let sanitizedEvents = 0
  if (!rawText || !rawText.includes("data:")) return { text: rawText, sanitizedEvents, removedKeys }
  let dirty = false
  const lines = rawText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trimStart()
    if (!payload || payload === "[DONE]") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    // 增量 delta 原样透传：DSH 靠 done 的完整 item 做最终参数。
    if (String(parsed.type ?? "") === "response.function_call_arguments.delta") continue
    const removed = sanitizeSseEventObject(parsed)
    if (removed.length === 0) continue
    sanitizedEvents += 1
    removedKeys.push(...removed)
    try {
      lines[i] = "data: " + JSON.stringify(parsed)
      dirty = true
    } catch {
      // 序列化失败则还原该行（防御性，不炸流）
      lines[i] = line
      sanitizedEvents -= 1
    }
  }
  if (!dirty) return { text: rawText, sanitizedEvents: 0, removedKeys: [] }
  return { text: lines.join("\n"), sanitizedEvents, removedKeys }
}

export interface IncrementalSseSanitizeResult {
  sanitizedEvents: number
  removedKeys: string[]
}

/**
 * 创建按行处理的 SSE 清洗流。完整 data 行才会被解析，跨 chunk 的半行留在
 * buffer 中；除目标 done/终态事件外，其余字节（包括 delta、非法 JSON 和行尾）
 * 原样透传。这样无头 Codex SSE 可以在上游仍未结束时持续送达客户端。
 */
export function createIncrementalSseSanitizer(
  onSanitized?: (result: IncrementalSseSanitizeResult) => void,
): { stream: TransformStream<Uint8Array, Uint8Array>; result: () => IncrementalSseSanitizeResult } {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let sanitizedEvents = 0
  const removedKeys: string[] = []

  const processLine = (lineWithEnding: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const ending = lineWithEnding.endsWith("\r\n") ? "\r\n" : lineWithEnding.endsWith("\n") ? "\n" : ""
    const line = ending ? lineWithEnding.slice(0, -ending.length) : lineWithEnding
    if (!line.startsWith("data:")) {
      controller.enqueue(encoder.encode(lineWithEnding))
      return
    }
    const payload = line.slice(5).trimStart()
    if (!payload || payload === "[DONE]") {
      controller.enqueue(encoder.encode(lineWithEnding))
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch {
      controller.enqueue(encoder.encode(lineWithEnding))
      return
    }
    const type = String((parsed as Record<string, unknown> | null)?.type ?? "")
    if (!isRecord(parsed) || type === "response.function_call_arguments.delta" || type === "response.output_item.added") {
      controller.enqueue(encoder.encode(lineWithEnding))
      return
    }
    const removed = sanitizeSseEventObject(parsed)
    if (removed.length === 0) {
      controller.enqueue(encoder.encode(lineWithEnding))
      return
    }
    try {
      const rewritten = `data: ${JSON.stringify(parsed)}${ending}`
      controller.enqueue(encoder.encode(rewritten))
      sanitizedEvents += 1
      removedKeys.push(...removed)
      onSanitized?.({ sanitizedEvents, removedKeys: [...removedKeys] })
    } catch {
      // 序列化失败时保留原始字节，不能让清洗影响正常流量。
      controller.enqueue(encoder.encode(lineWithEnding))
    }
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const match = /\r?\n/.exec(buffer)
        if (!match || match.index == null) break
        const end = match.index + match[0].length
        processLine(buffer.slice(0, end), controller)
        buffer = buffer.slice(end)
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) processLine(buffer, controller)
      buffer = ""
    },
  })
  return {
    stream,
    result: () => ({ sanitizedEvents, removedKeys: [...removedKeys] }),
  }
}

/** transformSummary 追加观测标记（幂等）。 */
export function withDshSanitizeTag(transformSummary: unknown): string {
  const parts = String(transformSummary || "").split(" | ").filter(Boolean)
  if (!parts.some((p) => p === DSH_ARGS_SANITIZE_TAG)) parts.push(DSH_ARGS_SANITIZE_TAG)
  return parts.join(" | ")
}
