import { describe, expect, it } from "vitest"
import {
  ensureStreamUsage,
  extractBodyError,
  extractUsage,
  extractUsageFromSse,
  isLogOk,
  MAX_CAPTURE_BYTES,
  safeCloneBody,
} from "./capture"

describe("capture.extractUsage", () => {
  it("读取 OpenAI usage 字段", () => {
    expect(extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } })).toEqual({
      promptTokens: 3,
      completionTokens: 7,
      totalTokens: 10,
      cachedTokens: undefined,
      textTokens: undefined,
      imageTokens: undefined,
      audioTokens: undefined,
      reasoningTokens: undefined,
    })
  })

  it("读取 Anthropic input/output_tokens 并推算 total", () => {
    expect(extractUsage({ usage: { input_tokens: 4, output_tokens: 6 } })).toMatchObject({ promptTokens: 4, completionTokens: 6, totalTokens: 10 })
  })

 it("从 completion_tokens_details 读取 reasoning_tokens", () => {
   expect(extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 9 } } })).toMatchObject({ reasoningTokens: 9 })
 })
 
 it("从 prompt_tokens_details 读取 OpenAI Chat Completions 缓存命中", () => {
   expect(extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 80 } } })).toMatchObject({ cachedTokens: 80 })
 })
 
 it("从 input_tokens_details 读取 Responses API 缓存命中", () => {
   expect(extractUsage({ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 80 } } })).toMatchObject({ cachedTokens: 80 })
 })
 
 it("从根对象 cache_read_input_tokens 读取 Anthropic 缓存命中，并归一 Prompt 为总输入（含缓存）", () => {
   // Anthropic 语义：input_tokens 不含缓存读取，总输入 = input_tokens + cache_read_input_tokens
   const usage = extractUsage({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 70 } })
   expect(usage).toMatchObject({ promptTokens: 170, cachedTokens: 70, totalTokens: 220 })
 })

 it("Anthropic 全缓存命中时 input_tokens=0，总输入来自 cache_read", () => {
   expect(extractUsage({ usage: { input_tokens: 0, output_tokens: 8, cache_read_input_tokens: 146 } })).toMatchObject({ promptTokens: 146, totalTokens: 154 })
 })

 it("OpenAI 已含缓存的 prompt_tokens 不做重复累加", () => {
   const usage = extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 80 } } })
   expect(usage).toMatchObject({ promptTokens: 100, totalTokens: 150 })
 })

 it("OpenAI Responses 的 input_tokens 已含缓存，不重复累加", () => {
   const usage = extractUsage({ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 80 } } })
   expect(usage).toMatchObject({ promptTokens: 100, totalTokens: 150, cachedTokens: 80 })
 })

  it("支持 message.usage 嵌套", () => {
    expect(extractUsage({ message: { usage: { prompt_tokens: 5, completion_tokens: 5 } } })).toMatchObject({ promptTokens: 5, completionTokens: 5, totalTokens: 10 })
  })

  it("无 usage 时返回 undefined", () => {
    expect(extractUsage({ foo: "bar" })).toBeUndefined()
    expect(extractUsage(null)).toBeUndefined()
  })
})

describe("capture.extractUsageFromSse", () => {
  it("扫描所有 data 行，最后一个含 usage 的胜出", () => {
    const sse = `data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\ndata: [DONE]\n\n`
    expect(extractUsageFromSse(sse)).toMatchObject({ promptTokens: 5, completionTokens: 5, totalTokens: 10 })
  })

  it("无 usage 返回 undefined", () => {
    expect(extractUsageFromSse("data: {\"choices\":[]}\n\n")).toBeUndefined()
  })
})

describe("capture.extractBodyError", () => {
  it("递归提取 error.message", () => {
    expect(extractBodyError({ error: { message: "boom" } })).toBe("boom")
    expect(extractBodyError({ nested: { error: { message: "deep" } } })).toBe("deep")
  })

  it("截断到 500 字符", () => {
    const long = "x".repeat(600)
    expect(extractBodyError({ error: { message: long } })?.length).toBe(500)
  })
})

describe("capture.isLogOk", () => {
  it("2xx 无 bodyError 为成功", () => {
    expect(isLogOk(200)).toBe(true)
    expect(isLogOk(204)).toBe(true)
  })
  it("带 bodyError 或非 2xx 为失败", () => {
    expect(isLogOk(200, "err")).toBe(false)
    expect(isLogOk(500)).toBe(false)
    expect(isLogOk(429)).toBe(false)
  })
})

describe("capture.safeCloneBody", () => {
  it("小 body 原样返回且不截断", () => {
    const body = { a: 1 }
    const result = safeCloneBody(body, 1024)
    expect(result.truncated).toBe(false)
    expect(result.value).toBe(body)
  })
  it("超限返回截断标记与预览", () => {
    const text = "x".repeat(2000)
    const result = safeCloneBody(text, 100)
    expect(result.truncated).toBe(true)
    expect((result.value as { _truncated: boolean; _originalBytes: number; preview: string })._truncated).toBe(true)
    expect((result.value as { preview: string }).preview.length).toBeLessThanOrEqual(8000)
  })
})

describe("capture.ensureStreamUsage", () => {
  it("stream=true 注入 stream_options.include_usage", () => {
    const result = ensureStreamUsage({ model: "x", stream: true }) as { stream_options: { include_usage: boolean } }
    expect(result.stream_options.include_usage).toBe(true)
  })
  it("stream=false 不注入", () => {
    const result = ensureStreamUsage({ model: "x", stream: false }) as { stream_options?: unknown }
    expect(result.stream_options).toBeUndefined()
  })
  it("保留已有 stream_options 字段", () => {
    const result = ensureStreamUsage({ stream: true, stream_options: { foo: "bar" } }) as { stream_options: { foo: string; include_usage: boolean } }
    expect(result.stream_options.foo).toBe("bar")
    expect(result.stream_options.include_usage).toBe(true)
  })
})

describe("capture.MAX_CAPTURE_BYTES", () => {
  it("默认 1 MiB", () => {
    expect(MAX_CAPTURE_BYTES).toBe(1_048_576)
  })
})


describe("capture.extractUsage responses nested", () => {
  it("读取 response.completed 嵌套 usage", () => {
    expect(extractUsage({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 209,
          output_tokens: 409,
          total_tokens: 618,
          output_tokens_details: { reasoning_tokens: 370 },
          input_tokens_details: { cached_tokens: 128 },
        },
      },
    })).toMatchObject({
      promptTokens: 209,
      completionTokens: 409,
      totalTokens: 618,
      reasoningTokens: 370,
      cachedTokens: 128,
    })
  })
})
