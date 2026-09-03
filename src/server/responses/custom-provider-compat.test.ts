import { describe, expect, it } from "vitest"
import { chatRequestToResponses, clampResponsesCallId, responsesJsonToChatCompletion, responsesSseToChatStream } from "./custom-provider-compat"
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
        { type: "function_call", id: "call_1", call_id: "call_1", name: "lookup", arguments: "{\"id\":1}" },
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
      { role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: { url: "https://x/a.png" } }] },
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "input_text", text: "ok" }] },
    ])
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

  it("真实请求的 32-35 字符 tool_call id 全部原样透传（不改写）", () => {
    const out = chatRequestToResponses(productionLikeBody)
    const input = out.input as Array<Record<string, unknown>>
    // 真实事故的报错位置形态：function_call 的 id/call_id 与 function_call_output 的 call_id
    expect(input[2]).toEqual({ type: "function_call", id: "call_00_ET_HnjCQGrGcym287ojyIRw5855", call_id: "call_00_ET_HnjCQGrGcym287ojyIRw5855", name: "CallDynamicTool", arguments: "{\"arguments\":{\"description\":\"screenshot\"}}" })
    expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "call_00_ET_HnjCQGrGcym287ojyIRw5855" })
    expect(input[5]).toMatchObject({ type: "function_call", id: "call_00_7chRippdDvO9rNY1r9KI8718", call_id: "call_00_7chRippdDvO9rNY1r9KI8718" })
    expect(input[6]).toMatchObject({ type: "function_call", id: "call_01_Kfco8hGpYjHUWDctA3aZ9708", call_id: "call_01_Kfco8hGpYjHUWDctA3aZ9708" })
    expect(input[7]).toMatchObject({ type: "function_call_output", call_id: "call_00_7chRippdDvO9rNY1r9KI8718" })
    expect(input[8]).toMatchObject({ type: "function_call_output", call_id: "call_01_Kfco8hGpYjHUWDctA3aZ9708" })
    // 全部 id 字段均在 64 内且与客户端原始值逐一相等
    const originals = new Set(["call_00_ET_HnjCQGrGcym287ojyIRw5855", "call_00_7chRippdDvO9rNY1r9KI8718", "call_01_Kfco8hGpYjHUWDctA3aZ9708"])
    for (const { value } of collectIds(input as unknown[])) {
      expect(value.length).toBeLessThanOrEqual(64)
      expect(originals.has(value)).toBe(true)
    }
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
    expect((call.id as string).length).toBeLessThanOrEqual(64)
    // call/output 的 call_id 一致对应（同一原始值 → 同一压缩结果）
    expect(output.call_id).toBe(call.call_id)
    expect(call.id).toBe(call.call_id)
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
