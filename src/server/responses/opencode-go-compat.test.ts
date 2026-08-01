import { describe, expect, it } from "vitest"
import { normalizeOpenCodeGoResponsesSse } from "./opencode-go-compat"

async function run(blocks: string[]): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of blocks) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  return new Response(normalizeOpenCodeGoResponsesSse(stream)).text()
}

describe("opencode-go responses lifecycle normalization", () => {
  it("builds a complete Responses lifecycle around bare output_text deltas", async () => {
    const output = await run([
      "\n\n\n\n",
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi","response":{"id":"resp_1","model":"glm-5.2"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there","response":{"id":"resp_1","model":"glm-5.2"}}\n\n',
      'data: {"choices":[],"x-opencode-type":"inference-cost","cost":"0.001","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
      "event: ping\ndata: ping\n\n",
    ])
    expect(output).toContain('"type":"response.created"')
    expect(output).toContain('"type":"response.in_progress"')
    expect(output).toContain('"type":"response.output_item.added"')
    expect(output).toContain('"type":"response.content_part.added"')
    expect(output).toContain('"delta":"hi"')
    expect(output).toContain('"delta":" there"')
    expect(output).toContain('"type":"response.output_text.done"')
    expect(output).toContain('"type":"response.output_item.done"')
    expect(output).toContain('"type":"response.completed"')
    expect(output).toContain('"status":"completed"')
    expect(output).toContain('data: [DONE]')
    expect(output).not.toContain('"type":"ping"')
    expect(output).toContain('"prompt_tokens":2')
    const completed = output.slice(output.indexOf('"type":"response.completed"'))
    expect(completed).toContain('"content":[{"type":"output_text","text":"hi there"}]')
  })

  it("keeps reasoning deltas and closes reasoning item on stream end", async () => {
    const output = await run([
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs_1","delta":"think"}\n\n',
      'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","item_id":"rs_1","text":"think"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"answer"}\n\n',
      "data: [DONE]\n\n",
    ])
    expect(output).toContain('"type":"reasoning"')
    expect(output).toContain('"type":"response.reasoning_text.delta"')
    expect(output).toContain('"type":"response.output_item.done"')
    expect(output).toContain('"type":"response.completed"')
  })
})
