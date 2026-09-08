import { describe, expect, it } from "vitest"
import { chatImagePartToResponsesImagePart, chatRequestToResponses, clampResponsesCallId, hasConvertibleSsePayload, iterSseDataPayloads, looksLikeResponsesSse, mapResponsesFinish, responsesJsonToChatCompletion, responsesSseToChatStream, responsesSseToJson } from "./custom-provider-compat"
import { messagesRequestToChat } from "../messages/convert"

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
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"id\":1}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ]),
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    })
  })

  it("maps chat content parts to Responses input variants (text/image_url)", () => {
    expect(chatRequestToResponses({
      model: "gpt-test",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://x/a.png" } }] },
        { role: "user", content: "plain string" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    }).input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "https://x/a.png", detail: "auto" }] },
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "input_text", text: "ok" }] },
    ])
  })

  // 2026-09-07 生产 400（dac712f2）：转换器曾把 image_url 对象原样改名透传
  //（{type:"input_image", image_url:{url}}），上游 Go 服务要求 image_url 为字符串，
  // 报 `input[128].content did not match any supported type`。上游实测确认标准
  // input_image（image_url 字符串 + detail）返回 200，错误形状复现 400。
  describe("chat image_url → responses input_image 形状映射", () => {
    it("image_url 对象展平为字符串并补 detail:auto（http URL）", () => {
      expect(chatImagePartToResponsesImagePart({ type: "image_url", image_url: { url: "https://x/a.png" } }))
        .toEqual({ type: "input_image", image_url: "https://x/a.png", detail: "auto" })
    })

    it("data URL 同形态处理（生产 dac712f2 的真实形状）", () => {
      const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD"
      expect(chatImagePartToResponsesImagePart({ type: "image_url", image_url: { url: dataUrl } }))
        .toEqual({ type: "input_image", image_url: dataUrl, detail: "auto" })
    })

    it("透传客户端指定的 detail（low/high）", () => {
      expect(chatImagePartToResponsesImagePart({ type: "image_url", image_url: { url: "https://x/a.png", detail: "high" } }))
        .toEqual({ type: "input_image", image_url: "https://x/a.png", detail: "high" })
    })

    it("image_url 已是字符串时直接采用", () => {
      expect(chatImagePartToResponsesImagePart({ type: "image_url", image_url: "https://x/a.png" }))
        .toEqual({ type: "input_image", image_url: "https://x/a.png", detail: "auto" })
    })

    it("chatRequestToResponses 全链路：muse 带图 chat 入口产出标准 input_image", () => {
      const input = chatRequestToResponses({
        model: "muse-spark-1.3-contributor",
        messages: [
          { role: "user", content: [{ type: "text", text: "看这个" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } }] },
        ],
      }).input as Array<{ role: string; content: unknown }>
      expect(input).toHaveLength(1)
      expect(input[0].content).toEqual([
        { type: "input_text", text: "看这个" },
        { type: "input_image", image_url: "data:image/jpeg;base64,AAA", detail: "auto" },
      ])
    })
  })

  it("converts a Responses JSON result to Chat Completions", () => {
    expect(responsesJsonToChatCompletion({ id: "resp_1", model: "gpt-test", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })).toMatchObject({
      id: "resp_1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
  })

  it("maps Responses function_call id from call_id for chat round-trip", () => {
    const result = responsesJsonToChatCompletion({
      id: "resp_tools",
      model: "gpt-test",
      output: [
        { type: "function_call", id: "fc_provider_owned", call_id: "call_client_owned", name: "lookup", arguments: "{\"id\":1}" },
        { type: "function_call_output", id: "fc_output_provider_owned", call_id: "call_client_owned", output: "ok" },
      ],
    })
    const message = (result.choices as Array<{ message: Record<string, unknown> }>)[0].message
    expect(message.tool_calls).toEqual([{ id: "call_client_owned", type: "function", function: { name: "lookup", arguments: "{\"id\":1}" } }])
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

describe("responsesSseToJson（chat 非流式聚合）", () => {
  const completedFixture = [
    'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4-mini"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4-mini","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi there"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
    'data: [DONE]\n\n',
  ].join("")

  it("优先取 response.completed 的 response 对象", () => {
    expect(responsesSseToJson(completedFixture)).toMatchObject({
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    })
  })

  it("无 completed 时回退最后一个带 response 的事件", () => {
    const raw = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    ].join("")
    expect(responsesSseToJson(raw)).toEqual({ id: "resp_1" })
  })

  it("空流/[DONE]/乱码 → null（调用方回 invalid_upstream_response）", () => {
    expect(responsesSseToJson("")).toBeNull()
    expect(responsesSseToJson("data: [DONE]\n\n")).toBeNull()
    expect(responsesSseToJson("not sse at all")).toBeNull()
    expect(responsesSseToJson('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')).toBeNull()
  })

  it("聚合结果经 responsesJsonToChatCompletion 转出完整 chat JSON（含 usage）", () => {
    const aggregated = responsesSseToJson(completedFixture)
    expect(responsesJsonToChatCompletion({ ...aggregated, id: "resp_1", model: "gpt-5.4-mini" })).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
  })
})

describe("call_id length guard (opencode-go /v1/responses 限制 call_id <= 64)", () => {
  // 2026-09-03 生产事故的缩减版 fixture（muse-spark-1.3-contributor，Cursor 客户端）：
  // 真实消息形态（assistant content 带 reasoning JSON 前缀、cursor_untrusted_data 工具结果、
  // 单轮多 tool_calls）+ 真实 32-35 字符 tool_call id。
  const productionLikeBody = {
    model: "muse-spark-1.3-contributor",
    stream: true,
    max_tokens: 128000,
    messages: [
      { role: "user", content: "帮我在小红书搜一下" },
      {
        role: "assistant",
        content: "{\"type\":\"reasoning\",\"text\":\"先截图看看。\"}截图。",
        tool_calls: [{ id: "call_00_ET_HnjCQGrGcym287ojyIRw5855", type: "function", function: { name: "CallDynamicTool", arguments: "{\"arguments\":{\"description\":\"screenshot\"}}" } }],
      },
      { role: "tool", tool_call_id: "call_00_ET_HnjCQGrGcym287ojyIRw5855", content: "<cursor_untrusted_data_1337 source=\"CallDynamicTool\">\nsaved: 4d72df3f.webp\n</cursor_untrusted_data_1337>" },
      {
        role: "assistant",
        content: "{\"type\":\"reasoning\",\"text\":\"登录成功，回复用户并派主页任务。\"}\n",
        tool_calls: [
          { id: "call_00_7chRippdDvO9rNY1r9KI8718", type: "function", function: { name: "SendToUser", arguments: "{\"text\":\"登录成功了\"}" } },
          { id: "call_01_Kfco8hGpYjHUWDctA3aZ9708", type: "function", function: { name: "CallDynamicTool", arguments: "{\"arguments\":{\"description\":\"open profile\"}}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_00_7chRippdDvO9rNY1r9KI8718", content: "<cursor_untrusted_data_1337 source=\"SendToUser\">\nMessage sent. (id: t133s0)\n</cursor_untrusted_data_1337>" },
      { role: "tool", tool_call_id: "call_01_Kfco8hGpYjHUWDctA3aZ9708", content: "<cursor_untrusted_data_1337 source=\"Task\">\nSubagent is running.\n</cursor_untrusted_data_1337>" },
      { role: "user", content: "我发过什么帖子吗" },
    ],
    tools: [
      { type: "function", function: { name: "SendToUser", parameters: { type: "object", properties: { text: { type: "string" } } } } },
      { type: "function", function: { name: "CallDynamicTool", parameters: { type: "object", properties: { arguments: { type: "object" } } } } },
    ],
    stream_options: { include_usage: true },
  }

  /** 收集 responses input 中所有 id 类字段（function_call 的 id/call_id、function_call_output 的 call_id）。 */
  function collectIds(input: unknown[]): Array<{ index: number; field: string; value: string }> {
    const found: Array<{ index: number; field: string; value: string }> = []
    for (const [index, raw] of input.entries()) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as Record<string, unknown>
      for (const field of ["id", "call_id"] as const) {
        if (typeof item[field] === "string") found.push({ index, field, value: item[field] as string })
      }
    }
    return found
  }

  it("真实请求的 32-35 字符 tool_call id 仅作为 call_id 透传", () => {
    const out = chatRequestToResponses(productionLikeBody)
    const input = out.input as Array<Record<string, unknown>>
    // Responses 的 function_call item 不带客户端 call_* id；对应关系只由 call_id 建立。
    expect(input[2]).toEqual({ type: "function_call", call_id: "call_00_ET_HnjCQGrGcym287ojyIRw5855", name: "CallDynamicTool", arguments: "{\"arguments\":{\"description\":\"screenshot\"}}" })
    expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "call_00_ET_HnjCQGrGcym287ojyIRw5855" })
    expect(input[5]).toMatchObject({ type: "function_call", call_id: "call_00_7chRippdDvO9rNY1r9KI8718" })
    expect(input[6]).toMatchObject({ type: "function_call", call_id: "call_01_Kfco8hGpYjHUWDctA3aZ9708" })
    expect(input[7]).toMatchObject({ type: "function_call_output", call_id: "call_00_7chRippdDvO9rNY1r9KI8718" })
    expect(input[8]).toMatchObject({ type: "function_call_output", call_id: "call_01_Kfco8hGpYjHUWDctA3aZ9708" })
    // 客户端 call_* 不得出现在任何 Responses item 的 id 字段。
    expect(collectIds(input as unknown[]).filter(({ field }) => field === "id")).toEqual([])
    const originals = new Set(["call_00_ET_HnjCQGrGcym287ojyIRw5855", "call_00_7chRippdDvO9rNY1r9KI8718", "call_01_Kfco8hGpYjHUWDctA3aZ9708"])
    for (const { field, value } of collectIds(input as unknown[])) {
      expect(value.length).toBeLessThanOrEqual(64)
      if (field === "call_id") expect(originals.has(value)).toBe(true)
    }
  })

  it("故障单 7b98fd36 的 call_* id 不进入 Responses item.id，且 round-trip 保持一致", () => {
    // 从生产 request_bodies.request_body_json 提取的最小 fixture（2026-09-08）。
    const callId = "call_Yymyjb5870YHM7TYdY2i79Nb"
    const body = {
      model: "gpt-5.6-luna",
      stream: true,
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: callId, type: "function", function: { name: "skill_view", arguments: "{\"file_path\":\"\",\"name\":\"hermes-agent\"}" } }] },
        { role: "tool", tool_call_id: callId, content: "{\"success\":true}" },
      ],
    }
    const input = chatRequestToResponses(body).input as Array<Record<string, unknown>>
    const call = input.find((item) => item.type === "function_call")!
    const output = input.find((item) => item.type === "function_call_output")!
    expect(call).toEqual({ type: "function_call", call_id: callId, name: "skill_view", arguments: "{\"file_path\":\"\",\"name\":\"hermes-agent\"}" })
    expect(call).not.toHaveProperty("id")
    expect(output).toEqual({ type: "function_call_output", call_id: callId, output: "{\"success\":true}" })

    const chat = responsesJsonToChatCompletion({
      id: "resp_roundtrip",
      output: [{ type: "function_call", id: "fc_provider_id", call_id: callId, name: "skill_view", arguments: "{\"file_path\":\"\",\"name\":\"hermes-agent\"}" }],
    })
    expect((chat.choices as Array<{ message: Record<string, unknown> }>)[0].message.tool_calls).toEqual([
      { id: callId, type: "function", function: { name: "skill_view", arguments: "{\"file_path\":\"\",\"name\":\"hermes-agent\"}" } },
    ])
  })

  it("超长 tool_call id（80 字符）压缩到 <=64，且 function_call 与 function_call_output 对应一致", () => {
    const longId = `call_00_ET_${"x7Y".repeat(25)}` // 11 + 75 = 86 字符
    expect(longId.length).toBeGreaterThan(64)
    const body = {
      model: "muse-spark-1.3-contributor",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: longId, type: "function", function: { name: "SendToUser", arguments: "{\"text\":\"ok\"}" } }] },
        { role: "tool", tool_call_id: longId, content: "done" },
      ],
    }
    const run = () => chatRequestToResponses(body).input as Array<Record<string, unknown>>
    const input = run()
    const call = input.find((item) => item.type === "function_call")!
    const output = input.find((item) => item.type === "function_call_output")!
    expect(typeof call.call_id).toBe("string")
    expect((call.call_id as string).length).toBeLessThanOrEqual(64)
    expect(call).not.toHaveProperty("id")
    // call/output 的 call_id 一致对应（同一原始值 → 同一压缩结果）
    expect(output.call_id).toBe(call.call_id)
    // 压缩结果稳定（确定性映射，重跑一致），且保留可辨识前缀
    expect(run()).toEqual(input)
    expect((call.call_id as string).startsWith("call_00_ET_")).toBe(true)
    // 短 id 不受影响（透传分支）
    expect(clampResponsesCallId("call_00_ET_HnjCQGrGcym287ojyIRw5855")).toBe("call_00_ET_HnjCQGrGcym287ojyIRw5855")
    // 边界：恰好 64 透传，65 压缩；压缩结果恰好 64
    expect(clampResponsesCallId("c".repeat(64))).toBe("c".repeat(64))
    const clamped65 = clampResponsesCallId("c".repeat(65))
    expect(clamped65).toHaveLength(64)
    // 多字节字符按 UTF-8 字节计长，且不切断字符产生乱码
    const multibyte = `call_${"小".repeat(30)}` // 5 + 90 = 95 字节
    const clampedMb = clampResponsesCallId(multibyte)
    expect(new TextEncoder().encode(clampedMb).length).toBeLessThanOrEqual(64)
    expect(() => new TextDecoder().decode(new TextEncoder().encode(clampedMb))).not.toThrow()
  })

  it("messages→chat→responses 接力链路同样收敛 call_id（messages 入口回归）", () => {
    const longToolUseId = `toolu_${"z9Q".repeat(30)}` // 6 + 90 = 96 字符
    const chatBody = messagesRequestToChat({
      model: "muse-spark-1.3-contributor",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "查天气" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "查一下" },
            { type: "tool_use", id: longToolUseId, name: "get_weather", input: { city: "杭州" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: longToolUseId, content: "晴 25°C" }] },
      ],
    })
    const input = chatRequestToResponses(chatBody).input as Array<Record<string, unknown>>
    const call = input.find((item) => item.type === "function_call")!
    const output = input.find((item) => item.type === "function_call_output")!
    expect((call.call_id as string).length).toBeLessThanOrEqual(64)
    expect(output.call_id).toBe(call.call_id)
    // 链路上的常规 toolu_ id 透传不改写
    const shortChain = chatRequestToResponses(messagesRequestToChat({
      model: "muse-spark-1.3-contributor",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "晴" }] },
      ],
    })).input as Array<Record<string, unknown>>
    expect(shortChain.find((item) => item.type === "function_call")).toMatchObject({ call_id: "toolu_1" })
    expect(shortChain.find((item) => item.type === "function_call_output")).toMatchObject({ call_id: "toolu_1" })
  })
})

