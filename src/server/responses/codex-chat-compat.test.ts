import { describe, expect, it } from "vitest"
import { buildCodexToolContextFromRequest, chatCompletionToResponse, remapXaiResponsesJsonForCodex, transformChatSseToResponsesSse, transformXaiResponsesSseForCodex, responsesToChatCompletions } from "./codex-chat-compat"

describe("chat to Responses reasoning compatibility", () => {
  it("preserves reasoning in non-stream responses", () => {
    expect(chatCompletionToResponse({
      id: "chat_1",
      choices: [{ message: { content: "answer", reasoning_content: "analysis" } }],
    })).toMatchObject({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "analysis" }] },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
      ],
    })
  })

  it("keeps function apply_patch as function_call when declared as function", async () => {
    const ctx = buildCodexToolContextFromRequest({
      model: "deepseek-v4-flash",
      input: "edit",
      tools: [{ type: "function", name: "apply_patch", description: "patch", parameters: { type: "object", properties: {} } }],
    })
    const source = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"apply_patch","status":"in_progress","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\"input\":\"diff\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"apply_patch","status":"completed","arguments":"{\"input\":\"diff\"}"}}\n\n',
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of source) controller.enqueue(new TextEncoder().encode(value))
        controller.close()
      },
    })
    const output = await new Response(transformXaiResponsesSseForCodex(stream, ctx)).text()
    expect(output).toContain('"type":"function_call"')
    expect(output).not.toContain('"type":"custom_tool_call"')
    expect(output).toContain('"name":"apply_patch"')
    expect(output).toContain('"type":"response.function_call_arguments.delta"')
  })

  it("converts custom apply_patch to custom_tool_call when declared as custom", async () => {
    const ctx = buildCodexToolContextFromRequest({
      model: "grok-4.5",
      input: "edit",
      tools: [{ type: "custom", name: "apply_patch", description: "patch" }],
    })
    expect(remapXaiResponsesJsonForCodex({
      id: "resp_1",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", status: "completed", arguments: "{\"input\":\"diff\"}" }],
    }, ctx)).toMatchObject({
      output: [{ type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "diff" }],
    })
  })
  it("rewrites OpenCode reasoning_text stream events for Codex", async () => {
    const source = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","status":"in_progress","summary":[]}}\n\n',
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","content_index":0,"item_id":"rs_1","output_index":0,"part":{"type":"reasoning_text","text":""}}\n\n',
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","content_index":0,"delta":"step one","item_id":"rs_1","output_index":0}\n\n',
      'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","content_index":0,"item_id":"rs_1","output_index":0,"text":"step one"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","status":"completed","summary":[]}}\n\n',
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of source) controller.enqueue(new TextEncoder().encode(value))
        controller.close()
      },
    })
    const output = await new Response(transformXaiResponsesSseForCodex(stream)).text()
    expect(output).not.toContain('"type":"response.reasoning_text.delta"')
    expect(output).toContain('"type":"response.reasoning_summary_text.delta"')
    expect(output).toContain('"delta":"step one"')
    expect(output).toContain('"type":"response.reasoning_summary_text.done"')
    expect(output).toContain('"type":"response.reasoning_summary_part.done"')
    expect(output).toContain('"type":"summary_text","text":"step one"')
  })

  it("fills reasoning summary from content for non-stream responses", () => {
    expect(remapXaiResponsesJsonForCodex({
      id: "resp_1",
      output: [
        { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "analysis" }], summary: [] },
      ],
    })).toMatchObject({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "analysis" }] },
      ],
    })
  })
  it("emits reasoning deltas while converting a chat stream", async () => {
    const source = [
      'data: {"id":"chat_1","choices":[{"delta":{"reasoning_content":"step one"}}]}\n\n',
      'data: {"id":"chat_1","choices":[{"delta":{"content":"answer"}}]}\n\n',
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of source) controller.enqueue(new TextEncoder().encode(value))
        controller.close()
      },
    })
    const output = await new Response(transformChatSseToResponsesSse(stream)).text()
    expect(output).toContain('"type":"response.reasoning_summary_text.delta"')
    expect(output).toContain('"delta":"step one"')
    expect(output).toContain('"type":"reasoning"')
    expect(output).toContain('"delta":"answer"')
  })
})


describe("responses to chat reasoning replay", () => {
  it("injects opts.reasoningItems onto the tool-call assistant message", () => {
    const { body } = responsesToChatCompletions(
      {
        model: "deepseek-v4-flash",
        input: [
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "ok" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      },
      [],
      { reasoningItems: [{ reasoning_content: "saved reasoning" }] },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
    expect(assistant).toBeTruthy()
    expect(assistant?.reasoning_content).toBe("saved reasoning")
  })

  it("replays client-supplied reasoning items before tool calls", () => {
    const { body } = responsesToChatCompletions({
      model: "deepseek-v4-flash",
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "client reasoning" }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    })
    const messages = body.messages as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
    expect(assistant?.reasoning_content).toBe("client reasoning")
  })

  it("does not consume reasoning queue when no tool call flushes", () => {
    const { body } = responsesToChatCompletions(
      { model: "deepseek-v4-flash", input: "hello" },
      [],
      { reasoningItems: [{ reasoning_content: "stale" }] },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.some((m) => typeof m.reasoning_content === "string")).toBe(false)
  })
})
