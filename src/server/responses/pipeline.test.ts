import { describe, expect, it } from "vitest"
import { createDatabase } from "../db"
import { injectDefaultServerTools, normalizeToolsInBody } from "./tool-schema"
import { prepareChatRequestBody, prepareResponsesRequestBody, rememberResponsesTurn } from "./pipeline"
import { buildChatFallbackFromResponsesWithContext } from "./responses-fallback"
import { responseToolCallItemFromChatName } from "./codex-chat-compat"
import { sanitizeResponsesInputItems, rememberConversationTurn, extractContinuityKeysFromRequest, loadConversationReasoning } from "./conversation-store"
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

describe("prepareChatRequestBody developer role 归一化", () => {
  it("把 messages 里的 developer role 映射为 system", () => {
    const body = prepareChatRequestBody({
      model: "minimax-m3",
      messages: [
        { role: "developer", content: "你是识图助手" },
        { role: "user", content: "看看这张图" },
      ],
    }) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"])
    // 不改写其它字段
    expect(body.messages[0]).toEqual({ role: "system", content: "你是识图助手" })
  })

  it("没有 developer role 时原样返回", () => {
    const input = { model: "minimax-m3", messages: [{ role: "user", content: "hi" }] }
    const body = prepareChatRequestBody(input) as { messages: Array<{ role: string }> }
    expect(body.messages[0].role).toBe("user")
  })

  it("非对象消息（如畸形输入）不崩溃", () => {
    const body = prepareChatRequestBody({ model: "minimax-m3", messages: [null, "x", { role: "developer", content: "d" }] }) as { messages: unknown[] }
    expect(body.messages[1]).toBe("x")
    expect((body.messages[2] as { role: string }).role).toBe("system")
  })
})

describe("prepareChatRequestBody reasoning 参数去重", () => {
  it("同时携带 reasoning.effort 与 reasoning_effort 时去重为 reasoning_effort", () => {
    const body = prepareChatRequestBody({
      model: "stealth/ox-alpha",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
      reasoning_effort: "low",
    }) as Record<string, unknown>
    expect(body.reasoning_effort).toBe("high")
    expect(body.reasoning).toBeUndefined()
  })

  it("仅 reasoning.effort 时保留", () => {
    const body = prepareChatRequestBody({
      model: "stealth/ox-alpha",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "low" },
    }) as Record<string, unknown>
    expect(body.reasoning_effort).toBe("low")
  })

  it("仅 reasoning_effort 时保留", () => {
    const body = prepareChatRequestBody({
      model: "stealth/ox-alpha",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    }) as Record<string, unknown>
    expect(body.reasoning_effort).toBe("high")
  })

  it("无 reasoning 参数时不注入", () => {
    const body = prepareChatRequestBody({
      model: "stealth/ox-alpha",
      messages: [{ role: "user", content: "hi" }],
    }) as Record<string, unknown>
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })
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

  it("whitelisted muse-spark-1.2-contributor stays on native responses on second consecutive turn despite chat lineage (session_lineage_chat -> responses_native)", async () => {
    const db = createDatabase(":memory:")
    const threadId = "t-whitelist-2turn"
    // 第一条：新会话，无 lineage，muse-spark-1.2-contributor 走原生 responses
    const first = await prepareResponsesRequestBody({
      model: "muse-spark-1.2-contributor",
      client_metadata: { thread_id: threadId },
      input: "hello first",
    }, { db, injectServerTools: false })
    expect(first.route).toBe("responses")
    expect(first.routeReason).toBe("responses_native")
    // 模拟服务端已记住该会话且 preferredMode 为 chat（例如首条走 chat 后的血缘）
    await rememberConversationTurn({
      responseId: "resp_first",
      previousKeys: [`thread:${threadId}`],
      preferredMode: "chat",
      messages: [{ role: "user", content: "hello first" }],
      db,
    })
    // 第二条：同线程、同模型，命中 session_lineage_chat 但白名单应豁免，仍走原生 responses
    const second = await prepareResponsesRequestBody({
      model: "muse-spark-1.2-contributor",
      client_metadata: { thread_id: threadId },
      input: "hello second",
    }, { db, injectServerTools: false })
    expect(second.route).toBe("responses")
    expect(second.routeReason).toBe("responses_native")
    // 对照：非白名单模型在同样 chat lineage 下应被强制转 chat
    const third = await prepareResponsesRequestBody({
      model: "gpt-4o-mini",
      client_metadata: { thread_id: threadId },
      input: "hello second non-whitelisted",
    }, { db, injectServerTools: false })
    expect(third.route).toBe("chat")
    expect(third.routeReason).toBe("session_lineage_chat")
    db.close()
  })

  it("白名单模型携带 encrypted reasoning 回显时保持原生 responses (foreign_opaque:reasoning 豁免)", async () => {
    const db = createDatabase(":memory:")
    // 模拟上游 responses 产出的 encrypted reasoning 被客户端按协议回显进 input（请求 38687ae2 复现）
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2-contributor",
      input: [{ type: "reasoning", encrypted_content: "blob-xyz-opaque-reasoning", summary: [] }],
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("responses")
    expect(prepared.routeReason).toBe("responses_native")
    // 原生 responses 路径会对 opaque 项保留：sanitizeResponsesInputItems 不剥离带 encrypted_content 的 reasoning
    const bodyInput = (prepared.body as unknown as { input: Array<Record<string, unknown>> }).input
    expect(Array.isArray(bodyInput)).toBe(true)
    const reasoning = bodyInput.find((it) => String(it.type).toLowerCase() === "reasoning")
    expect(reasoning).toBeTruthy()
    expect(reasoning?.encrypted_content).toBe("blob-xyz-opaque-reasoning")
    db.close()
  })

  it("非白名单模型同 encrypted reasoning 回显仍转 chat (foreign_opaque:reasoning)", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-4o-mini",
      input: [{ type: "reasoning", encrypted_content: "blob-xyz-opaque-reasoning", summary: [] }],
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toMatch(/foreign_opaque:reasoning/)
    db.close()
  })

  it("白名单模型命中 foreign_history:* 时也保持原生 responses", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-5.6-luna",
      previous_response_id: "resp_foreign_123",
      input: [{ type: "reasoning", encrypted_content: "blob-history-opaque", summary: [] }],
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("responses")
    expect(prepared.routeReason).toBe("responses_native")
    db.close()
  })

  it("非白名单模型命中 foreign_history:* 仍转 chat", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-4o-mini",
      previous_response_id: "resp_foreign_123",
      input: [{ type: "reasoning", encrypted_content: "blob-history-opaque", summary: [] }],
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toMatch(/foreign_history:/)
    db.close()
  })

  it("白名单模型命中 foreign_previous_response_id 不豁免，仍转 chat", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2",
      previous_response_id: "resp_missing_not_in_store",
      input: "continue without opaque",
    }, { db, injectServerTools: false })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toBe("foreign_previous_response_id")
    db.close()
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
describe("include 注入（C 项）", () => {
  it("白名单模型自动补 reasoning.encrypted_content 并去重", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2-contributor",
      input: "hi",
      include: ["reasoning.encrypted_content", "other"],
    }, { db })
    const body = prepared.body as unknown as Record<string, unknown>
    expect(Array.isArray(body.include)).toBe(true)
    expect(body.include).toContain("reasoning.encrypted_content")
    // 去重：不应重复
    expect(body.include.filter((v: string) => v === "reasoning.encrypted_content").length).toBe(1)
    expect(body.include).toContain("other")
    db.close()
  })

  it("白名单模型无 include 时自动补", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2",
      input: "hi",
    }, { db })
    expect((prepared.body as unknown as Record<string, unknown>).include).toEqual(["reasoning.encrypted_content"])
    db.close()
  })

  it("白名单模型合并用户已有 include 并去重", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-5.6-luna",
      input: "hi",
      include: ["code", "reasoning.encrypted_content", "code"],
    }, { db })
    const inc = (prepared.body as unknown as Record<string, unknown>).include as unknown as string[]
    expect(inc).toEqual(["code", "reasoning.encrypted_content"])
    db.close()
  })

  it("非白名单模型不动", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "gpt-4o-mini",
      input: "hi",
      include: ["other"],
    }, { db })
    expect((prepared.body as unknown as Record<string, unknown>).include).toEqual(["other"])
    const prepared2 = await prepareResponsesRequestBody({
      model: "gpt-4o-mini",
      input: "hi",
    }, { db })
    expect((prepared2.body as unknown as Record<string, unknown>).include).toBeUndefined()
    db.close()
  })
})

