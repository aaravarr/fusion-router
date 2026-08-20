import { describe, expect, it } from "vitest"
import { buildCodexToolContextFromRequest, chatCompletionToResponse, remapXaiResponsesJsonForCodex, toResponsesUsage, transformChatSseToResponsesSse, transformXaiResponsesSseForCodex, responsesToChatCompletions } from "./codex-chat-compat"

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

  it("merges assistant content + function_call into one DeepSeek tool message", () => {
    const { body } = responsesToChatCompletions({
      model: "deepseek-v4-flash",
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "need weather tool" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Let me check the weather." }],
        },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"HZ\"}" },
        { type: "function_call_output", call_id: "call_1", output: "cloudy" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
      ],
    })
    const messages = body.messages as Array<Record<string, unknown>>
    const assistants = messages.filter((m) => m.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe("Let me check the weather.")
    expect(assistants[0].reasoning_content).toBe("need weather tool")
    expect(Array.isArray(assistants[0].tool_calls)).toBe(true)
    expect((assistants[0].tool_calls as unknown[]).length).toBe(1)
  })

  it("缺 call_id 的历史工具调用生成稳定 id（不破坏前缀缓存）", () => {
    const input = [
      { type: "function_call", name: "apply_patch", arguments: "{\"input\":\"diff\"}" },
      { type: "function_call_output", call_id: "x", output: "ok" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]
    const first = responsesToChatCompletions({ model: "deepseek-v4-flash", input })
    const second = responsesToChatCompletions({ model: "deepseek-v4-flash", input })
    const idOf = (body: { messages?: Array<Record<string, unknown>> }) => {
      const assistant = (body.messages ?? []).find((m) => m.role === "assistant" && Array.isArray(m.tool_calls)) as
        | { tool_calls?: Array<{ id: string }> }
        | undefined
      return assistant?.tool_calls?.[0]?.id
    }
    const id1 = idOf(first.body)
    const id2 = idOf(second.body)
    expect(id1).toBeTruthy()
    expect(id1).toMatch(/^call_/)
    expect(id1).toBe(id2)
  })
})

describe("chat stream id stability", () => {
  it("keeps response.created id when later chunks change chat completion id", async () => {
    const source = [
      'data: {"id":"chat_a","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"chat_b","choices":[{"delta":{"content":"!"}}]}\n\n',
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of source) controller.enqueue(new TextEncoder().encode(value))
        controller.close()
      },
    })
    const output = await new Response(transformChatSseToResponsesSse(stream)).text()
    expect(output).toContain('"id":"resp_chat_a"')
    expect(output).not.toContain('"id":"resp_chat_b"')
    expect(output).toContain('"type":"response.completed"')
  })
})


describe("toResponsesUsage Codex required fields", () => {
  it("fills reasoning_tokens when upstream completion_tokens_details is empty (Kimi tool-call turn)", () => {
    const usage = toResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: {},
    })
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 0 })
  })

  it("keeps existing reasoning_tokens and fills text-only details", () => {
    const usage = toResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { text_tokens: 3 },
    })
    expect(usage.output_tokens_details).toEqual({ text_tokens: 3, reasoning_tokens: 0 })
  })

  it("preserves upstream reasoning_tokens", () => {
    const usage = toResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 8 },
    })
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 8 })
  })

  it("fills cached_tokens when prompt_tokens_details lacks it", () => {
    const usage = toResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: {},
    })
    expect(usage.input_tokens_details).toEqual({ cached_tokens: 0 })
  })

  it("keeps upstream cached_tokens", () => {
    const usage = toResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
    })
    expect(usage.input_tokens_details).toEqual({ cached_tokens: 7 })
  })

  it("defaults output_tokens_details when no details present", () => {
    const usage = toResponsesUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 0 })
  })
})

describe("toResponsesUsage event-root fallback（事件根字段兜底）", () => {
  it("reasoning_tokens 在事件根（usage 之外）时兜底进 output_tokens_details", () => {
    // opencode 等上游可能在收尾 chunk 把 reasoning_tokens 放在 usage 对象之外的事件根。
    const usage = toResponsesUsage(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 8 } },
      { reasoning_tokens: 3 },
    )
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 3 })
    expect(usage.input_tokens_details).toEqual({ cached_tokens: 8 })
  })

  it("usage 内已有 reasoning_tokens 时事件根不覆盖", () => {
    const usage = toResponsesUsage(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 8 } },
      { reasoning_tokens: 999 },
    )
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 8 })
  })
})