describe("Codex 真实 SSE 形状（2026-09-08 生产直连实测 gpt-5.4-mini）", () => {
  // 真实事件序列：created → in_progress → output_item.added → content_part.added →
  // output_text.delta* → output_text.done → content_part.done → output_item.done → completed。
  // 特征：event: 行 + 单行 data:（无 content-type 响应头，网关靠嗅探识别），
  // 每事件带 sequence_number，delta 带 obfuscation，completed 带 usage + service_tier 回显。
  // 关键真实形状（2026-09-08 生产直连抓包确认，此前 fixture 想当然地写成
  // completed.response.output 含 message，导致单测全绿但生产 content:null）：
  // completed 事件的 response.output 是空数组 []，文本只出现在
  // response.output_item.done 的 item.content[].text；usage 齐全（含 attribution）。
  const codexRealSse = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc","object":"response","created_at":1788791349,"status":"in_progress","model":"gpt-5.4-mini-2026-03-17","service_tier":"auto","output":[]},"sequence_number":0}\n\n',
    'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_abc","status":"in_progress"},"sequence_number":1}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":2}\n\n',
    'event: response.content_part.added\ndata: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"hello","item_id":"msg_1","logprobs":[],"obfuscation":"2K0dxJKA0lE","output_index":0,"sequence_number":4}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":" world","item_id":"msg_1","logprobs":[],"obfuscation":"MDsamTfzxIV","output_index":0,"sequence_number":5}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","logprobs":[],"output_index":0,"sequence_number":8,"text":"hello world"}\n\n',
    'event: response.content_part.done\ndata: {"type":"response.content_part.done","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"hello world"},"sequence_number":9}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"hello world"}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":10}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","status":"completed","model":"gpt-5.4-mini-2026-03-17","service_tier":"default","output":[],"usage":{"input_tokens":18,"input_tokens_details":{"cached_tokens":0},"output_tokens":8,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":26}},"sequence_number":11}\n\n',
  ].join("")

  const sseStreamOf = (text: string, chunkBytes?: number[]) => {
    const bytes = new TextEncoder().encode(text)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (!chunkBytes) { controller.enqueue(bytes); controller.close(); return }
        let offset = 0
        for (const size of chunkBytes) { controller.enqueue(bytes.slice(offset, offset + size)); offset += size }
        if (offset < bytes.length) controller.enqueue(bytes.slice(offset))
        controller.close()
      },
    })
  }
  const chatChunksOf = async (text: string, chunkBytes?: number[]) => {
    const output = await new Response(responsesSseToChatStream(sseStreamOf(text, chunkBytes))).text()
    return output.split("data: ").map((part) => part.trim()).filter(Boolean)
  }
  // role 首 chunk 自带 finish_reason:null：终态判定只看非 null finish_reason。
  const terminalFinish = (chunks: string[]) => chunks.find((c) => c.includes("finish_reason") && !c.includes('"finish_reason":null'))
  const terminalFinishCount = (chunks: string[]) => chunks.filter((c) => c.includes("finish_reason") && !c.includes('"finish_reason":null')).length

  it("looksLikeResponsesSse：无 content-type 的 Codex SSE 能被嗅探，单体 JSON 不误判", () => {
    expect(looksLikeResponsesSse(codexRealSse)).toBe(true)
    expect(looksLikeResponsesSse('event: response.created\ndata: {"type":"x"}\n')).toBe(true)
    expect(looksLikeResponsesSse('{"type":"response.completed","response":{}}')).toBe(false)
    expect(looksLikeResponsesSse('{"data":"x"}')).toBe(false)
    expect(looksLikeResponsesSse("")).toBe(false)
    expect(looksLikeResponsesSse("not sse at all")).toBe(false)
  })

  it("流式：真实形状产出 role/delta/finish+usage/[DONE] 完整序列", async () => {
    const chunks = await chatChunksOf(codexRealSse)
    expect(chunks[0]).toContain('"delta":{"role":"assistant"}')
    expect(chunks.some((c) => c.includes('"content":"hello'))).toBe(true)
    const finish = terminalFinish(chunks)
    expect(finish).toContain('"finish_reason":"stop"')
    expect(finish).toContain('"usage":{"prompt_tokens":18,"completion_tokens":8,"total_tokens":26,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}')
    expect(chunks[chunks.length - 1]).toBe("[DONE]")
    // 无兜底 chunk（终态已见，不应多发）
    expect(terminalFinishCount(chunks)).toBe(1)
  })

  it("流式：事件被 TCP 切碎仍正确组装（chunk 边界任意）", async () => {
    const chunks = await chatChunksOf(codexRealSse, [37, 5, 200, 1, 999, 64])
    expect(chunks.some((c) => c.includes('"content":"hello'))).toBe(true)
    expect(chunks.some((c) => c.includes('"finish_reason":"stop"'))).toBe(true)
    expect(chunks[chunks.length - 1]).toBe("[DONE]")
  })

  it("流式：无空行分隔的单 \\n 形状同样解析（CLIProxyAPI 逐行容忍）", async () => {
    const singleNewline = codexRealSse.replaceAll("\n\n", "\n")
    const chunks = await chatChunksOf(singleNewline)
    expect(chunks.some((c) => c.includes('"content":"hello'))).toBe(true)
    expect(chunks.some((c) => c.includes('"finish_reason":"stop"'))).toBe(true)
    expect(responsesSseToJson(singleNewline)).toMatchObject({ id: "resp_abc", status: "completed" })
  })

  it("流式：上游截断（无 completed 直接断）兜底补 finish_reason:stop 再 [DONE]", async () => {
    const truncated = codexRealSse.split("event: response.output_text.done")[0]
    const chunks = await chatChunksOf(truncated)
    expect(chunks.some((c) => c.includes('"content":"hello'))).toBe(true)
    const finish = terminalFinish(chunks)
    expect(finish).toContain('"finish_reason":"stop"')
    expect(chunks[chunks.length - 1]).toBe("[DONE]")
  })

  it("流式：response.failed 产出 in-band error 对象而非静默截断", async () => {
    const failed = 'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_x","status":"failed","error":{"code":"server_error","message":"boom","type":"server_error"}}}\n\n'
    const chunks = await chatChunksOf(codexRealSse.split("event: response.output_text.done")[0] + failed)
    const err = chunks.find((c) => c.includes('"error"'))
    expect(err).toContain("boom")
    expect(chunks[chunks.length - 1]).toBe("[DONE]")
    // failed 本身是终态：不应再补 stop 兜底
    expect(terminalFinishCount(chunks)).toBe(0)
  })

  it("流式：response.incomplete（max_output_tokens）→ finish_reason:length", async () => {
    const incomplete = 'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_x","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":10,"total_tokens":15}}}\n\n'
    const chunks = await chatChunksOf(codexRealSse.split("event: response.output_text.done")[0] + incomplete)
    const finish = terminalFinish(chunks)
    expect(finish).toContain('"finish_reason":"length"')
  })

  it("非流式聚合：真实形状（completed.output=[]）经 output_item.done 回填补齐文本，供 chat JSON", () => {
    expect(responsesSseToJson(codexRealSse)).toMatchObject({
      id: "resp_abc",
      status: "completed",
      usage: { input_tokens: 18, output_tokens: 8, total_tokens: 26 },
      output: [{ type: "message", content: [{ type: "output_text", text: "hello world" }] }],
    })
    expect(responsesJsonToChatCompletion(responsesSseToJson(codexRealSse))).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 },
    })
  })

  it("非流式聚合：completed.response.output 已含完整 message 时不重复回填（标准 OpenAI 形状）", () => {
    const standardSse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi there"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_std","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi there"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n'
    const aggregated = responsesSseToJson(standardSse)
    expect(aggregated).not.toBeNull()
    expect(aggregated!.output).toHaveLength(1)
    expect(responsesJsonToChatCompletion(aggregated)).toMatchObject({
      choices: [{ message: { content: "hi there" } }],
    })
  })

  it("非流式聚合：截断流（无 completed）回退最后一个 response 并回填 done items", () => {
    const truncated = codexRealSse.split("event: response.completed")[0]
    const aggregated = responsesSseToJson(truncated)
    expect(aggregated).toMatchObject({ id: "resp_abc", status: "in_progress" })
    expect(responsesJsonToChatCompletion(aggregated)).toMatchObject({
      choices: [{ message: { content: "hello world" } }],
    })
  })

  it("mapResponsesFinish：tool_calls 优先于截断；content_filter 透出", () => {
    expect(mapResponsesFinish({ status: "completed", output: [{ type: "function_call", call_id: "c1", name: "f", arguments: "{}" }] })).toBe("tool_calls")
    expect(mapResponsesFinish({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toBe("length")
    expect(mapResponsesFinish({ status: "incomplete", incomplete_details: { reason: "content_filter" } })).toBe("content_filter")
    expect(mapResponsesFinish({ status: "incomplete" })).toBe("length")
    expect(mapResponsesFinish({ status: "completed", output: [] })).toBe("stop")
  })

  it("iterSseDataPayloads：两种分隔形状等价，多 data: 行按原语义拼接", () => {
    const a = iterSseDataPayloads(codexRealSse)
    const b = iterSseDataPayloads(codexRealSse.replaceAll("\n\n", "\n"))
    expect(a.length).toBeGreaterThan(5)
    expect(b).toEqual(a)
  })

  it("[DONE] 与上一事件 data 行相邻（LF 无空行）时独立成帧，不污染 completed 载荷", () => {
    // 2026-09-08 codex 原生直通日志缺口同因：`data: {...completed}\ndata: [DONE]`
    // 若拼成一个 payload，JSON 解析失败导致 completed 的 usage 丢失。
    const raw = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":12,"output_tokens":6,"total_tokens":18}}}\ndata: [DONE]'
    expect(iterSseDataPayloads(raw)).toEqual([
      '{"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":12,"output_tokens":6,"total_tokens":18}}}',
      "[DONE]",
    ])
    // 标准 \n\n 形状不受影响（空行已提前 flush，行为不变）
    const framed = 'event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n'
    expect(iterSseDataPayloads(framed)).toEqual(['{"type":"response.completed"}', "[DONE]"])
  })

  it("hasConvertibleSsePayload：真实/截断流通过，空流与伪装 SSE 不通过", () => {
    expect(hasConvertibleSsePayload(codexRealSse)).toBe(true)
    expect(hasConvertibleSsePayload(codexRealSse.replaceAll("\n\n", "\n"))).toBe(true)
    // 截断流（仅 delta 无终态）：delta 载荷可解析，照常走转换 + 兜底收尾
    expect(hasConvertibleSsePayload(codexRealSse.split("event: response.output_text.done")[0])).toBe(true)
    expect(hasConvertibleSsePayload("")).toBe(false)
    expect(hasConvertibleSsePayload("data: [DONE]\n\n")).toBe(false)
    expect(hasConvertibleSsePayload("not sse at all")).toBe(false)
    // 代理错误页伪装成 SSE 行：嗅探命中但零可解析载荷 → 网关判无效上游响应
    expect(hasConvertibleSsePayload('event: response.created\ndata: <html>502 Bad Gateway</html>\n\n')).toBe(false)
    expect(hasConvertibleSsePayload('event: error\ndata: not json at all\n\n')).toBe(false)
  })
})
