/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest"
import { buildCodexToolContextFromRequest, remapXaiResponsesJsonForCodex, transformXaiResponsesSseForCodex } from "./codex-chat-compat"

function ctxWithClientFunction(name: string, pool: string | null = "opencode-go", model: string = "muse-spark-1.2-contributor") {
  const ctx = buildCodexToolContextFromRequest({
    model,
    input: "hi",
    tools: [{ type: "function", name, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
  })
  ctx.poolType = pool
  return ctx
}
function ctxWithServerTool(type: string, pool: string | null = "opencode-go", model: string = "muse-spark-1.2-contributor") {
  const ctx = buildCodexToolContextFromRequest({
    model,
    input: "hi",
    tools: [{ type }],
  })
  ctx.poolType = pool
  return ctx
}
describe("hijack verify", () => {
  it("non-stream web_search_call -> function_call with xai_query", () => {
    const ctx = ctxWithClientFunction("web_search")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_123",
          call_id: "call_123",
          status: "completed",
          action: { type: "search", query: "web_search: DeepSeek V4 发布时间", sources: [] },
          xai_query: "DeepSeek V4 发布时间",
          xai_tool: "web_search",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    console.log("non-stream remapped", JSON.stringify(remapped, null, 2))
    expect(remapped.output).toHaveLength(1)
    const item = remapped.output[0]
    expect(item.type).toBe("function_call")
    expect(item.name).toBe("web_search")
    expect(item.id).toBe("fc_123")
    expect(item.call_id).toBe("call_123")
    expect(JSON.parse(item.arguments)).toEqual({ query: "DeepSeek V4 发布时间" })
  })
  it("non-stream strips prefix when xai_query missing", () => {
    const ctx = ctxWithClientFunction("web_search")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "web_search: DeepSeek V4 发布时间", sources: [] },
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("function_call")
    expect(JSON.parse(remapped.output[0].arguments)).toEqual({ query: "DeepSeek V4 发布时间" })
  })
  it("non-stream keep original when query missing", () => {
    const ctx = ctxWithClientFunction("web_search")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "", sources: [] },
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    // xai_query missing and action.query empty -> not convert, stay web_search_call (or normalized)
    expect(remapped.output[0].type).toBe("web_search_call")
  })
  it("server declared no convert", () => {
    const ctx = ctxWithServerTool("web_search")
    // also has client? No, only server
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "hello", sources: [] },
          xai_query: "hello",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("web_search_call")
  })
  it("non-opencode-go no convert", () => {
    const ctx = ctxWithClientFunction("web_search", "xai-grok")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "hello", sources: [] },
          xai_query: "hello",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("web_search_call")
  })
  it("x_search variant", () => {
    const ctx = ctxWithClientFunction("x_search")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "x_search_call",
          id: "fc_x1",
          call_id: "call_x1",
          status: "completed",
          action: { type: "search", query: "x_search: hello world", sources: [] },
          xai_query: "hello world",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("function_call")
    expect(remapped.output[0].name).toBe("x_search")
    expect(JSON.parse(remapped.output[0].arguments)).toEqual({ query: "hello world" })
  })
  it("streaming hijack lifecycle", async () => {
    const ctx = ctxWithClientFunction("web_search")
    const events = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"sequence_number":1,"item":{"type":"web_search_call","id":"fc_123","call_id":"call_123","status":"in_progress","action":{"type":"search","query":"web_search: DeepSeek V4 发布时间","sources":[]},"xai_query":"DeepSeek V4 发布时间","xai_tool":"web_search"}}\n\n',
      'event: response.web_search_call.in_progress\ndata: {"type":"response.web_search_call.in_progress","item_id":"fc_123","output_index":0,"sequence_number":2}\n\n',
      'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","item_id":"fc_123","output_index":0,"sequence_number":3}\n\n',
      'event: response.web_search_call.completed\ndata: {"type":"response.web_search_call.completed","item_id":"fc_123","output_index":0,"sequence_number":4}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"sequence_number":5,"item":{"type":"web_search_call","id":"fc_123","call_id":"call_123","status":"completed","action":{"type":"search","query":"web_search: DeepSeek V4 发布时间","sources":[]},"xai_query":"DeepSeek V4 发布时间","xai_tool":"web_search"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n',
      'data: [DONE]\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const v of events) controller.enqueue(new TextEncoder().encode(v))
        controller.close()
      },
    })
    const out = await new Response(transformXaiResponsesSseForCodex(stream, ctx)).text()
    console.log("stream output", out)
    expect(out).not.toContain("web_search_call")
    expect(out).toContain('"type":"function_call"')
    expect(out).toContain('"name":"web_search"')
    expect(out).toContain('"call_id":"call_123"')
    // lifecycle: added with empty, delta with json, done, output_item.done
    expect(out).toContain('response.output_item.added')
    expect(out).toContain('response.function_call_arguments.delta')
    expect(out).toContain('response.function_call_arguments.done')
    expect(out).toContain('response.output_item.done')
    // count events: each SSE block contains event: and data:"type" => 2 matches per logical event
    const addedMatches = (out.match(/response\.output_item\.added/g) || []).length
    expect(addedMatches).toBe(2) // 1 logical added *2 occurrences
    // call_id should be preserved at least twice (added item and done item)
    expect((out.match(/call_123/g) || []).length).toBeGreaterThanOrEqual(2)
  })
  it("both client function and server tool declared -> not hijack (server takes precedence)", () => {
    const ctx = buildCodexToolContextFromRequest({
      model: "muse-spark-1.2-contributor",
      input: "hi",
      tools: [
        { type: "function", name: "web_search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { type: "web_search" },
      ],
    })
    ctx.poolType = "opencode-go"
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "hello", sources: [] },
          xai_query: "hello",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("web_search_call")
  })
  it("x_search streaming hijack", async () => {
    const ctx = ctxWithClientFunction("x_search")
    const events = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"sequence_number":1,"item":{"type":"x_search_call","id":"fc_x1","call_id":"call_x1","status":"in_progress","action":{"type":"search","query":"x_search: hello world","sources":[]},"xai_query":"hello world","xai_tool":"x_search"}}\n\n',
      'event: response.x_search_call.in_progress\ndata: {"type":"response.x_search_call.in_progress","item_id":"fc_x1","output_index":1,"sequence_number":2}\n\n',
      'event: response.x_search_call.searching\ndata: {"type":"response.x_search_call.searching","item_id":"fc_x1","output_index":1,"sequence_number":3}\n\n',
      'event: response.x_search_call.completed\ndata: {"type":"response.x_search_call.completed","item_id":"fc_x1","output_index":1,"sequence_number":4}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"sequence_number":5,"item":{"type":"x_search_call","id":"fc_x1","call_id":"call_x1","status":"completed","action":{"type":"search","query":"x_search: hello world","sources":[]},"xai_query":"hello world","xai_tool":"x_search"}}\n\n',
      'data: [DONE]\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const v of events) controller.enqueue(new TextEncoder().encode(v)); controller.close() },
    })
    const out = await new Response(transformXaiResponsesSseForCodex(stream, ctx)).text()
    expect(out).not.toContain("x_search_call")
    expect(out).toContain('"name":"x_search"')
    expect(out).toContain('"call_id":"call_x1"')
    expect(JSON.stringify(out)).toContain("hello world")
  })
  it("opencode-go but non-muse model not convert (gpt-5.6-luna)", () => {
    const ctx = ctxWithClientFunction("web_search", "opencode-go", "gpt-5.6-luna")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "hello", sources: [] },
          xai_query: "hello",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("web_search_call")
  })
  it("opencode-go muse-spark-1.2 also converts", () => {
    const ctx = ctxWithClientFunction("web_search", "opencode-go", "muse-spark-1.2")
    const payload = {
      id: "resp_1",
      output: [
        {
          type: "web_search_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { type: "search", query: "hello", sources: [] },
          xai_query: "hello",
        },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload, ctx) as any
    expect(remapped.output[0].type).toBe("function_call")
    expect(remapped.output[0].name).toBe("web_search")
  })
  it("streaming non-muse not hijack", async () => {
    const ctx = ctxWithClientFunction("web_search", "opencode-go", "gpt-5.6-luna")
    const events = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"sequence_number":1,"item":{"type":"web_search_call","id":"fc_123","call_id":"call_123","status":"in_progress","action":{"type":"search","query":"hello","sources":[]},"xai_query":"hello"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"sequence_number":2,"item":{"type":"web_search_call","id":"fc_123","call_id":"call_123","status":"completed","action":{"type":"search","query":"hello","sources":[]},"xai_query":"hello"}}\n\n',
      'data: [DONE]\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const v of events) controller.enqueue(new TextEncoder().encode(v)); controller.close() },
    })
    const out = await new Response(transformXaiResponsesSseForCodex(stream, ctx)).text()
    expect(out).toContain("web_search_call")
    expect(out).not.toContain('"type":"function_call"')
  })
  it("streaming server declared not hijack", async () => {
    const ctx = ctxWithServerTool("web_search")
    const events = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"sequence_number":1,"item":{"type":"web_search_call","id":"fc_123","call_id":"call_123","status":"in_progress","action":{"type":"search","query":"hello","sources":[]}}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"sequence_number":2,"item":{"type":"web_search_call","id":"fc_123","call_id":"call_123","status":"completed","action":{"type":"search","query":"hello","sources":[]}}}\n\n',
      'data: [DONE]\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const v of events) controller.enqueue(new TextEncoder().encode(v))
        controller.close()
      },
    })
    const out = await new Response(transformXaiResponsesSseForCodex(stream, ctx)).text()
    console.log("stream server out", out)
    expect(out).toContain("web_search_call")
    expect(out).not.toContain('"type":"function_call"')
  })
})