describe("畸形 tool-call 聚合的纯结构拆分（A 项）", () => {
  it("6 拼接畸形样本拆成 6 个独立 function_call，内容逐字符保留、call_id 唯一", async () => {
    const { splitConcatenatedJsonObjects, splitToolArgumentsIfConcatenated } = await import("./codex-chat-compat")
    // 构造 6 个完整 JSON 对象首尾拼接的畸形 arguments（无分隔）
    const segments = ["A", "B", "C", "D", "E", "F"].map((q) => JSON.stringify({ query: q }))
    const concatenated = segments.join("")
    // 直接 split 检测
    expect(splitConcatenatedJsonObjects(concatenated)).toEqual(segments)
    expect(splitToolArgumentsIfConcatenated(concatenated)).toEqual(segments)
    // 经 remapXaiResponsesJsonForCodex 的纯结构拆分：共享原 name，各自生成唯一 call_id，arguments 分别取各段原文
    const payload = {
      id: "resp_test",
      output: [
        { type: "function_call", id: "fc_123", call_id: "call_123", name: "my_search", arguments: concatenated, status: "completed" },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload) as unknown as { output: Array<Record<string, unknown>> }
    expect(Array.isArray(remapped.output)).toBe(true)
    expect(remapped.output).toHaveLength(6)
    const callIds = new Set<string>()
    remapped.output.forEach((item: Record<string, unknown>, idx: number) => {
      expect(item.type).toBe("function_call")
      expect(item.name).toBe("my_search")
      expect(item.arguments).toBe(segments[idx])
      // 内容逐字符保留：JSON.parse 后 query 一致
      expect(JSON.parse(item.arguments)).toEqual({ query: String.fromCharCode(65 + idx) })
      expect(typeof item.call_id).toBe("string")
      callIds.add(item.call_id)
      expect(typeof item.id).toBe("string")
    })
    expect(callIds.size).toBe(6) // call_id 唯一
  })

  it("正常 arguments 不受影响（能正常 parse 的不动）", () => {
    const payload = {
      id: "resp_test2",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "my_search", arguments: JSON.stringify({ query: "A" }), status: "completed" },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "get_weather", arguments: JSON.stringify({ city: "HZ" }), status: "completed" },
      ],
    }
    const remapped = remapXaiResponsesJsonForCodex(payload) as unknown as { output: Array<Record<string, unknown>> }
    expect(remapped.output).toHaveLength(2)
    expect((remapped.output[0] as Record<string, unknown>).arguments).toBe(JSON.stringify({ query: "A" }))
    expect((remapped.output[1] as Record<string, unknown>).arguments).toBe(JSON.stringify({ city: "HZ" }))
  })

  it("流式 transformXaiResponsesSseForCodex 对拼接的 function_call 在 done 阶段重组为 N 项", async () => {
    const segments = ["A", "B", "C"].map((q) => JSON.stringify({ query: q }))
    const concatenated = segments.join("")
    const sse = [
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "my_search", status: "in_progress", arguments: "" } })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: concatenated })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "my_search", status: "completed", arguments: concatenated } })}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const v of sse) controller.enqueue(new TextEncoder().encode(v))
        controller.close()
      },
    })
    const output = await new Response(transformXaiResponsesSseForCodex(stream)).text()
    // 应拆成 3 个独立调用：检查 function_call 出现次数及内容逐字符保留
    const funcCallMatches = output.match(/"type":"function_call"/g) || []
    expect(funcCallMatches.length).toBeGreaterThanOrEqual(3)
    for (const q of ["A", "B", "C"]) {
      // SSE 输出中 arguments 为 JSON 字符串，查询值应以原文逐字符保留（转义后仍含查询值）
      expect(output).toContain(q)
    }
    // call_id 唯一性：至少 3 个不同的 call_id（含后缀）
    const callIds = new Set((output.match(/call_1_\d+/g) || []))
    expect(callIds.size).toBeGreaterThanOrEqual(3)
  })
})

