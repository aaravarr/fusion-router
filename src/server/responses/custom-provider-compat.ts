type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => Boolean(value && typeof value === "object" && !Array.isArray(value))

export function chatRequestToResponses(body: unknown): Obj {
  if (!isObj(body)) return {}
  const result: Obj = {}
  for (const key of ["model", "stream", "temperature", "top_p", "metadata", "store", "user", "parallel_tool_calls", "tool_choice"]) {
    if (body[key] !== undefined) result[key] = body[key]
  }
  if (body.max_completion_tokens !== undefined) result.max_output_tokens = body.max_completion_tokens
  else if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens
  if (typeof body.reasoning_effort === "string") result.reasoning = { effort: body.reasoning_effort }
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map((tool) => {
      if (!isObj(tool) || tool.type !== "function" || !isObj(tool.function)) return tool
      return { type: "function", ...tool.function }
    })
  }
  const input: unknown[] = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(message)) continue
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") })
      continue
    }
    const base: Obj = { role: message.role, content: message.content ?? "" }
    input.push(base)
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isObj(call) || !isObj(call.function)) continue
        input.push({ type: "function_call", id: call.id, call_id: call.id, name: call.function.name, arguments: call.function.arguments ?? "{}" })
      }
    }
  }
  result.input = input
  return result
}

function responseOutput(payload: Obj): { content: string | null; reasoning: string | null; toolCalls: Obj[] } {
  let content = ""
  let reasoning = ""
  const toolCalls: Obj[] = []
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!isObj(item)) continue
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (isObj(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") content += part.text
      }
    } else if (item.type === "reasoning") {
      for (const part of [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]) {
        if (isObj(part) && typeof part.text === "string") reasoning += part.text
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } })
    }
  }
  return { content: content || null, reasoning: reasoning || null, toolCalls }
}

export function responsesJsonToChatCompletion(payload: unknown): Obj {
  if (!isObj(payload)) return { id: "", object: "chat.completion", choices: [] }
  const output = responseOutput(payload)
  const usage = isObj(payload.usage) ? {
    prompt_tokens: Number(payload.usage.input_tokens ?? 0),
    completion_tokens: Number(payload.usage.output_tokens ?? 0),
    total_tokens: Number(payload.usage.total_tokens ?? Number(payload.usage.input_tokens ?? 0) + Number(payload.usage.output_tokens ?? 0)),
  } : undefined
  return {
    id: payload.id ?? "", object: "chat.completion", created: payload.created_at ?? Math.floor(Date.now() / 1000), model: payload.model,
    choices: [{ index: 0, message: { role: "assistant", content: output.content, ...(output.reasoning ? { reasoning_content: output.reasoning } : {}), ...(output.toolCalls.length ? { tool_calls: output.toolCalls } : {}) }, finish_reason: output.toolCalls.length ? "tool_calls" : "stop" }],
    ...(usage ? { usage } : {}),
  }
}

function chatChunk(data: Obj, state: { id: string; model?: unknown; created: number }): Obj | null {
  const type = String(data.type ?? "")
  const base = { id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model }
  if (type === "response.created" && isObj(data.response)) {
    state.id = String(data.response.id ?? state.id); state.model = data.response.model ?? state.model
    return { ...base, id: state.id, model: state.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }
  }
  if (type === "response.output_text.delta" && typeof data.delta === "string") return { ...base, choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }] }
  if (type.includes("reasoning") && type.endsWith(".delta") && typeof data.delta === "string") return { ...base, choices: [{ index: 0, delta: { reasoning_content: data.delta }, finish_reason: null }] }
  if (type === "response.output_item.added" && isObj(data.item) && data.item.type === "function_call") return { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: Number(data.output_index ?? 0), id: data.item.call_id ?? data.item.id, type: "function", function: { name: data.item.name, arguments: "" } }] }, finish_reason: null }] }
  if (type === "response.function_call_arguments.delta" && typeof data.delta === "string") return { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: Number(data.output_index ?? 0), function: { arguments: data.delta } }] }, finish_reason: null }] }
  if (type === "response.completed") {
    const response = isObj(data.response) ? data.response : {}
    const hasTools = responseOutput(response).toolCalls.length > 0
    const usage = isObj(response.usage) ? { prompt_tokens: Number(response.usage.input_tokens ?? 0), completion_tokens: Number(response.usage.output_tokens ?? 0), total_tokens: Number(response.usage.total_tokens ?? 0) } : undefined
    return { ...base, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }], ...(usage ? { usage } : {}) }
  }
  return null
}

export function responsesSseToChatStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder(); const encoder = new TextEncoder()
  let buffer = ""; const state = { id: "", model: undefined as unknown, created: Math.floor(Date.now() / 1000) }
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? ""
      for (const event of events) {
        const raw = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
        if (!raw || raw === "[DONE]") continue
        try { const converted = chatChunk(JSON.parse(raw) as Obj, state); if (converted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n\n`)) } catch { /* skip malformed event */ }
      }
    },
    flush(controller) { controller.enqueue(encoder.encode("data: [DONE]\n\n")) },
  }))
}
