import { describe, expect, it } from "vitest"
import { chatCompletionToResponse, remapXaiResponsesJsonForCodex, transformChatSseToResponsesSse, transformXaiResponsesSseForCodex } from "./codex-chat-compat"

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
