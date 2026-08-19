import { TextDecoder, TextEncoder } from "node:util"

/** 补发收尾 chunk 时复用的最近一个有意义的 id/model。 */
interface ChatStreamMeta {
  id: string
  model: string
}

const encoder = new TextEncoder()

function frameChunk(meta: ChatStreamMeta, finishReason: string): Uint8Array {
  const payload = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: meta.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  }
  return encoder.encode("data: " + JSON.stringify(payload) + "\n\n")
}

/**
 * opencode-go chat completions 流式响应的“缺 finish_reason”收尾修复。
 *
 * 实测结论（服务器直连 opencode.ai/zen/go/v1）：上游对部分模型（如
 * muse-spark-1.2）返回的流式响应会在整条流从未携带非 null finish_reason、
 * 甚至没有 [DONE] 的情况下直接以 EOF 结束（流内 choices 还可能为空数组）。
 * OpenAI 兼容的下游 SDK / 流式解析器在流结束时若发现缺少 finish_reason，会抛出
 * “Stream ended without finish_reason”，表现为用户侧的兼容报错。
 *
 * 本节点在流“正常结束”（收到 [DONE]，或以 EOF 结束）且整条流从未出现过非 null
 * 的 finish_reason 时：
 *   1) 补发一条 choices[0].delta 为空、finish_reason="stop" 的 chunk
 *      （复用最近一次携带的 id/model，保证字段一致）；
 *   2) 确保其后跟一条 `data: [DONE]`。
 * 若流内已经出现过 finish_reason（标准 OpenAI 收尾）或已有 [DONE]，则原样透传、
 * 不做任何改动。采用增量解析（按行切分，不全量缓冲），保持透传性能与低首字延迟。
 */
export function fixOpenCodeGoChatStreamEnding(): TransformStream<Uint8Array, Uint8Array> {
  let buffer = ""
  let sawFinishReason = false
  const meta: ChatStreamMeta = { id: "", model: "" }
  const decoder = new TextDecoder()

  // 记录最近一次 data 事件携带的 id/model（忽略空串与不可解析帧）。
  const recordMeta = (data: string): void => {
    try {
      const parsed = JSON.parse(data) as { id?: unknown; model?: unknown }
      if (typeof parsed.id === "string" && parsed.id) meta.id = parsed.id
      if (typeof parsed.model === "string" && parsed.model) meta.model = parsed.model
    } catch { /* 忽略无法解析的 data（如 cost 帧） */ }
  }

  // 识别首个非 null 的 finish_reason（标准收尾标志）。
  const inspectFinishReason = (data: string): void => {
    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ finish_reason?: unknown }> }
      const fr = parsed.choices?.[0]?.finish_reason
      if (fr !== undefined && fr !== null) sawFinishReason = true
    } catch { /* 忽略 */ }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim()
          if (data === "[DONE]") {
            // 明确收尾标记：若此前从未出现 finish_reason，把补发 chunk 插在 [DONE] 前。
            if (!sawFinishReason) controller.enqueue(frameChunk(meta, "stop"))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            sawFinishReason = true // 视为已收尾
            continue
          }
          if (data) {
            recordMeta(data)
            inspectFinishReason(data)
          }
          controller.enqueue(encoder.encode(line + "\n"))
          continue
        }
        // 其它 SSE 行（event:、空行等）原样透传
        controller.enqueue(encoder.encode(line + "\n"))
      }
    },
    flush(controller) {
      // 处理无换行结尾的残留字节
      if (buffer) { controller.enqueue(encoder.encode(buffer)); buffer = "" }
      // EOF 结束且从未见非 null finish_reason → 补发 stop chunk + [DONE]
      if (!sawFinishReason) {
        controller.enqueue(frameChunk(meta, "stop"))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      }
    },
  })
}
