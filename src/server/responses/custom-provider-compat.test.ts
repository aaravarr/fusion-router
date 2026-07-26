import { describe, expect, it } from "vitest"
import { chatRequestToResponses, responsesJsonToChatCompletion, responsesSseToChatStream } from "./custom-provider-compat"

describe("custom provider protocol compatibility", () => {
  it("converts chat messages, tools and tool outputs to Responses input", () => {
    expect(chatRequestToResponses({
      model: "gpt-test", max_tokens: 123,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"id\":1}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    })).toMatchObject({
      model: "gpt-test", max_output_tokens: 123,
      input: expect.arrayContaining([
        { role: "user", content: "hello" },
        { type: "function_call", id: "call_1", call_id: "call_1", name: "lookup", arguments: "{\"id\":1}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ]),
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    })
  })

  it("converts a Responses JSON result to Chat Completions", () => {
    expect(responsesJsonToChatCompletion({ id: "resp_1", model: "gpt-test", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })).toMatchObject({
      id: "resp_1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
  })

  it("converts Responses text SSE events to Chat chunks", async () => {
    const source = [
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-test"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const value of source) controller.enqueue(new TextEncoder().encode(value)); controller.close() } })
    const output = await new Response(responsesSseToChatStream(stream)).text()
    expect(output).toContain('"content":"hello"')
    expect(output).toContain('"finish_reason":"stop"')
    expect(output).toContain("data: [DONE]")
  })

  it("preserves reasoning while converting Responses output to Chat", async () => {
    expect(responsesJsonToChatCompletion({
      id: "resp_reasoning",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "checked the inputs" }] },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
      ],
    })).toMatchObject({ choices: [{ message: { content: "done", reasoning_content: "checked the inputs" } }] })

    const source = [
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-test"}}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.completed","response":{}}\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const value of source) controller.enqueue(new TextEncoder().encode(value)); controller.close() } })
    const output = await new Response(responsesSseToChatStream(stream)).text()
    expect(output).toContain('"reasoning_content":"thinking"')
    expect(output).toContain('"content":"answer"')
  })
})
