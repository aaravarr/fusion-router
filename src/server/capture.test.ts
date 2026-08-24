import { describe, expect, it } from "vitest"
import {
  ensureStreamUsage,
  extractBodyError,
  extractResponseFromSse,
  extractSseError,
  extractUsage,
  extractUsageFromSse,
  isLogOk,
  MAX_CAPTURE_BYTES,
  safeCloneBody,
  teeAndCapture,
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
describe("capture Responses usage: reasoning & cached (实测样本)", () => {
  // 上游 opencode-go /v1/responses response.completed 事件的 usage 结构为 Responses 协议：
  //   usage.output_tokens_details.reasoning_tokens / usage.input_tokens_details.cached_tokens
  // 与 chat 链路的 usage.completion_tokens_details.reasoning_tokens / prompt_tokens_details.cached_tokens 不同。
  const compact = () => ({
    input_tokens: 9,
    output_tokens: 194,
    total_tokens: 203,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 173 },
  })

  it("流式 response.completed 事件形态 -> reasoning_tokens 与 cached_tokens 均被解析", () => {
    const sse =
      'data: {"type":"response.completed","response":{"usage":' +
      JSON.stringify(compact()) +
      '}}\n\ndata: [DONE]\n\n'
    expect(extractUsageFromSse(sse)).toMatchObject({
      promptTokens: 9,
      completionTokens: 194,
      totalTokens: 203,
      reasoningTokens: 173,
      cachedTokens: 0,
    })
  })

  it("流式 response.completed 事件顶层 usage 形态", () => {
    expect(extractUsage({ type: "response.completed", usage: compact() })).toMatchObject({
      promptTokens: 9,
      completionTokens: 194,
      reasoningTokens: 173,
      cachedTokens: 0,
    })
  })

  it("非流式 JSON 形态（usage 在根对象）", () => {
    expect(extractUsage({ id: "resp_x", object: "response", status: "completed", usage: compact() })).toMatchObject({
      promptTokens: 9,
      completionTokens: 194,
      totalTokens: 203,
      reasoningTokens: 173,
      cachedTokens: 0,
    })
  })

  it("缺省 output_tokens_details 时不崩，reasoning_tokens 保持 undefined", () => {
    const out = extractUsage({
      usage: {
        input_tokens: 9,
        output_tokens: 194,
        total_tokens: 203,
        input_tokens_details: { cached_tokens: 0 },
      },
    })
    expect(out).toMatchObject({ promptTokens: 9, completionTokens: 194, cachedTokens: 0 })
    expect(out?.reasoningTokens).toBeUndefined()
  })
})

describe("capture muse chat-fallback usage 形态（生产断点回归）", () => {
  // 生产实测：muse 走 responses->chat 兜底路径时，原始 chat 流 usage 里 cached 能提取
  // 而 reasoning 恒为空。断点定位为 usage 事件形态不在提取候选内。以下用例覆盖所有
  // 可疑形态：事件根部 reasoning、reasoning_output_tokens 别名、choices[].usage 内嵌、
  // 裸 usage 事件根、后发不完整 usage 覆盖。修复后这些形态都应能提取 reasoning。

  it("reasoning_tokens 在事件根部（usage 对象之外）也能提取（生产 muse 收尾 chunk 形态）", () => {
    // 上游收尾 chunk：usage 内只有基础计数 + 缓存，reasoning_tokens 放在事件根。
    // 数字取自生产看板 07:13:58 行（prompt 93006 / completion 4704 / total 97710 / cached 90225）。
    expect(extractUsage({
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model: "muse-spark-1.2-contributor",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 93006, completion_tokens: 4704, total_tokens: 97710, prompt_tokens_details: { cached_tokens: 90225 } },
      reasoning_tokens: 173,
    })).toMatchObject({ promptTokens: 93006, completionTokens: 4704, totalTokens: 97710, cachedTokens: 90225, reasoningTokens: 173 })
  })

  it("SSE 流式：事件根 reasoning_tokens 形态经 extractUsageFromSse 提取", () => {
    const sse =
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2-contributor","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":93006,"completion_tokens":4704,"total_tokens":97710,"prompt_tokens_details":{"cached_tokens":90225}},"reasoning_tokens":173}\n\n' +
      "data: [DONE]\n\n"
    expect(extractUsageFromSse(sse)).toMatchObject({
      promptTokens: 93006,
      completionTokens: 4704,
      totalTokens: 97710,
      cachedTokens: 90225,
      reasoningTokens: 173,
    })
  })

  it("completion_tokens_details.reasoning_output_tokens 别名也能提取", () => {
    expect(extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_output_tokens: 9 } } })).toMatchObject({ reasoningTokens: 9 })
  })

  it("output_tokens_details.reasoning_output_tokens 别名也能提取", () => {
    expect(extractUsage({ usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_output_tokens: 9 } } })).toMatchObject({ reasoningTokens: 9 })
  })

  it("usage 嵌在 choices[0].usage 也能提取", () => {
    expect(extractUsage({ choices: [{ index: 0, delta: {}, usage: { prompt_tokens: 3, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } }] })).toMatchObject({ promptTokens: 3, completionTokens: 4, reasoningTokens: 2 })
  })

  it("事件根本身是裸 usage 对象也能提取", () => {
    expect(extractUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } })).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4, reasoningTokens: 3 })
  })

  it("SSE 后发的不完整 usage 不冲掉先发事件的 reasoning（字段级合并）", () => {
    const sse = [
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":30}}}',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
    expect(extractUsageFromSse(sse)).toMatchObject({ promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 80, reasoningTokens: 30 })
  })

  it("mergeUsage：后发 usage 完全定义时以新值胜出", () => {
    const sse = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\ndata: [DONE]\n\n'
    expect(extractUsageFromSse(sse)).toMatchObject({ promptTokens: 5, completionTokens: 5, totalTokens: 10 })
  })
})


