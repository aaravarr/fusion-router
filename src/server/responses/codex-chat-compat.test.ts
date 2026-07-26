import { describe, expect, it } from "vitest"
import { chatCompletionToResponse, transformChatSseToResponsesSse } from "./codex-chat-compat"

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