describe("usage 计量真实化（D 项）", () => {
  it("output 全为 reasoning 且 output_tokens>0 时，reasoning_tokens 推断为 output_tokens", () => {
    const usage = toResponsesUsage(
      { input_tokens: 288, output_tokens: 162, total_tokens: 450 },
      undefined,
      { output: [{ type: "reasoning", id: "rs_1" }, { type: "reasoning", id: "rs_2" }] },
    )
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 162 })
  })

  it("正常混合输出（reasoning + message）不推断，保持缺失语义", () => {
    const usage = toResponsesUsage(
      { input_tokens: 100, output_tokens: 50, total_tokens: 150, output_tokens_details: { text_tokens: 10 } },
      undefined,
      { output: [{ type: "reasoning", id: "rs_1" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }] },
    )
    // 混合输出不应推断 reasoning_tokens，保持原有 text_tokens 且不补 reasoning_tokens
    expect(usage.output_tokens_details).toEqual({ text_tokens: 10 })
  })

  it("output 为空或非全 reasoning 时不推断（保持缺失）", () => {
    const usage = toResponsesUsage(
      { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      undefined,
      { output: [{ type: "message", role: "assistant" }] },
    )
    expect(usage.output_tokens_details).toBeUndefined()
  })
})

describe("A 项回放回归（单包无 delta 与多 delta 完整性）", () => {
  it("单包 function_call（added 带空 arguments、仅 done 带完整 arguments、无 delta）应完整回放 added→done→output_item.done", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_single","call_id":"call_single","name":"run_code","status":"in_progress","arguments":""}}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_single","output_index":0,"arguments":"{\"code\":\"await tools.web_search({query:\\\"test\\\"})\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_single","call_id":"call_single","name":"run_code","status":"completed","arguments":"{\"code\":\"await tools.web_search({query:\\\"test\\\"})\"}"}}\n\n',
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const v of sse) controller.enqueue(new TextEncoder().encode(v))
        controller.close()
      },
    })
    const output = await new Response(transformXaiResponsesSseForCodex(stream)).text()
    expect(output).toContain('"type":"response.output_item.added"')
    expect(output).toContain('"type":"response.function_call_arguments.done"')
    expect(output).toContain('"type":"response.output_item.done"')
    expect(output).toContain('call_single')
    expect(output).toContain('await tools.web_search')
    // 不应丢失 done，且不应产生非法 _1 后缀拆分
    expect(output).not.toContain('call_single_1')
  })

  it("单包 function_call（added 已带完整 arguments、无 delta、done 同参）应完整回放", async () => {
    const args = "{\"code\":\"console.log(123)\"}"
    const sse = [
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"run_code","status":"in_progress","arguments":"${args}"}}\n\n`,
      `event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_a","output_index":1,"arguments":"${args}"}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"run_code","status":"completed","arguments":"${args}"}}\n\n`,
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const v of sse) controller.enqueue(new TextEncoder().encode(v))
        controller.close()
      },
    })
    const output = await new Response(transformXaiResponsesSseForCodex(stream)).text()
    expect(output).toContain('"type":"response.output_item.added"')
    expect(output).toContain('"type":"response.function_call_arguments.done"')
    expect(output).toContain('"type":"response.output_item.done"')
    expect(output).toContain('call_a')
  })

  it("正常多 delta 不拆分的回放应完整（added→delta*2→done→output_item.done）", async () => {
    const fixedSse = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_m","call_id":"call_m","name":"run_code","status":"in_progress","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_m","output_index":2,"delta":"{\\\"code\\\":\\\"part1"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_m","output_index":2,"delta":"part2\\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_m","output_index":2,"arguments":"{\\\"code\\\":\\\"part1part2\\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_m","call_id":"call_m","name":"run_code","status":"completed","arguments":"{\\\"code\\\":\\\"part1part2\\\"}"}}\n\n',
      "data: [DONE]\n\n",
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const v of fixedSse) controller.enqueue(new TextEncoder().encode(v))
        controller.close()
      },
    })
    const output = await new Response(transformXaiResponsesSseForCodex(stream)).text()
    expect(output).toContain('"type":"response.output_item.added"')
    expect((output.match(/response\.function_call_arguments\.delta/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(output).toContain('"type":"response.function_call_arguments.done"')
    expect(output).toContain('"type":"response.output_item.done"')
    expect(output).toContain('call_m')
    expect(output).not.toContain('call_m_1')
  })
})
