/**
 * Anthropic Messages ↔ OpenAI Chat Completions 转换层。
 *
 * 只实现网关需要的方向：
 * - 请求：messages → chat（messages→responses 复用本转换再接 chat→responses）
 * - 响应：chat → messages（JSON 一次性 + SSE 流式）
 *
 * 无法映射的高级字段（thinking、betadata 等）静默丢弃，不报错。
 */

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => Boolean(value && typeof value === "object" && !Array.isArray(value))

// ── 请求：messages → chat ────────────────────────────────────────────────

function imageBlockToChatPart(block: Obj): Obj | null {
  const source = isObj(block.source) ? block.source : null
  if (!source) return null
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png"
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } }
  }
  return null
}

function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  const parts: string[] = []
  for (const block of content) {
    if (isObj(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  return parts.join("\n")
}

function convertToolChoice(toolChoice: unknown): unknown {
  if (!isObj(toolChoice)) return toolChoice
  const type = String(toolChoice.type ?? "")
  if (type === "auto") return "auto"
  if (type === "any") return "required"
  if (type === "none") return "none"
  if (type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } }
  }
  return undefined
}

function convertTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const converted: unknown[] = []
  for (const tool of tools) {
    if (!isObj(tool) || typeof tool.name !== "string") continue
    converted.push({
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: isObj(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      },
    })
  }
  return converted.length ? converted : undefined
}

/** Anthropic /v1/messages 请求体 → OpenAI chat/completions 请求体。 */
export function messagesRequestToChat(body: unknown): Obj {
  if (!isObj(body)) return {}
  const result: Obj = {}
  if (body.model !== undefined) result.model = body.model
  if (body.stream !== undefined) result.stream = body.stream
  // 流式 chat 上游默认不回 usage；注入 include_usage 保证日志与 usage 透传。
  if (body.stream === true) result.stream_options = { include_usage: true }
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences

  const tools = convertTools(body.tools)
  if (tools) result.tools = tools
  const toolChoice = convertToolChoice(body.tool_choice)
  if (toolChoice !== undefined) result.tool_choice = toolChoice

  const messages: Obj[] = []
  // system：string 或 content block 数组 → system role message
  if (typeof body.system === "string" && body.system) {
    messages.push({ role: "system", content: body.system })
  } else if (Array.isArray(body.system)) {
    const text = body.system.map((block) => isObj(block) && block.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n")
    if (text) messages.push({ role: "system", content: text })
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(message)) continue
    const role = message.role === "assistant" ? "assistant" : "user"
    const content = message.content
    if (typeof content === "string") {
      messages.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) continue

    if (role === "assistant") {
      let text = ""
      const toolCalls: Obj[] = []
      for (const block of content) {
        if (!isObj(block)) continue
        if (block.type === "text" && typeof block.text === "string") text += block.text
        else if (block.type === "tool_use" && typeof block.name === "string") {
          toolCalls.push({
            id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(isObj(block.input) ? block.input : {}) },
          })
        }
      }
      messages.push({ role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }

    // user：text/image 聚合为 content parts；tool_result 拆成独立 role:tool 消息。
    let parts: Obj[] = []
    const flushParts = () => {
      if (!parts.length) return
      messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts })
      parts = []
    }
    for (const block of content) {
      if (!isObj(block)) continue
      if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text })
      else if (block.type === "image") {
        const part = imageBlockToChatPart(block)
        if (part) parts.push(part)
      } else if (block.type === "tool_result") {
        flushParts()
        messages.push({
          role: "tool",
          tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: toolResultContentToString(block.content),
        })
      }
    }
    flushParts()
  }
  result.messages = messages
  return result
}

// ── 响应：chat JSON → messages JSON ──────────────────────────────────────

export function chatFinishReasonToStopReason(finishReason: unknown): string {
  const reason = String(finishReason ?? "")
  if (reason === "stop") return "end_turn"
  if (reason === "length") return "max_tokens"
  if (reason === "tool_calls" || reason === "function_call") return "tool_use"
  if (reason === "content_filter") return "refusal"
  return "end_turn"
}

function chatUsageToMessagesUsage(usage: unknown): Obj {
  const source = isObj(usage) ? usage : {}
  const result: Obj = {
    input_tokens: Number(source.prompt_tokens ?? 0),
    output_tokens: Number(source.completion_tokens ?? 0),
  }
  const details = isObj(source.prompt_tokens_details) ? source.prompt_tokens_details : null
  const cached = Number(details?.cached_tokens ?? 0)
  if (cached > 0) result.cache_read_input_tokens = cached
  return result
}

function normalizeMessageId(id: unknown): string {
  const raw = typeof id === "string" && id ? id : ""
  if (raw.startsWith("msg_")) return raw
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "")
  return `msg_${cleaned || Math.random().toString(36).slice(2)}`
}

/** OpenAI chat.completion JSON → Anthropic message JSON。 */
export function chatJsonToMessages(payload: unknown): Obj {
  if (!isObj(payload)) {
    return { id: normalizeMessageId(null), type: "message", role: "assistant", model: "", content: [{ type: "text", text: "" }], stop_reason: "end_turn", stop_sequence: null }
  }
  const choice = Array.isArray(payload.choices) && isObj(payload.choices[0]) ? payload.choices[0] : {}
  const message = isObj(choice.message) ? choice.message : {}
  const content: Obj[] = []
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content })
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isObj(call) || !isObj(call.function)) continue
    let input: unknown = {}
    try { input = JSON.parse(typeof call.function.arguments === "string" ? call.function.arguments : "{}") } catch { /* keep {} */ }
    content.push({ type: "tool_use", id: typeof call.id === "string" ? call.id : `toolu_${content.length}`, name: call.function.name ?? "", input: isObj(input) ? input : {} })
  }
  if (!content.length) content.push({ type: "text", text: "" })
  return {
    id: normalizeMessageId(payload.id),
    type: "message",
    role: "assistant",
    model: payload.model,
    content,
    stop_reason: chatFinishReasonToStopReason(choice.finish_reason),
    stop_sequence: null,
    ...(payload.usage ? { usage: chatUsageToMessagesUsage(payload.usage) } : {}),
  }
}

