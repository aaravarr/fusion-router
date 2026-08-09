import { describe, expect, it } from "vitest"
import { chatFinishReasonToStopReason, chatJsonToMessages, chatSseToMessagesStream, messagesRequestToChat } from "./convert"

type Obj = Record<string, unknown>

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  return text
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function parseSseEvents(text: string): Array<{ event: string; data: Obj }> {
  return text.split(/\r?\n\r?\n/).map((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() ?? ""
    const raw = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    return raw ? { event, data: JSON.parse(raw) as Obj } : null
  }).filter((item): item is { event: string; data: Obj } => item !== null)
}

describe("messagesRequestToChat", () => {
  it("converts system string, scalar params, tools and tool_choice", () => {
    const result = messagesRequestToChat({
      model: "claude-sonnet-4-5",
      system: "You are helpful.",
      max_tokens: 1024,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ["END"],
      stream: true,
      tools: [{ name: "get_weather", description: "查询天气", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "get_weather" },
      messages: [{ role: "user", content: "hi" }],
    })
    expect(result).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END"],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "get_weather", description: "查询天气", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    })
    expect(result.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ])
  })

  it("maps tool_choice auto/any/none and system block arrays", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }] }
    expect(messagesRequestToChat({ ...base, tool_choice: { type: "auto" } }).tool_choice).toBe("auto")
    expect(messagesRequestToChat({ ...base, tool_choice: { type: "any" } }).tool_choice).toBe("required")
    expect(messagesRequestToChat({ ...base, tool_choice: { type: "none" } }).tool_choice).toBe("none")
    const result = messagesRequestToChat({ ...base, system: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] })
    expect((result.messages as Obj[])[0]).toEqual({ role: "system", content: "line one\nline two" })
  })

  it("converts assistant tool_use blocks to tool_calls and tool_result to tool messages", () => {
    const result = messagesRequestToChat({
      model: "m",
      messages: [
        { role: "user", content: "天气如何？" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "我来查一下" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "北京" } },
            { type: "tool_use", id: "toolu_2", name: "get_time", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "晴 25°C" }] },
            { type: "tool_result", tool_use_id: "toolu_2", content: "12:00" },
            { type: "text", text: "继续" },
          ],
        },
      ],
    })
    const messages = result.messages as Obj[]
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "我来查一下",
      tool_calls: [
        { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) } },
        { id: "toolu_2", type: "function", function: { name: "get_time", arguments: "{}" } },
      ],
    })
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "晴 25°C" })
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_2", content: "12:00" })
    expect(messages[4]).toEqual({ role: "user", content: "继续" })
  })

  it("converts base64 image blocks to chat image_url parts and drops unknown fields", () => {
    const result = messagesRequestToChat({
      model: "m",
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      }],
    })
    expect(result.thinking).toBeUndefined()
    expect(result.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    }])
  })
})

describe("chatJsonToMessages", () => {
  it("converts text + tool_calls with stop_reason and usage mapping", () => {
    const result = chatJsonToMessages({
      id: "chatcmpl-abc123",
      model: "gpt-5.3-codex",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "好的",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
    })
    expect(result).toEqual({
      id: "msg_chatcmpl-abc123",
      type: "message",
      role: "assistant",
      model: "gpt-5.3-codex",
      content: [
        { type: "text", text: "好的" },
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
    })
  })

  it("maps finish reasons to Anthropic stop reasons", () => {
    expect(chatFinishReasonToStopReason("stop")).toBe("end_turn")
    expect(chatFinishReasonToStopReason("length")).toBe("max_tokens")
    expect(chatFinishReasonToStopReason("tool_calls")).toBe("tool_use")
    expect(chatFinishReasonToStopReason("content_filter")).toBe("refusal")
    const result = chatJsonToMessages({ choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "length" }] })
    expect(result.stop_reason).toBe("max_tokens")
    expect(String(result.id)).toMatch(/^msg_/)
  })

  it("tolerates malformed tool arguments and empty content", () => {
    const result = chatJsonToMessages({
      choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "not-json" } }] }, finish_reason: "tool_calls" }],
    })
    expect(result.content).toEqual([{ type: "tool_use", id: "c1", name: "f", input: {} }])
  })
})

describe("chatSseToMessagesStream", () => {
  it("emits a full event sequence for text-only streams with usage", async () => {
    const input = sseStream([
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"世界"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ])
    const events = parseSseEvents(await streamText(chatSseToMessagesStream(input)))
    expect(events.map((item) => item.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ])
    expect(events[0].data.message).toMatchObject({ id: "msg_chatcmpl-1", type: "message", role: "assistant", model: "m", content: [] })
    expect(events[1].data).toMatchObject({ index: 0, content_block: { type: "text", text: "" } })
    expect(events[2].data).toMatchObject({ index: 0, delta: { type: "text_delta", text: "你好" } })
    expect(events[3].data).toMatchObject({ index: 0, delta: { type: "text_delta", text: "世界" } })
    expect(events[5].data).toMatchObject({ delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 2 } })
  })

  it("emits tool_use blocks with input_json_delta and tool_use stop reason", async () => {
    const input = sseStream([
      'data: {"id":"c1","choices":[{"delta":{"content":"稍等"}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a\\"}"}}]}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"ls","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ])
    const events = parseSseEvents(await streamText(chatSseToMessagesStream(input)))
    const types = events.map((item) => `${item.event}:${String((item.data.delta as Obj | undefined)?.type ?? (item.data.content_block as Obj | undefined)?.type ?? "")}`)
    expect(types).toEqual([
      "message_start:",
      "content_block_start:text",
      "content_block_delta:text_delta",
      "content_block_stop:",
      "content_block_start:tool_use",
      "content_block_delta:input_json_delta",
      "content_block_delta:input_json_delta",
      "content_block_stop:",
      "content_block_start:tool_use",
      "content_block_delta:input_json_delta",
      "content_block_stop:",
      "message_delta:",
      "message_stop:",
    ])
    const toolStarts = events.filter((item) => item.event === "content_block_start" && (item.data.content_block as Obj).type === "tool_use")
    expect(toolStarts[0].data).toMatchObject({ index: 1, content_block: { type: "tool_use", id: "call_1", name: "read_file", input: {} } })
    expect(toolStarts[1].data).toMatchObject({ index: 2, content_block: { type: "tool_use", id: "call_2", name: "ls" } })
    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: "tool_use" } })
  })

  it("closes gracefully when the stream ends without a finish chunk", async () => {
    const input = sseStream(['data: {"id":"c1","choices":[{"delta":{"content":"半截"}}]}\n\n', "data: [DONE]\n\n"])
    const events = parseSseEvents(await streamText(chatSseToMessagesStream(input)))
    expect(events.map((item) => item.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: "end_turn" } })
  })

  it("carries usage from a standalone trailing chunk after finish_reason (OpenAI include_usage ordering)", async () => {
    const input = sseStream([
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      "data: [DONE]\n\n",
    ])
    const events = parseSseEvents(await streamText(chatSseToMessagesStream(input)))
    const delta = events.find((item) => item.event === "message_delta")
    expect(delta?.data).toMatchObject({ delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } })
    expect(events.at(-1)?.event).toBe("message_stop")
  })

  it("still finishes with the real stop_reason when usage never arrives", async () => {
    const input = sseStream([
      'data: {"id":"c1","choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ])
    const events = parseSseEvents(await streamText(chatSseToMessagesStream(input)))
    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: "max_tokens" } })
  })
})
