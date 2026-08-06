import { describe, expect, it } from "vitest"
import { createDatabase } from "../db"
import { injectDefaultServerTools, normalizeToolsInBody } from "./tool-schema"
import { prepareResponsesRequestBody, rememberResponsesTurn } from "./pipeline"
import { buildChatFallbackFromResponsesWithContext } from "./responses-fallback"
import { responseToolCallItemFromChatName } from "./codex-chat-compat"
import { sanitizeResponsesInputItems, reorderResponsesInputItems, rememberConversationTurn, extractContinuityKeysFromRequest, loadConversationReasoning } from "./conversation-store"
import { shouldEagerFallbackResponses } from "./responses-fallback"

describe("sanitizeResponsesInputItems 归一化历史消息 part", () => {
  it("把 chat 变体 text/image_url 归一化为 input_text/input_image", async () => {
    const db = createDatabase(":memory:")
    const result = await sanitizeResponsesInputItems({
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    }, db)
    expect(result.modified).toBe(true)
    const input = (result.body as any).input as Array<{ type: string; content: Array<{ type: string }> }>
    expect(input[0].content[0].type).toBe("input_text")
    expect(input[0].content[1].type).toBe("input_image")
    expect(input[1].content[0].type).toBe("output_text") // 合法变体保持不变
    db.close()
  })

  it("纯合法 responses 变体不改写", async () => {
    const db = createDatabase(":memory:")
    const result = await sanitizeResponsesInputItems({
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }, db)
    expect(result.modified).toBe(false)
    db.close()
  })
})

describe("responses tool-schema", () => {
  it("injects default web_search and x_search", () => {
    const body = injectDefaultServerTools({ model: "grok-4.5", input: "hi" }, { enabled: true, tools: ["web_search", "x_search"] }) as any
    expect(body.tools).toEqual(expect.arrayContaining([{ type: "web_search" }, { type: "x_search" }]))
  })

  it("flattens nested function tools for responses mode", () => {
    const body = normalizeToolsInBody({
      model: "grok-4.5",
      tools: [{ type: "function", function: { name: "lookup", description: "d", parameters: { type: "object", properties: {} } } }],
    }, { mode: "responses" }) as any
    expect(body.tools[0]).toMatchObject({ type: "function", name: "lookup" })
    expect(body.tools[0].function).toBeUndefined()
  })

  it("passes through x_search server tools", () => {
    const body = normalizeToolsInBody({
      model: "grok-4.5",
      tools: [{ type: "x_search" }],
    }, { mode: "responses" }) as any
    expect(body.tools[0]).toMatchObject({ type: "x_search" })
  })
})