// ── 响应：chat SSE → messages SSE ────────────────────────────────────────

type SseController = TransformStreamDefaultController<Uint8Array>

/** chat/completions SSE 流 → Anthropic Messages 事件流。 */
export function chatSseToMessagesStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let started = false
  let finished = false
  let openBlock: { type: "text" | "tool_use"; index: number } | null = null
  let nextBlockIndex = 0
  const toolBlocks = new Map<number, number>()
  const state = { id: "", model: "" }
  // OpenAI 在 stream_options.include_usage 下把 usage 放在 finish_reason 之后
  // 的独立块里。message_delta 必须等两者齐了就绪（或流结束）再发，否则 usage
  // 会被丢成全零。
  let pendingFinishReason: unknown = null
  let hasPendingFinish = false
  let pendingUsage: unknown = undefined

  const emit = (controller: SseController, event: Obj) => {
    controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`))
  }

  const ensureStart = (controller: SseController, data: Obj) => {
    if (!state.id && typeof data.id === "string") state.id = normalizeMessageId(data.id)
    if (!state.model && typeof data.model === "string") state.model = data.model
    if (started) return
    started = true
    if (!state.id) state.id = normalizeMessageId(null)
    emit(controller, {
      type: "message_start",
      message: {
        id: state.id, type: "message", role: "assistant", model: state.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const closeBlock = (controller: SseController) => {
    if (!openBlock) return
    emit(controller, { type: "content_block_stop", index: openBlock.index })
    openBlock = null
  }

  const openTextBlock = (controller: SseController) => {
    if (openBlock?.type === "text") return
    closeBlock(controller)
    openBlock = { type: "text", index: nextBlockIndex++ }
    emit(controller, { type: "content_block_start", index: openBlock.index, content_block: { type: "text", text: "" } })
  }

  const openToolBlock = (controller: SseController, call: Obj, callIndex: number) => {
    closeBlock(controller)
    const fn = isObj(call.function) ? call.function : {}
    openBlock = { type: "tool_use", index: nextBlockIndex++ }
    toolBlocks.set(callIndex, openBlock.index)
    emit(controller, {
      type: "content_block_start",
      index: openBlock.index,
      content_block: {
        type: "tool_use",
        id: typeof call.id === "string" ? call.id : `toolu_${callIndex}`,
        name: typeof fn.name === "string" ? fn.name : "",
        input: {},
      },
    })
  }

  const finish = (controller: SseController, finishReason: unknown, usage: unknown) => {
    if (finished) return
    finished = true
    closeBlock(controller)
    emit(controller, {
      type: "message_delta",
      delta: { stop_reason: chatFinishReasonToStopReason(finishReason), stop_sequence: null },
      usage: chatUsageToMessagesUsage(usage),
    })
    emit(controller, { type: "message_stop" })
  }

  const maybeFinish = (controller: SseController) => {
    if (finished || (!hasPendingFinish && pendingUsage === undefined)) return
    // 收到 finish_reason 后仍等一个事件序位置拿 usage；真正收尾由 flush 兜底。
    if (hasPendingFinish && pendingUsage !== undefined) finish(controller, pendingFinishReason, pendingUsage)
  }

  const handleChunk = (controller: SseController, data: Obj) => {
    ensureStart(controller, data)
    const choice = Array.isArray(data.choices) && isObj(data.choices[0]) ? data.choices[0] : null
    const delta = choice && isObj(choice.delta) ? choice.delta : {}
    if (typeof delta.content === "string" && delta.content) {
      openTextBlock(controller)
      emit(controller, { type: "content_block_delta", index: openBlock!.index, delta: { type: "text_delta", text: delta.content } })
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isObj(call)) continue
      const callIndex = Number.isInteger(Number(call.index)) ? Number(call.index) : toolBlocks.size
      let blockIndex = toolBlocks.get(callIndex)
      if (blockIndex === undefined) {
        openToolBlock(controller, call, callIndex)
        blockIndex = openBlock!.index
      } else if (openBlock?.index !== blockIndex) {
        closeBlock(controller)
        openBlock = { type: "tool_use", index: blockIndex }
      }
      const fn = isObj(call.function) ? call.function : {}
      if (typeof fn.arguments === "string" && fn.arguments) {
        emit(controller, { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: fn.arguments } })
      }
    }
    if (choice?.finish_reason != null) { pendingFinishReason = choice.finish_reason; hasPendingFinish = true }
    if (isObj(data.usage)) pendingUsage = data.usage
    maybeFinish(controller)
  }

  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ""
      for (const event of events) {
        const raw = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
        if (!raw || raw === "[DONE]") continue
        try { handleChunk(controller, JSON.parse(raw) as Obj) } catch { /* skip malformed event */ }
      }
    },
    flush(controller) {
      if (started && !finished) finish(controller, hasPendingFinish ? pendingFinishReason : "stop", pendingUsage)
    },
  }))
}
