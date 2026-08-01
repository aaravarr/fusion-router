/**
 * OpenCode Go's /v1/responses stream is incomplete: it emits only
 * output_text.delta plus chat-shaped trailing chunks, with no Responses
 * lifecycle events (created / output_item.added / completed). Codex clients
 * wait for those events, so rebuild a minimal lifecycle around the deltas.
 */

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

export function normalizeOpenCodeGoResponsesSse(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""

  let started = false
  let responseId = "resp_opencode_go"
  let responseModel = ""
  let outputIndex = 0
  let reasoningAdded = false
  let reasoningDone = false
  let reasoningText = ""
  let reasoningItemId = ""
  let reasoningIndex = 0
  let messageAdded = false
  let messageDone = false
  let messageItemId = ""
  let messageIndex = 0
  let text = ""
  let completedSeen = false
  let doneSeen = false
  let usage: Obj | undefined
  const outputItems: Obj[] = []

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, type: string, data: Obj) => {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
  }

  const ensureStarted = (controller: ReadableStreamDefaultController<Uint8Array>, model?: unknown, id?: unknown) => {
    if (started) return
    started = true
    if (typeof id === "string" && id.trim()) responseId = id.trim()
    if (typeof model === "string" && model.trim()) responseModel = model.trim()
    const response: Obj = {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: responseModel,
      status: "in_progress",
      output: [],
    }
    emit(controller, "response.created", { type: "response.created", response, sequence_number: 1 })
    emit(controller, "response.in_progress", { type: "response.in_progress", response, sequence_number: 2 })
  }

  const ensureReasoning = (controller: ReadableStreamDefaultController<Uint8Array>, itemIdRaw?: unknown) => {
    if (reasoningAdded) return
    reasoningAdded = true
    reasoningItemId = typeof itemIdRaw === "string" && itemIdRaw.trim() ? itemIdRaw.trim() : "reasoning_" + responseId
    reasoningIndex = outputIndex++
    emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: reasoningIndex,
      item: { id: reasoningItemId, type: "reasoning", status: "in_progress", summary: [] },
      sequence_number: 3,
    })
    emit(controller, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: reasoningItemId,
      output_index: reasoningIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
      sequence_number: 4,
    })
  }

  const ensureMessage = (controller: ReadableStreamDefaultController<Uint8Array>, itemIdRaw?: unknown) => {
    if (messageAdded) return
    messageAdded = true
    messageItemId = typeof itemIdRaw === "string" && itemIdRaw.trim() ? itemIdRaw.trim() : "msg_" + responseId
    messageIndex = outputIndex++
    emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: messageIndex,
      item: { id: messageItemId, type: "message", role: "assistant", status: "in_progress", content: [] },
      sequence_number: 5,
    })
    emit(controller, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageItemId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
      sequence_number: 6,
    })
  }

  const finalize = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (reasoningAdded && !reasoningDone) {
      reasoningDone = true
      emit(controller, "response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: reasoningItemId,
        output_index: reasoningIndex,
        summary_index: 0,
        text: reasoningText,
      })
      emit(controller, "response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: reasoningItemId,
        output_index: reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: reasoningText },
      })
      const item: Obj = { id: reasoningItemId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: reasoningText }] }
      emit(controller, "response.output_item.done", { type: "response.output_item.done", output_index: reasoningIndex, item })
      outputItems.push(item)
    }
    if (messageAdded && !messageDone) {
      messageDone = true
      emit(controller, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        text,
      })
      emit(controller, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        part: { type: "output_text", text },
      })
      const item: Obj = { id: messageItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }
      emit(controller, "response.output_item.done", { type: "response.output_item.done", output_index: messageIndex, item })
      outputItems.push(item)
    }
    if (!completedSeen) {
      const response: Obj = { id: responseId, object: "response", status: "completed", output: outputItems }
      if (usage) response.usage = usage
      emit(controller, "response.completed", { type: "response.completed", response, sequence_number: 7 })
    }
    if (doneSeen) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          const parts = pending.split("\n\n")
          pending = parts.pop() || ""
          for (const block of parts) {
            if (!block.trim()) continue
            const lines = block.split("\n")
            let eventName = ""
            const dataLines: string[] = []
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim()
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
            }
            const dataStr = dataLines.join("\n")
            if (!dataStr || eventName === "ping") continue
            if (dataStr === "[DONE]") {
              doneSeen = true
              continue
            }
            let parsed: unknown
            try { parsed = JSON.parse(dataStr) } catch { continue }
            if (!isObj(parsed)) continue
            const type = String(parsed.type || "")

            if (type.startsWith("response.")) {
              if (type === "response.created" || type === "response.in_progress") {
                ensureStarted(controller, isObj(parsed.response) ? parsed.response.model : undefined, isObj(parsed.response) ? parsed.response.id : parsed.id)
                continue
              }
              if (type === "response.output_text.delta") {
                ensureStarted(controller, isObj(parsed.response) ? parsed.response.model : undefined, isObj(parsed.response) ? parsed.response.id : parsed.id)
                ensureMessage(controller, parsed.item_id)
                if (typeof parsed.delta === "string") text += parsed.delta
                emit(controller, type, parsed)
                continue
              }
              if (type === "response.reasoning_text.delta") {
                ensureStarted(controller, isObj(parsed.response) ? parsed.response.model : undefined, isObj(parsed.response) ? parsed.response.id : parsed.id)
                ensureReasoning(controller, parsed.item_id)
                if (typeof parsed.delta === "string") reasoningText += parsed.delta
                emit(controller, type, parsed)
                continue
              }
              if (type === "response.reasoning_text.done") {
                ensureStarted(controller, isObj(parsed.response) ? parsed.response.model : undefined, isObj(parsed.response) ? parsed.response.id : parsed.id)
                ensureReasoning(controller, parsed.item_id)
                reasoningDone = true
                if (typeof parsed.text === "string") reasoningText = parsed.text
                emit(controller, type, parsed)
                continue
              }
              if (type === "response.output_text.done") {
                ensureStarted(controller, isObj(parsed.response) ? parsed.response.model : undefined, isObj(parsed.response) ? parsed.response.id : parsed.id)
                ensureMessage(controller, parsed.item_id)
                if (typeof parsed.text === "string") text = parsed.text
                emit(controller, type, parsed)
                continue
              }
              if (type === "response.output_item.done") {
                ensureStarted(controller)
                if (isObj(parsed.item)) {
                  const itemType = String(parsed.item.type || "").toLowerCase()
                  if (itemType === "reasoning") reasoningDone = true
                  if (itemType === "message") messageDone = true
                  outputItems.push(parsed.item)
                }
                emit(controller, type, parsed)
                continue
              }
              if (type === "response.completed") {
                completedSeen = true
                if (isObj(parsed.response)) {
                  if (isObj(parsed.response.usage)) usage = parsed.response.usage as Obj
                  if (Array.isArray(parsed.response.output)) {
                    for (const item of parsed.response.output) if (isObj(item)) outputItems.push(item)
                  }
                }
                emit(controller, type, parsed)
                continue
              }
              emit(controller, type, parsed)
              continue
            }

            // Chat-shaped trailing blocks carry usage; keep it for response.completed.
            if (parsed.usage && isObj(parsed.usage)) usage = parsed.usage as Obj
            else if (Array.isArray(parsed.choices)) {
              const last = parsed.choices[parsed.choices.length - 1]
              if (isObj(last) && isObj(last.usage)) usage = last.usage as Obj
            }
          }
        }
        if (pending.trim()) controller.enqueue(encoder.encode(pending))
        finalize(controller)
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}
