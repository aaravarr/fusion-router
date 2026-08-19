import { describe, expect, it } from "vitest"
import { normalizeOpenCodeGoResponsesSse, stripUnsupportedOpenCodeGoResponsesParams } from "./opencode-go-compat"

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

describe("stripUnsupportedOpenCodeGoResponsesParams", () => {
  it("带顶层 include_usage 的响应体剥离后不含该字段，其余字段保留", () => {
    const body = JSON.stringify({ model: "muse-spark-1.2-contributor", input: "hi", include_usage: true, stream: true, tools: [{ type: "web_search" }] })
    const out = stripUnsupportedOpenCodeGoResponsesParams(body)
    expect(out.body).not.toContain("include_usage")
    expect(JSON.parse(out.body)).toEqual({ model: "muse-spark-1.2-contributor", input: "hi", stream: true, tools: [{ type: "web_search" }] })
    expect(out.includeUsageStripped).toBe(true)
    expect(out.streamOptionsIncludeUsageStripped).toBe(false)
  })

  it("只带 stream_options.include_usage 时剥离该字段，并删除已变空的 stream_options 键", () => {
    const body = JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream_options: { include_usage: true } })
    const out = stripUnsupportedOpenCodeGoResponsesParams(body)
    const parsed = JSON.parse(out.body) as Record<string, unknown>
    expect(parsed).not.toHaveProperty("stream_options")
    expect(parsed).toEqual({ model: "gpt-5.6-luna", input: "hi" })
    expect(out.includeUsageStripped).toBe(false)
    expect(out.streamOptionsIncludeUsageStripped).toBe(true)
  })

  it("stream_options 带 include_usage 与其它字段时只删 include_usage，保留其它字段", () => {
    const body = JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream_options: { include_usage: true, parallel_tool_calls: true } })
    const out = stripUnsupportedOpenCodeGoResponsesParams(body)
    const parsed = JSON.parse(out.body) as Record<string, unknown>
    expect(parsed.stream_options).toEqual({ parallel_tool_calls: true })
    expect((parsed.stream_options as Record<string, unknown>).include_usage).toBeUndefined()
    expect(out.streamOptionsIncludeUsageStripped).toBe(true)
  })

  it("顶层 include_usage 与 stream_options.include_usage 同时存在时两个都剥离", () => {
    const body = JSON.stringify({ model: "gpt-5.6-luna", input: "hi", include_usage: true, stream_options: { include_usage: true } })
    const out = stripUnsupportedOpenCodeGoResponsesParams(body)
    const parsed = JSON.parse(out.body) as Record<string, unknown>
    expect(parsed.include_usage).toBeUndefined()
    expect(parsed).not.toHaveProperty("stream_options")
    expect(out.includeUsageStripped).toBe(true)
    expect(out.streamOptionsIncludeUsageStripped).toBe(true)
  })

  it("无任何需剥离字段时原样返回（字符串相同，不做重新序列化）", () => {
    const body = JSON.stringify({ model: "muse-spark-1.2-contributor", input: "hi" })
    const out = stripUnsupportedOpenCodeGoResponsesParams(body)
    expect(out.body).toBe(body)
    expect(out.includeUsageStripped).toBe(false)
    expect(out.streamOptionsIncludeUsageStripped).toBe(false)
  })

  it("非法 JSON 原样返回", () => {
    const body = "{not-json"
    expect(stripUnsupportedOpenCodeGoResponsesParams(body).body).toBe(body)
  })

  it("空 body 原样返回", () => {
    expect(stripUnsupportedOpenCodeGoResponsesParams("").body).toBe("")
  })

  it("非对象 JSON（如数组/标量）原样返回", () => {
    expect(stripUnsupportedOpenCodeGoResponsesParams("[1,2,3]").body).toBe("[1,2,3]")
    expect(stripUnsupportedOpenCodeGoResponsesParams("42").body).toBe("42")
  })
})