describe("血缘豁免统一（G 项）", () => {
  it("白名单 + foreign_previous_response_id 且 input 含 encrypted_content 时豁免（responses_native）", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2-contributor",
      previous_response_id: "resp_missing_123",
      input: [{ type: "reasoning", encrypted_content: "blob-xyz", summary: [] }],
    }, { db })
    expect(prepared.route).toBe("responses")
    expect(prepared.routeReason).toBe("responses_native")
    db.close()
  })

  it("白名单 + foreign_previous_response_id 且 lineage.storeHit 为 true 时豁免", async () => {
    const db = createDatabase(":memory:")
    // 先写入一条 lineage，使 storeHit 为 true（通过 thread 命中，非 previous_response_id 本身）
    await rememberConversationTurn({
      responseId: "resp_thread_known",
      previousKeys: ["thread:g-test"],
      preferredMode: "responses",
      db,
    })
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2",
      previous_response_id: "resp_foreign_not_in_store",
      input: "continue",
      client_metadata: { thread_id: "g-test" },
    }, { db })
    // 由于 lineage.hit 为 true（thread 命中），即使 previous_response_id 指向外部，也应视为协议内连续性而豁免，不降级
    expect(prepared.route).toBe("responses")
    // routeReason 可能为 session_lineage_responses（因 hit 导致不 eager）或 responses_native（豁免），均视为未降级
    expect(["responses_native", "session_lineage_responses"]).toContain(prepared.routeReason)
    db.close()
  })

  it("白名单 + foreign_previous_response_id 且两者皆无时不豁免（转 chat）", async () => {
    const db = createDatabase(":memory:")
    const prepared = await prepareResponsesRequestBody({
      model: "muse-spark-1.2-contributor",
      previous_response_id: "resp_missing_not_in_store",
      input: "continue without opaque",
    }, { db })
    expect(prepared.route).toBe("chat")
    expect(prepared.routeReason).toBe("foreign_previous_response_id")
    db.close()
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