describe("responses pipeline", () => {
  it("prepareResponsesRequestBody injects server tools only for paid accounts", async () => {
    const db = createDatabase(":memory:")
    const freePrepared = await prepareResponsesRequestBody({
      model: "grok-4.5",
      input: "Search recent posts about Elon Musk",
      tools: [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }],
      tool_choice: "required",
    }, { db, paidAccount: false })
    const freeTools = (freePrepared.body as any).tools as Array<{ type: string; name?: string }>
    expect(freePrepared.route).toBe("responses")
    expect(freeTools.some((t) => t.type === "web_search")).toBe(false)
    expect(freeTools.some((t) => t.type === "x_search")).toBe(false)
    expect(freePrepared.meta.injectedTools).toBe(false)

    const paidPrepared = await prepareResponsesRequestBody({
      model: "grok-4.5",
      input: "Search recent posts about Elon Musk",
      tools: [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }],
      tool_choice: "required",
    }, { db, paidAccount: true })
    const paidTools = (paidPrepared.body as any).tools as Array<{ type: string; name?: string }>
    expect(paidTools.some((t) => t.type === "web_search")).toBe(true)
    expect(paidTools.some((t) => t.type === "x_search")).toBe(true)
    expect(paidTools.some((t) => t.type === "function" && t.name === "noop")).toBe(true)
    expect(paidPrepared.meta.injectedTools).toBe(true)
  })

  it("sanitizes custom_tool_call into function_call", async () => {
    const db = createDatabase(":memory:")
    const result = await sanitizeResponsesInputItems({
      model: "grok-4.5",
      input: [{ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "diff" }],
    }, db)
    expect(result.modified).toBe(true)
    expect((result.body as any).input[0]).toMatchObject({
      type: "function_call",
      name: "apply_patch",
      call_id: "c1",
    })
    expect(JSON.parse((result.body as any).input[0].arguments)).toEqual({ input: "diff" })
  })

  it("eager falls back to chat on foreign previous_response_id without store hit when no server tools", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-test",
      previous_response_id: "resp_missing_123",
      input: "continue",
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toContain("foreign_previous_response_id")
    expect((prepared.body as any).messages).toBeTruthy()
  })

  it("eager falls back to chat on foreign opaque items when no server tools", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-test",
      input: [{ type: "reasoning", encrypted_content: "blob-xyz", summary: [] }],
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toMatch(/foreign_opaque/)
  })

  it("free Grok with foreign previous_response_id eagers to chat when no server tools present", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "grok-4.5",
      previous_response_id: "resp_missing_123",
      input: "continue",
    }, { db, paidAccount: false })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toContain("foreign_previous_response_id")
  })

  it("paid Grok injects server tools and stays on responses despite foreign previous_response_id", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "grok-4.5",
      previous_response_id: "resp_missing_123",
      input: "Use x_search to find recent posts about Elon Musk",
    }, { db, paidAccount: true })
    expect(prepared.route).toBe("responses")
    expect(prepared.routeReason).toBe("prefer_responses_server_tools")
    const tools = (prepared.body as any).tools as Array<{ type: string }>
    expect(tools.some((t) => t.type === "x_search")).toBe(true)
    expect(tools.some((t) => t.type === "web_search")).toBe(true)
  })

  it("keeps responses route when paid account injects server tools even on chat lineage", async () => {
    const db = createDatabase(":memory:")
    await rememberConversationTurn({
      responseId: "resp_known",
      previousKeys: ["thread:t1"],
      preferredMode: "chat",
      messages: [{ role: "user", content: "hi" }],
      db,
    })
    const prepared = await prepareResponsesRequestBody({
      model: "grok-4.5",
      client_metadata: { thread_id: "t1" },
      input: "search again",
    }, { db, paidAccount: true })
    expect(prepared.route).toBe("responses")
    expect(prepared.routeReason).toBe("prefer_responses_server_tools")
  })
})

describe("shouldEagerFallbackResponses", () => {
  it("chat lineage without server tools eagers", () => {
    const r = shouldEagerFallbackResponses({ model: "x", input: "hi" }, { preferredMode: "chat", preferResponsesForServerTools: false })
    expect(r.eager).toBe(true)
  })

  it("responses lineage never eagers", () => {
    const r = shouldEagerFallbackResponses({ model: "x", previous_response_id: "resp_1", input: "hi" }, { preferredMode: "responses", storeHit: false })
    expect(r.eager).toBe(false)
  })

  it("server tools preference blocks all eager fallbacks", () => {
    const r = shouldEagerFallbackResponses(
      { model: "grok-4.5", previous_response_id: "resp_1", input: [{ type: "reasoning", encrypted_content: "x" }] },
      { preferredMode: "chat", storeHit: false, preferResponsesForServerTools: true },
    )
    expect(r.eager).toBe(false)
    expect(r.reason).toBe("prefer_responses_server_tools")
  })

  it("server tools preference does not override when already staying on responses", () => {
    const r = shouldEagerFallbackResponses(
      { model: "grok-4.5", input: "Use x_search", tools: [{ type: "x_search" }] },
      { preferResponsesForServerTools: true },
    )
    expect(r.eager).toBe(false)
    expect(r.reason).toBeUndefined()
  })
})

describe("continuity keys", () => {
  it("prefers thread id", () => {
    const keys = extractContinuityKeysFromRequest({
      client_metadata: { thread_id: "abc" },
      previous_response_id: "resp_1",
    })
    expect(keys[0]).toBe("thread:abc")
  })
})


