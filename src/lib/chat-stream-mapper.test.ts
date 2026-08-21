import { describe, expect, it } from "vitest"
import {
  createChatStreamState,
  deriveToolVariant,
  detectRenderIntent,
  extractFilePath,
  extractStreamError,
  finalizeStreamState,
  parseReadLines,
  parseToolArguments,
  parseUnifiedDiff,
  reduceChatStreamEvent,
  summarizeToolCall,
  toolTitle,
} from "./chat-stream-mapper"

describe("deriveToolVariant", () => {
  it("maps tool names to their display variant", () => {
    expect(deriveToolVariant("bash")).toBe("bash")
    expect(deriveToolVariant("read_file")).toBe("read")
    expect(deriveToolVariant("grep")).toBe("search")
    expect(deriveToolVariant("web_search")).toBe("search")
    expect(deriveToolVariant("write_file")).toBe("write")
    expect(deriveToolVariant("replace_in_file")).toBe("edit")
    expect(deriveToolVariant("run_code")).toBe("code")
    expect(deriveToolVariant("pwsh")).toBe("bash")
  })

  it("normalizes casing and separators", () => {
    expect(deriveToolVariant("ReadFile")).toBe("read")
    expect(deriveToolVariant("read-file")).toBe("read")
    expect(deriveToolVariant("read file")).toBe("read")
  })

  it("falls back to other for unknown tools", () => {
    expect(deriveToolVariant("totally_unknown_tool")).toBe("other")
    expect(toolTitle("other")).toBe("Tool")
  })
})

describe("summarizeToolCall", () => {
  it("summarizes read with path and line count", () => {
    const summary = summarizeToolCall("read_file", JSON.stringify({ path: "src/chat/stream.ts", totalLines: 412 }))
    expect(summary).toBe("src/chat/stream.ts · 412 行")
  })

  it("summarizes search with pattern and hit count", () => {
    const summary = summarizeToolCall("grep", JSON.stringify({ pattern: "tool_calls", hits: 24 }))
    expect(summary).toBe("pattern: tool_calls · 24 处命中")
  })

  it("summarizes bash with command", () => {
    const summary = summarizeToolCall("bash", JSON.stringify({ command: "pnpm typecheck" }))
    expect(summary).toBe("pnpm typecheck")
  })

  it("summarizes write/edit with path", () => {
    expect(summarizeToolCall("write_file", JSON.stringify({ file_path: "a.ts" }))).toBe("a.ts")
    expect(summarizeToolCall("edit_file", JSON.stringify({ path: "b.ts" }))).toBe("b.ts")
  })

  it("falls back to the raw name when args are empty", () => {
    expect(summarizeToolCall("read_file", "")).toBe("read_file")
    expect(summarizeToolCall("read_file", "not json")).toBe("read_file")
  })
})

describe("parseToolArguments", () => {
  it("parses valid JSON and tolerates garbage", () => {
    expect(parseToolArguments(JSON.stringify({ a: 1 }))).toEqual({ a: 1 })
    expect(parseToolArguments("not json")).toEqual({})
    expect(parseToolArguments(undefined)).toEqual({})
  })
})

describe("extractFilePath", () => {
  it("extracts path for file-oriented tools only", () => {
    expect(extractFilePath("read_file", JSON.stringify({ path: "x.ts" }))).toBe("x.ts")
    expect(extractFilePath("bash", JSON.stringify({ path: "x.ts" }))).toBe("")
  })
})

describe("extractStreamError", () => {
  it("reads error from several shapes", () => {
    expect(extractStreamError({ error: "boom" })).toBe("boom")
    expect(extractStreamError({ error: { message: "nested" } })).toBe("nested")
    expect(extractStreamError({ type: "error", message: "typed" })).toBe("typed")
    expect(extractStreamError({ type: "response.completed" })).toBe(null)
  })
})

describe("reduceChatStreamEvent — chat/completions", () => {
  it("accumulates text and reasoning deltas", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { choices: [{ delta: { content: "hel" } }] })
    state = reduceChatStreamEvent(state, { choices: [{ delta: { content: "lo", reasoning_content: "think" } }] })
    expect(state.content).toBe("hello")
    expect(state.reasoning).toBe("think")
  })

  it("merges tool_calls deltas by index into a single running call", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"" } }] } }] })
    state = reduceChatStreamEvent(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: "src/a.ts\"}" } }] } }] })
    expect(state.toolCalls).toHaveLength(1)
    const call = state.toolCalls[0]
    expect(call.name).toBe("read_file")
    expect(call.state).toBe("running")
    expect(call.variant).toBe("read")
    expect(call.arguments).toBe("{\"path\":\"src/a.ts\"}")
    expect(call.summary).toBe("src/a.ts")
  })
})

describe("reduceChatStreamEvent — responses", () => {
  it("accumulates output_text and reasoning deltas", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { type: "response.output_text.delta", delta: "ok " })
    state = reduceChatStreamEvent(state, { type: "response.reasoning_text.delta", delta: "r1" })
    expect(state.content).toBe("ok ")
    expect(state.reasoning).toBe("r1")
  })

  it("creates a running call on output_item.added and appends argument deltas", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "bash", call_id: "call_9", arguments: "{\"command\":\"p" } })
    state = reduceChatStreamEvent(state, { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "npm test\"}" })
    expect(state.toolCalls).toHaveLength(1)
    expect(state.toolCalls[0].id).toBe("fc_1")
    expect(state.toolCalls[0].summary).toBe("pnpm test")
  })

  it("marks a call ok when output_item.done carries output", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "grep", arguments: "{}" } })
    state = reduceChatStreamEvent(state, { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", name: "grep", arguments: "{}", status: "completed", output: "3 matches" } })
    expect(state.toolCalls[0].state).toBe("ok")
    expect(state.toolCalls[0].output).toBe("3 matches")
  })

  it("marks a call error on failed status", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "bash", arguments: "{}" } })
    state = reduceChatStreamEvent(state, { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", name: "bash", arguments: "{}", status: "failed" } })
    expect(state.toolCalls[0].state).toBe("error")
  })
})

describe("finalizeStreamState", () => {
  it("turns still-running calls into stopped", () => {
    let state = createChatStreamState()
    state = reduceChatStreamEvent(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{}" } }] } }] })
    const finalized = finalizeStreamState(state)
    expect(finalized.toolCalls[0].state).toBe("stopped")
  })
})

describe("render intent parsing", () => {
  it("detects diff output", () => {
    const diff = "@@ -1,2 +1,2 @@\n-old\n+new"
    expect(detectRenderIntent("apply_patch", diff)).toBe("diff")
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].rows[0]).toEqual({ type: "del", oldLine: 1, text: "old" })
    expect(hunks[0].rows[1]).toEqual({ type: "add", newLine: 1, text: "new" })
  })

  it("detects read output with numbered lines", () => {
    const read = "1 | export function a() {}\n2 | }"
    expect(detectRenderIntent("read_file", read)).toBe("read")
    expect(parseReadLines(read)).toEqual(["1 | export function a() {}", "2 | }"])
  })

  it("defaults to io intent for plain output", () => {
    expect(detectRenderIntent("bash", "exit 0")).toBe("io")
  })
})

