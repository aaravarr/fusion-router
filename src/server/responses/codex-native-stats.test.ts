import { describe, expect, it } from "vitest"
import { extractCodexNativeStreamStats, isCodexNativeStreamShape } from "./codex-native-stats"

// 生产实测的 Codex 真实 SSE 形状（openai-codex-chat.test.ts 692cbca fixture，
// openai 池 chatgpt.com/backend-api/codex 原生 responses 直通流同形）：
// 无 content-type、LF 分行（本用例刻意用单 \n 无空行，还原生产最严苛形态）、
// 10 事件序列 created→…→output_text.delta→…→completed（completed 带 usage 12/6/18）。
const CODEX_LF_EVENTS = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":1788832908,"status":"in_progress","model":"gpt-5.4-mini-2026-03-17","output":[]},"sequence_number":0}',
  'event: response.in_progress',
  'data: {"type":"response.in_progress","response":{"id":"resp_1","status":"in_progress"},"sequence_number":1}',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":2}',
  'event: response.content_part.added',
  'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","content_index":0,"delta":"hi","item_id":"msg_1","logprobs":[],"obfuscation":"sOOd49BSM8K","output_index":0,"sequence_number":4}',
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","logprobs":[],"output_index":0,"sequence_number":5,"text":"hi"}',
  'event: response.content_part.done',
  'data: {"type":"response.content_part.done","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"hi"},"sequence_number":6}',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"hi"}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":7}',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4-mini-2026-03-17","service_tier":"default","output":[],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":18}},"sequence_number":8}',
  'data: [DONE]',
].join("\n")

describe("codex-native-stats Codex 原生直通流日志指标提取", () => {
  it("LF 无空行 Codex 真实形状：matched 且 usage=12/6/18（含 cached/reasoning）", () => {
    expect(isCodexNativeStreamShape(CODEX_LF_EVENTS)).toBe(true)
    const stats = extractCodexNativeStreamStats(CODEX_LF_EVENTS)
    expect(stats.matched).toBe(true)
    expect(stats.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 6,
      totalTokens: 18,
      cachedTokens: 0,
      reasoningTokens: 0,
    })
  })

  it("首内容序号指向 output_text.delta（空 content 首帧不算，delta 为首个内容载荷）", () => {
    const stats = extractCodexNativeStreamStats(CODEX_LF_EVENTS)
    expect(stats.firstContentIndex).toBeDefined()
    // created(0) → in_progress(1) → output_item.added(2) → content_part.added(3) → delta(4)
    // data 载荷按 data: 行计数：created=0, in_progress=1, added=2, part.added=3, delta=4
    expect(stats.firstContentIndex).toBe(4)
  })

  it("\\n\\n 空行分帧同形状等价（remap 后形态同样命中）", () => {
    const framed = CODEX_LF_EVENTS.replaceAll("\n", "\n\n").replaceAll("\n\n\n", "\n\n")
    const lf = extractCodexNativeStreamStats(CODEX_LF_EVENTS)
    const fr = extractCodexNativeStreamStats(framed)
    expect(fr.matched).toBe(true)
    expect(fr.usage).toEqual(lf.usage)
    expect(fr.firstContentIndex).toBe(lf.firstContentIndex)
  })

  it("无 completed 的截断流：回退最后一个带 usage 的事件（不断流、不记空）", () => {
    const truncated = CODEX_LF_EVENTS.split("event: response.completed")[0]
    const stats = extractCodexNativeStreamStats(truncated)
    expect(stats.matched).toBe(true)
    // 截断形状无 usage 事件 → usage 保持 undefined（调用方 capture 同样无 usage，不伪造）
    expect(stats.usage).toBeUndefined()
    expect(stats.firstContentIndex).toBe(4)
  })

  it("标准 chat SSE（muse/glm 形态）不误判：无 response.* 载荷 → matched=false", () => {
    const chatSse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "data: [DONE]",
    ].join("\n\n")
    expect(isCodexNativeStreamShape(chatSse)).toBe(false)
    expect(extractCodexNativeStreamStats(chatSse).matched).toBe(false)
  })

  it("空流 / [DONE] / 乱码不误判", () => {
    expect(isCodexNativeStreamShape("")).toBe(false)
    expect(isCodexNativeStreamShape("data: [DONE]\n\n")).toBe(false)
    expect(isCodexNativeStreamShape("not sse at all")).toBe(false)
    expect(extractCodexNativeStreamStats("").matched).toBe(false)
  })

  it("reasoning delta 同样算首内容（空 delta 跳过）", () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"","item_id":"rs_1","output_index":0}',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"think","item_id":"rs_1","output_index":0}',
    ].join("\n")
    const stats = extractCodexNativeStreamStats(sse)
    expect(stats.matched).toBe(true)
    // 空 delta 不计，序号 2（第三个 data 载荷）才是首内容
    expect(stats.firstContentIndex).toBe(2)
  })
})