describe("capture 流式成功请求误判修复（SSE 心跳/缺 usage/hasResponse）", () => {
  it("含 ': OPENROUTER PROCESSING' 心跳 + data chunks + usage 帧：usage 正确提取且 error 为 undefined，isLogOk 为 true", async () => {
    const sse = [
      ": OPENROUTER PROCESSING",
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"hello"}}]}',
      "",
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    // extractUsageFromSse 路径
    const usage = extractUsageFromSse(sse);
    expect(usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    const err = extractSseError(sse);
    expect(err).toBeUndefined();
    expect(isLogOk(200, err ?? null)).toBe(true);
    expect(isLogOk(200, err)).toBe(true);
    // teeAndCapture 路径
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
    const result = await new Promise<import("./capture").CaptureResult>((resolve) => {
      const out = teeAndCapture(stream, resolve);
      // 消费客户端流以驱动 tee 完成
      void (async () => { const r = out.getReader(); while (!(await r.read()).done) {} })();
    });
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.error == null).toBe(true);
    expect(isLogOk(200, result.error ?? null)).toBe(true);
    // 心跳不应导致 response 误判为错误，且 chat response 应可捕获
    const resp = extractResponseFromSse(sse) as Record<string, unknown>;
    expect(resp).toBeDefined();
  });

  it("无 usage 帧的流：error 为 undefined，isLogOk 仍为 true（不因缺 usage 翻转）", async () => {
    const sse = [
      ": OPENROUTER PROCESSING",
      'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"hi"}}]}',
      "",
      'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const usage = extractUsageFromSse(sse);
    expect(usage).toBeUndefined();
    const err = extractSseError(sse);
    expect(err == null).toBe(true);
    expect(isLogOk(200, err ?? null)).toBe(true);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
    const result = await new Promise<import("./capture").CaptureResult>((resolve) => {
      const out = teeAndCapture(stream, resolve);
      void (async () => { const r = out.getReader(); while (!(await r.read()).done) {} })();
    });
    expect(result.usage).toBeUndefined();
    expect(result.error == null).toBe(true);
    expect(isLogOk(200, result.error ?? null)).toBe(true);
    // 仍应能捕获 chat response，使 has_response=true
    const resp = extractResponseFromSse(sse) as Record<string, unknown>;
    expect(resp).toBeDefined();
    expect((resp as { object: string }).object).toBe("chat.completion");
  });

  it("含真 error 对象的流：error 正确提取且 isLogOk 为 false", async () => {
    const sse = [
      'data: {"id":"chatcmpl-3","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"hi"}}]}',
      "",
      'data: {"error":{"message":"boom","type":"server_error"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const err = extractSseError(sse);
    expect(err).toBe("boom");
    expect(isLogOk(200, err)).toBe(false);
    expect(isLogOk(200, err ?? null)).toBe(false);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
    const result = await new Promise<import("./capture").CaptureResult>((resolve) => {
      const out = teeAndCapture(stream, resolve);
      void (async () => { const r = out.getReader(); while (!(await r.read()).done) {} })();
    });
    expect(result.error).toBe("boom");
    expect(isLogOk(200, result.error ?? null)).toBe(false);
    // 错误帧不应被心跳注释干扰
    const sseWithComment = ": OPENROUTER PROCESSING\n" + sse;
    expect(extractSseError(sseWithComment)).toBe("boom");
  });

  it("chat 流 response 捕获：构造带 choices 的 SSE 返回带 choices 的对象", () => {
    const sse = [
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":123,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":123,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":10,"total_tokens":15}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = extractResponseFromSse(sse) as Record<string, unknown>;
    expect(resp).toBeDefined();
    expect((resp as { object: string }).object).toBe("chat.completion");
    expect((resp as { id: string }).id).toBe("chatcmpl-123");
    expect((resp as { model: string }).model).toBe("gpt-4");
    const choices = (resp as { choices: { message: { content: unknown }; finish_reason: unknown }[] }).choices;
    expect(Array.isArray(choices)).toBe(true);
    expect(choices.length).toBeGreaterThan(0);
    expect(choices[0].message).toBeDefined();
    expect(choices[0].finish_reason).toBe("stop");
    // usage 应透传
    expect((resp as { usage: unknown }).usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 10 });
  });

  it("注释行 ': ' 与 ':' 在错误判定中跳过，不触发误判", () => {
    const sse = [
      ": OPENROUTER PROCESSING",
      ": keep-alive",
      'data: {"id":"chatcmpl-4","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"ok"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    // 仅有注释行和正常 data，不应产生 error
    expect(extractSseError(sse)).toBeUndefined();
    expect(isLogOk(200, extractSseError(sse) ?? null)).toBe(true);
    // 注释行本身即使包含 error 字样也不应被解析
    const sse2 = ": error: fake\n" + sse;
    expect(extractSseError(sse2)).toBeUndefined();
  });
});