describe("reasoning persistence", () => {
  it("remembers tool-turn reasoning and loads it back in order", async () => {
    const db = createDatabase(":memory:")
    await rememberConversationTurn({
      responseId: "resp_tool_1",
      previousKeys: ["thread:t2"],
      reasoningItems: [
        { reasoning_content: "first", responseId: "resp_tool_1" },
        { reasoning_content: "dup", responseId: "resp_tool_1" },
      ],
      db,
    })
    await rememberConversationTurn({
      responseId: "resp_tool_2",
      previousKeys: ["thread:t2"],
      reasoningItems: [{ reasoning_content: "second", responseId: "resp_tool_2" }],
      db,
    })
    expect(await loadConversationReasoning(["thread:t2"], db)).toEqual(["first", "second"])
  })

  it("only saves reasoning when the response output also has tool calls", async () => {
    const db = createDatabase(":memory:")
    await rememberResponsesTurn({
      responsePayload: {
        id: "resp_1",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "tool reasoning" }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "ok" },
        ],
      },
      responseId: "resp_1",
      continuityKeys: ["thread:t3"],
      db,
    })
    await rememberResponsesTurn({
      responsePayload: {
        id: "resp_2",
        output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "plain reasoning" }] }],
      },
      responseId: "resp_2",
      continuityKeys: ["thread:t3"],
      db,
    })
    expect(await loadConversationReasoning(["thread:t3"], db)).toEqual(["tool reasoning"])
  })
})
describe("namespace tools survive chat fallback", () => {
  it("keeps namespace declarations and restores short names for function_call", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "deepseek-v4-flash",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object", properties: { message: { type: "string" } } } },
          ],
        },
      ],
    }, { db })
    expect(prepared.route).toBe("responses")
    const rawTools = (prepared.responsesBody as any).tools as Array<{ type: string }>
    expect(rawTools[0].type).toBe("namespace")

    const converted = buildChatFallbackFromResponsesWithContext(prepared.responsesBody)
    const chatTools = (converted.body as any).tools as Array<{ function?: { name?: string } }>
    expect(chatTools[0].function?.name).toBe("multi_agent_v1__spawn_agent")

    const item = responseToolCallItemFromChatName({
      callId: "call_1",
      chatName: "multi_agent_v1__spawn_agent",
      argumentsStr: '{"message":"hi"}',
      ctx: converted.toolContext,
    })
    expect(item).toMatchObject({ type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1" })
  })
})

describe("reorderResponsesInputItems 重排 function_call 配对", () => {
  it("function_call 与 output 之间夹 message 时重排为相邻", () => {
    const { body, modified } = reorderResponsesInputItems({
      input: [
        { type: "function_call", call_id: "call_1", name: "calc", arguments: "{}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "正在计算" }] },
        { type: "function_call_output", call_id: "call_1", output: "2" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "结果" }] },
      ],
    })
    expect(modified).toBe(true)
    const input = (body as any).input as Array<{ type: string; call_id?: string }>
    const types = input.map((i) => i.type)
    expect(types).toEqual(["function_call", "function_call_output", "message", "message"])
    expect(input[0].call_id).toBe("call_1")
    expect(input[1].call_id).toBe("call_1")
  })

  it("并行多个 call 且 output 交错时拆成相邻组", () => {
    const { body, modified } = reorderResponsesInputItems({
      input: [
        { type: "function_call", call_id: "call_a", name: "a", arguments: "{}" },
        { type: "function_call", call_id: "call_b", name: "b", arguments: "{}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "并行中" }] },
        { type: "function_call_output", call_id: "call_a", output: "A" },
        { type: "function_call_output", call_id: "call_b", output: "B" },
      ],
    })
    expect(modified).toBe(true)
    const input = (body as any).input as Array<{ type: string; call_id?: string }>
    const types = input.map((i) => i.type)
    // call_a 与其 output 相邻，call_b 与其 output 相邻，message 移到末尾
    expect(types).toEqual(["function_call", "function_call_output", "function_call", "function_call_output", "message"])
    expect(input[0].call_id).toBe("call_a")
    expect(input[1].call_id).toBe("call_a")
    expect(input[2].call_id).toBe("call_b")
    expect(input[3].call_id).toBe("call_b")
  })

  it("已相邻的配对保持不变（modified=false）", () => {
    const { body, modified } = reorderResponsesInputItems({
      input: [
        { type: "function_call", call_id: "call_1", name: "calc", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "2" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "结果" }] },
      ],
    })
    expect(modified).toBe(false)
    const input = (body as any).input as Array<{ type: string }>
    expect(input.map((i) => i.type)).toEqual(["function_call", "function_call_output", "message"])
  })

  it("未配对的 function_call 被丢弃，其余正常", () => {
    const { body, modified } = reorderResponsesInputItems({
      input: [
        { type: "function_call", call_id: "call_1", name: "calc", arguments: "{}" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    })
    expect(modified).toBe(true)
    const input = (body as any).input as Array<{ type: string }>
    // call_1 无 output → 丢弃，message 保留
    expect(input.map((i) => i.type)).toEqual(["message"])
  })
})
