import { describe, expect, it } from "vitest"
import { fixOpenCodeGoChatStreamEnding } from "./opencode-go-chat-stream"

const encoder = new TextEncoder()

/** 把多个 SSE 文本段喂入 ReadableStream 并经修复器透传，返回完整输出文本。 */
async function runToText(inputs: string[]): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) { for (const part of inputs) controller.enqueue(encoder.encode(part)); controller.close() },
  })
  return new Response(source.pipeThrough(fixOpenCodeGoChatStreamEnding())).text()
}

function dataLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
}

// 实测抓到的 muse-spark-1.2 流：以 EOF 结束，无 [DONE]、无 finish_reason、choices 为空。
const MUSE_LIKE_STREAM = [
  'data: {"id":"resp_abc","object":"chat.completion.chunk","created":1787142000,"model":"muse-spark-1.2","choices":[]}\n\n',
  'data: {"id":"resp_abc","object":"chat.completion.chunk","created":1787142000,"model":"muse-spark-1.2","choices":[]}\n\n',
  'data: {"id":"","object":"chat.completion.chunk","created":1787142000,"model":"","choices":[]}\n\n',
  'data: {"id":"resp_abc","object":"chat.completion.chunk","created":1787142005,"model":"muse-spark-1.2","choices":[]}\n\n',
]

describe("fixOpenCodeGoChatStreamEnding", () => {
  it("muse 型流：EOF 结束且全程无 finish_reason 时，补发 finish_reason=stop chunk 与 [DONE]，原 chunk 顺序不变", async () => {
    const out = await runToText(MUSE_LIKE_STREAM)
    const events = dataLines(out)
    expect(events[events.length - 1]).toBe("[DONE]")
    const finishChunk = JSON.parse(events[events.length - 2])
    expect(finishChunk.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" })
    expect(finishChunk.id).toBe("resp_abc") // 复用最近一次有意义的 id
    expect(finishChunk.model).toBe("muse-spark-1.2")
    // 原有 chunk 按序保留
    expect(events[0]).toContain("resp_abc")
    expect(events[1]).toContain("resp_abc")
    expect(events[2]).toContain('"choices":[]')
    expect(events[3]).toContain("resp_abc")
  })

  it("已有 [DONE] 但缺 finish_reason 时，把补发 chunk 插在 [DONE] 之前", async () => {
    const out = await runToText([...MUSE_LIKE_STREAM, "data: [DONE]\n\n"])
    const events = dataLines(out)
    expect(events[events.length - 1]).toBe("[DONE]")
    expect(JSON.parse(events[events.length - 2]).choices[0].finish_reason).toBe("stop")
  })

  it("正常流（已带 finish_reason=stop + [DONE]）原样透传、不新增 chunk", async () => {
    const normal = [
      'data: {"id":"chat_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chat_1","object":"chat.completion.chunk","choices":[],"usage":{"completion_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]
    const out = await runToText(normal)
    const events = dataLines(out)
    expect(events[events.length - 1]).toBe("[DONE]")
    expect(events.length).toBe(4) // 无新增 chunk
    expect(events[1]).toContain('"finish_reason":"stop"')
  })

  it("SSE data 跨多个网络分包（JSON 中间被切断）仍能正确收尾", async () => {
    const full = MUSE_LIKE_STREAM.join("")
    const bytes = encoder.encode(full)
    const sizes = [7, 3, 40, 2, 60, 5, 90, 1, 100, 8, 120, 12, 30, 90, 50, 5]
    const parts: Uint8Array[] = []
    let off = 0
    for (const s of sizes) { if (off >= bytes.length) break; parts.push(bytes.slice(off, off + s)); off += s }
    if (off < bytes.length) parts.push(bytes.slice(off))
    const source = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close() } })
    const text = await new Response(source.pipeThrough(fixOpenCodeGoChatStreamEnding())).text()
    const events = dataLines(text)
    expect(events[events.length - 1]).toBe("[DONE]")
    expect(JSON.parse(events[events.length - 2]).choices[0].finish_reason).toBe("stop")
  })
})
