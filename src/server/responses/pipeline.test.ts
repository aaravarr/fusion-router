import { describe, expect, it } from "vitest"
import { createDatabase } from "../db"
import { injectDefaultServerTools, normalizeToolsInBody } from "./tool-schema"
import { prepareResponsesRequestBody, rememberResponsesTurn } from "./pipeline"
import { buildChatFallbackFromResponsesWithContext } from "./responses-fallback"
import { responseToolCallItemFromChatName } from "./codex-chat-compat"
import { sanitizeResponsesInputItems, rememberConversationTurn, extractContinuityKeysFromRequest, loadConversationReasoning } from "./conversation-store"
import { shouldEagerFallbackResponses } from "./responses-fallback"

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
