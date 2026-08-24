export const MAX_CAPTURE_BYTES = 1_048_576;
const MAX_BODY_ERROR_CHARS = 500;
const PREVIEW_CHARS = 8000;

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  textTokens?: number;
  imageTokens?: number;
  audioTokens?: number;
  reasoningTokens?: number;
}

export interface CaptureResult {
  response?: unknown;
  responseTruncated?: boolean;
  responseBytes?: number;
  usage?: TokenUsage;
  firstByteAt?: number;
  error?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageObject(usage: Record<string, unknown>, fallback?: Record<string, unknown>): TokenUsage | undefined {
  const promptTokensRaw = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const completionTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
  const totalTokens = num(usage.total_tokens);
  // 缓存命中 token 在不同上游协议里位置不同：
  //   Anthropic Messages: 根对象 cache_read_input_tokens / cache_creation_input_tokens
  //   OpenAI Chat Completions: 嵌套 prompt_tokens_details.cached_tokens
  //   OpenAI Responses API: 嵌套 input_tokens_details.cached_tokens
  // 只取根对象会漏掉 OpenAI 的两种，导致缓存数恒为 0。
  const cacheRead = num(usage.cache_read_input_tokens);
  // cache_creation_input_tokens 属于 input_tokens 的子集，不参与缓存命中统计（见下方口径注释）。
  const cachedTokens =
    num(usage.cached_tokens)
    ?? cacheRead
    ?? num((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens)
    ?? num((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens)
    // DeepSeek 等上游只返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens 时兜底。
    ?? num(usage.prompt_cache_hit_tokens)
    // 事件根部兜底：opencode 等上游可能把 cached_tokens 放在 usage 对象之外的事件根部。
    ?? (fallback ? num(fallback.cached_tokens) : undefined);
  // 口径统一：Prompt 统一为"总输入（含缓存）"。
  // Anthropic Messages 的 input_tokens 不含缓存读取（cache_read_input_tokens 单独计），
  // OpenAI（chat/responses）的 prompt_tokens / input_tokens 已含缓存。这里把 Anthropic
  // 的缓存读取部分加回，使不同入口记录到库里的 Prompt/Total 口径一致。
  // 注意：cache_creation_input_tokens 属于 input_tokens 的子集，不在此重复累加。
  const anthropicCache = cacheRead ?? 0;
  const promptTokens =
    promptTokensRaw !== undefined && anthropicCache > 0
      ? promptTokensRaw + anthropicCache
      : promptTokensRaw;
  // reasoning 在不同上游协议里的位置不同：
  //   OpenAI Chat Completions: 嵌套 completion_tokens_details.reasoning_tokens
  //   OpenAI Responses API: 嵌套 output_tokens_details.reasoning_tokens
  //   （少数上游直接在根对象给 reasoning_tokens）
  // 另有一些 OpenAI 兼容代理 / Responses 流式早期实现用 reasoning_output_tokens 命名，
  // 以及个别上游把 reasoning_tokens 放在 usage 对象之外的事件根部 —— 一并兜底。
  const reasoningTokens =
    num(usage.reasoning_tokens)
    ?? num((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens)
    ?? num((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens)
    ?? num((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_output_tokens)
    ?? num((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_output_tokens)
    ?? num(usage.reasoning_output_tokens)
    ?? (fallback ? num(fallback.reasoning_tokens) ?? num(fallback.reasoning_output_tokens) : undefined);
  const textTokens =
    num(usage.text_tokens)
    ?? num((usage.completion_tokens_details as Record<string, unknown> | undefined)?.text_tokens)
    ?? num((usage.output_tokens_details as Record<string, unknown> | undefined)?.text_tokens)
    ?? (fallback ? num(fallback.text_tokens) : undefined);
  const imageTokens = num(usage.image_tokens);
  const audioTokens = num(usage.audio_tokens);
  const computed = totalTokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const any = promptTokens ?? completionTokens ?? totalTokens ?? cachedTokens ?? reasoningTokens ?? textTokens ?? imageTokens ?? audioTokens;
  if (any === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens: computed,
    cachedTokens,
    textTokens,
    imageTokens,
    audioTokens,
    reasoningTokens,
  };
}

export function extractUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  // Responses API (esp. SSE events like response.completed) nests usage under response.usage.
  const response = root.response && typeof root.response === "object" ? root.response as Record<string, unknown> : undefined;
  const nestedResponse = response?.response && typeof response.response === "object" ? response.response as Record<string, unknown> : undefined;
  const candidates: unknown[] = [
    root.usage,
    (root.message as Record<string, unknown> | undefined)?.usage,
    response?.usage,
    nestedResponse?.usage,
  ];
  // chat 流里部分上游把 usage 嵌在 choices[0].usage（OpenAI 兼容代理形态），补进候选。
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      const usageRaw = (choice as Record<string, unknown> | undefined)?.usage;
      if (usageRaw && typeof usageRaw === "object") candidates.push(usageRaw);
    }
  }
  // 事件根本身是裸 usage 对象（无 usage 包装键的独立 usage 事件）时，把根当作候选。
  if (isUsageLikeObject(root)) candidates.push(root);
  // 辅助：判断 output 是否全为 reasoning 项（用于计量真实化推断）
  const isAllReasoningOutput = (out: unknown): boolean => {
    if (!Array.isArray(out) || out.length === 0) return false;
    return out.every((item) => {
      if (!item || typeof item !== "object") return false;
      const t = String((item as Record<string, unknown>).type || "").toLowerCase();
      return t.includes("reasoning");
    });
  };
  const outputCandidates: unknown[] = [];
  if (Array.isArray(root.output)) outputCandidates.push(root.output);
  if (response && Array.isArray(response.output)) outputCandidates.push(response.output);
  if (nestedResponse && Array.isArray(nestedResponse.output)) outputCandidates.push(nestedResponse.output);
  // 兼容：SSE 事件 response 嵌套形态
  const sseResponse = root.response && typeof root.response === "object" ? (root.response as Record<string, unknown>).response : undefined;
  if (sseResponse && typeof sseResponse === "object" && Array.isArray((sseResponse as Record<string, unknown>).output)) outputCandidates.push((sseResponse as Record<string, unknown>).output);
  let allReasoningOutput = false;
  for (const out of outputCandidates) {
    if (isAllReasoningOutput(out)) { allReasoningOutput = true; break; }
  }
  for (const usageRaw of candidates) {
    if (usageRaw && typeof usageRaw === "object") {
      // fallback 传事件根部：usage 对象内缺失的 reasoning/cached/text 字段从事件根补。
      const parsed = readUsageObject(usageRaw as Record<string, unknown>, root);
      if (parsed) {
        // 计量真实化：output 全为 reasoning 且 output_tokens>0 但 reasoning_tokens 缺失时，推断 reasoning_tokens = output_tokens
        // 该推断仅用于落库计量真实化，不在 usage 对象里塞非标准字段；如需标注来源应在 gateway 的 transformSummary 打 "usage:reasoning_inferred" 标签
        if (parsed.reasoningTokens === undefined && allReasoningOutput && typeof parsed.completionTokens === "number" && parsed.completionTokens > 0) {
          return { ...parsed, reasoningTokens: parsed.completionTokens };
        }
        return parsed;
      }
    }
  }
  return undefined;
}

// 事件根是否本身就是一个 usage 对象（裸 usage 事件：无 usage 包装键，直接给 token 计数）。
function isUsageLikeObject(v: Record<string, unknown>): boolean {
  const hasIn = typeof v.prompt_tokens === "number" || typeof v.input_tokens === "number";
  const hasOut = typeof v.completion_tokens === "number" || typeof v.output_tokens === "number";
  return hasIn && hasOut;
}

// 流式捕获里出现多个 usage 事件时按“字段级最新值胜出”合并，而不是整体后发覆盖：
// 部分上游会先发一个带 reasoning 的 usage，再发一个只有基础计数的收尾 usage；
// 整体覆盖会把先发事件的 reasoning / cached 冲成 undefined。逐字段取最新定义值即可。
export function mergeUsage(prev: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!prev) return next;
  return {
    promptTokens: next.promptTokens ?? prev.promptTokens,
    completionTokens: next.completionTokens ?? prev.completionTokens,
    totalTokens: next.totalTokens ?? prev.totalTokens,
    cachedTokens: next.cachedTokens ?? prev.cachedTokens,
    textTokens: next.textTokens ?? prev.textTokens,
    imageTokens: next.imageTokens ?? prev.imageTokens,
    audioTokens: next.audioTokens ?? prev.audioTokens,
    reasoningTokens: next.reasoningTokens ?? prev.reasoningTokens,
  };
}

export function extractUsageFromSse(text: string): TokenUsage | undefined {
  let last: TokenUsage | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      const usage = extractUsage(parsed);
      if (usage) last = mergeUsage(last, usage);
    } catch {
      // ignore malformed lines
    }
  }
  return last;
}

const NETWORK_ERROR_DEFAULT_MESSAGE = "upstream native_finish_reason=network_error (empty content)";

function networkErrorDetail(source: Record<string, unknown>): string {
  const err = source.error;
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.slice(0, MAX_BODY_ERROR_CHARS);
  }
  return NETWORK_ERROR_DEFAULT_MESSAGE;
}

/**
 * 检测（已解析的）JSON 响应体 / 单条 SSE data 载荷中的 native_finish_reason=network_error。
 * OpenRouter custom 上游不支持 tools 等情况会返回 HTTP 200 + 单 chunk
 * {"native_finish_reason":"network_error","finish_reason":"stop","content":""}，
 * 属于可重试的上游网络错误，不应按 SUCCESS 透传空内容。
 * 覆盖位置：根对象、choices[]（choice 自身 / delta / message）、嵌套 response 对象。
 * 返回人类可读错误说明；未检测到返回 undefined。
 */
export function extractNetworkError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  if (root.native_finish_reason === "network_error") return networkErrorDetail(root);
  if (Array.isArray(root.choices)) {
    for (const raw of root.choices) {
      if (!raw || typeof raw !== "object") continue;
      const choice = raw as Record<string, unknown>;
      if (choice.native_finish_reason === "network_error") return networkErrorDetail(choice);
      for (const key of ["delta", "message"] as const) {
        const nested = choice[key];
        if (nested && typeof nested === "object" && (nested as Record<string, unknown>).native_finish_reason === "network_error") {
          return networkErrorDetail(nested as Record<string, unknown>);
        }
      }
    }
  }
  // 嵌套 response 形态（responses SSE 事件如 response.incomplete / response.completed）
  const nested = root.response;
  if (nested && typeof nested === "object") return extractNetworkError(nested);
  return undefined;
}

/** 扫描 SSE 文本中的所有 data 行，检测 native_finish_reason=network_error。 */
export function extractSseNetworkError(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (trimmed.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      const found = extractNetworkError(JSON.parse(data));
      if (found) return found;
    } catch {
      // ignore malformed sse data lines
    }
  }
  return undefined;
}

// 从 SSE 文本中提取最终 responses 形态的响应体：
// - 优先取 response.completed 事件中的 response 字段（为 Codex/前端展示所需的完整形态，含 output/reasoning）
// - 兜底取最后一个形如 {object:"response", output:[...]} 的 data 对象
export function extractResponseFromSse(text: string): unknown | undefined {
  let completed: unknown | undefined;
  let lastResponseLike: unknown | undefined;
  let lastChatChunk: Record<string, unknown> | undefined;
  // chat/completions 流：按 choice.index 跨 chunk 聚合 delta.content 与 reasoning
  // （reasoning_content / reasoning / thinking），避免只取最后一帧导致内容丢失。
  const chatAgg = new Map<number, { content: string; contentRaw: unknown; reasoning: string; finish: unknown }>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as Record<string, unknown>;
      // 标准 Responses SSE 完成事件
      if (typeof obj.type === "string" && obj.type === "response.completed" && obj.response && typeof obj.response === "object") {
        completed = obj.response;
        continue;
      }
      // 兼容：部分上游直接以 data: {id, object:"response", output:...} 形式收尾
      if (obj.object === "response" && Array.isArray((obj as Record<string, unknown>).output)) {
        lastResponseLike = obj;
      }
      // 兜底：response 嵌套形态（response.response）
      const nested = (obj as Record<string, unknown>).response;
      if (nested && typeof nested === "object" && (nested as Record<string, unknown>).object === "response") {
        lastResponseLike = nested;
      }
      // chat/completions 流：收集带 choices 的 data 帧并逐 choice 聚合
      if (Array.isArray(obj.choices) && obj.choices.length > 0) {
        lastChatChunk = obj;
        for (const raw of obj.choices as unknown[]) {
          if (!raw || typeof raw !== "object") continue;
          const choice = raw as Record<string, unknown>;
          const idx = typeof choice.index === "number" ? choice.index : 0;
          let agg = chatAgg.get(idx);
          if (!agg) {
            agg = { content: "", contentRaw: undefined, reasoning: "", finish: null };
            chatAgg.set(idx, agg);
          }
          const finish = choice.finish_reason ?? choice.finishReason;
          if (finish != null) agg.finish = finish;
          const src = (choice.delta && typeof choice.delta === "object"
            ? choice.delta
            : choice.message && typeof choice.message === "object"
              ? choice.message
              : null) as Record<string, unknown> | null;
          if (src) {
            if (typeof src.content === "string") agg.content += src.content;
            else if (src.content != null) agg.contentRaw = src.content;
            else if (typeof src.text === "string") agg.content += src.text;
            const reasoning = [src.reasoning_content, src.reasoning, src.thinking].find((value) => typeof value === "string") as string | undefined;
            if (reasoning) agg.reasoning += reasoning;
          } else if (typeof choice.text === "string") {
            agg.content += choice.text;
          } else if (typeof choice.content === "string") {
            agg.content += choice.content;
          }
        }
      }
    } catch {
      // ignore malformed sse data lines
    }
  }
  if (completed !== undefined || lastResponseLike !== undefined) return completed ?? lastResponseLike;
  if (lastChatChunk) {
    const indices = [...chatAgg.keys()].sort((a, b) => a - b);
    const choices = indices.map((idx) => {
      const agg = chatAgg.get(idx)!;
      // content 为空时合并聚合的 reasoning（reasoning_content / reasoning / thinking）
      // 到响应内容存储（展示用）；原 reasoning 同时保留在 message.reasoning_content 上。
      let content: unknown = agg.content;
      if (content === "" && agg.contentRaw !== undefined) content = agg.contentRaw;
      if (content === "" && agg.reasoning) content = agg.reasoning;
      const message: Record<string, unknown> = { role: "assistant", content };
      if (agg.reasoning) message.reasoning_content = agg.reasoning;
      return {
        index: idx,
        message,
        finish_reason: agg.finish,
      };
    });
    return {
      id: lastChatChunk.id,
      object: "chat.completion",
      model: lastChatChunk.model,
      choices,
      usage: lastChatChunk.usage,
    };
  }
  return undefined;
}

export function extractBodyError(payload: unknown): string | undefined {
  const stack: unknown[] = [payload];
  while (stack.length) {
    const value = stack.pop();
    if (!value) continue;
    if (typeof value === "string") {
      if (value.length > 0 && value.length <= MAX_BODY_ERROR_CHARS * 2) return value.slice(0, MAX_BODY_ERROR_CHARS);
      continue;
    }
    if (typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "error" || key === "message" || key === "detail" || key === "reason") {
        if (typeof child === "string") return child.slice(0, MAX_BODY_ERROR_CHARS);
        if (child && typeof child === "object") {
          const inner = (child as Record<string, unknown>).message;
          if (typeof inner === "string") return inner.slice(0, MAX_BODY_ERROR_CHARS);
        }
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return undefined;
}

export function extractSseError(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (trimmed.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as Record<string, unknown>;
      if (!("error" in obj)) continue;
      const err = extractBodyError(parsed);
      if (err) return err;
    } catch {
      // ignore malformed sse data lines
    }
  }
  return undefined;
}

export function isLogOk(status: number, bodyError?: string | null): boolean {
  if (status >= 200 && status < 400) return bodyError ? false : true;
  return false;
}

export function safeCloneBody(body: unknown, maxBytes = MAX_CAPTURE_BYTES): { value: unknown; truncated: boolean } {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= maxBytes) return { value: body, truncated: false };
  return {
    value: { _truncated: true, _originalBytes: text.length, preview: text.slice(0, PREVIEW_CHARS) },
    truncated: true,
  };
}

export function ensureStreamUsage(body: unknown, mode: "chat" | "responses" = "chat"): unknown {
  if (!body || typeof body !== "object") return body;
  const clone = { ...(body as Record<string, unknown>) };
  if (clone.stream !== true) return clone;
  if (mode === "responses") {
    if (clone.include_usage == null) clone.include_usage = true;
    if (clone.stream_options && typeof clone.stream_options === "object") {
      const prev = { ...(clone.stream_options as Record<string, unknown>) };
      if (prev.include_usage == null) prev.include_usage = true;
      clone.stream_options = prev;
    } else {
      clone.stream_options = { include_usage: true };
    }
    return clone;
  }
  const streamOptions = { ...((clone.stream_options as Record<string, unknown> | undefined) ?? {}) };
  streamOptions.include_usage = true;
  clone.stream_options = streamOptions;
  return clone;
}

export function teeAndCapture(
  stream: ReadableStream<Uint8Array>,
  onComplete: (r: CaptureResult) => void,
): ReadableStream<Uint8Array> {
  const [client, side] = stream.tee();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let firstByteAt: number | undefined;
  let truncated = false;
  let usage: TokenUsage | undefined;
  let sseLineBuf = "";
  (async () => {
    const reader = side.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        if (firstByteAt === undefined) firstByteAt = Date.now();
        const chunk = result.value;
        total += chunk.byteLength;
        // Always scan SSE lines for usage even after body capture is truncated.
        sseLineBuf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = sseLineBuf.indexOf("\n")) >= 0) {
          const line = sseLineBuf.slice(0, nl).replace(/\r$/, "");
          sseLineBuf = sseLineBuf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trimStart();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as unknown;
            const nextUsage = extractUsage(parsed);
            if (nextUsage) usage = mergeUsage(usage, nextUsage);
          } catch {
            // ignore malformed sse data lines
          }
        }
        if (!truncated && total <= MAX_CAPTURE_BYTES) {
          chunks.push(chunk);
          if (total > MAX_CAPTURE_BYTES) truncated = true;
        } else if (!truncated) {
          truncated = true;
        }
      }
      // flush decoder remainder
      sseLineBuf += decoder.decode();
      if (sseLineBuf.trim()) {
        for (const raw of sseLineBuf.split(/\r?\n/)) {
          if (!raw.startsWith("data:")) continue;
          const data = raw.slice(5).trimStart();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as unknown;
            const nextUsage = extractUsage(parsed);
            if (nextUsage) usage = mergeUsage(usage, nextUsage);
          } catch { /* ignore */ }
        }
      }
    } catch {
      // ignore capture errors
    } finally {
      try { reader.releaseLock() } catch { /* noop */ }
    }
    const text = new TextDecoder().decode(chunks.length ? concatBytes(chunks) : new Uint8Array(), { stream: false });
    if (!usage) usage = extractUsageFromSse(text);
    // 尝试构造落盘用的响应体：优先直接 JSON，其次从 SSE 事件中提取最终 responses 形态，便于前端展示与 reasoning 校验
    let response: unknown | undefined;
    if (!truncated) {
      if (!usage) {
        try { response = JSON.parse(text); const u = extractUsage(response); if (u) usage = mergeUsage(usage, u) } catch { /* 非 JSON，尝试 SSE 提取 */ }
      } else {
        try { response = JSON.parse(text) } catch { /* 非 JSON，尝试 SSE 提取 */ }
      }
      if (response === undefined) response = extractResponseFromSse(text);
    }
    // native_finish_reason=network_error 的流即使带 usage / 无 error 字段也记真实原因（ok 判定为 0）。
    const error = extractSseNetworkError(text) ?? (usage ? undefined : extractBodyError(response) ?? extractSseError(text));
    onComplete({ response: truncated ? undefined : response, responseTruncated: truncated, responseBytes: total, usage, firstByteAt, error });
  })();
  return client;
}

export function captureJsonResponse(
  stream: ReadableStream<Uint8Array>,
  onComplete: (r: CaptureResult) => void,
): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let firstByteAt: number | undefined;
  let truncated = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          if (firstByteAt === undefined) firstByteAt = Date.now();
          controller.enqueue(result.value);
          if (total < MAX_CAPTURE_BYTES) {
            chunks.push(result.value);
            total += result.value.byteLength;
            if (total > MAX_CAPTURE_BYTES) truncated = true;
          } else {
            truncated = true;
          }
        }
        controller.close();
      } catch (cause) {
        controller.error(cause);
        return;
      } finally {
        try { reader.releaseLock() } catch { /* noop */ }
      }
      const text = new TextDecoder().decode(chunks.length ? concatBytes(chunks) : new Uint8Array());
      let response: unknown;
      try { response = JSON.parse(text) } catch { /* keep text */ }
      const usage = extractUsage(response);
      const error = extractNetworkError(response) ?? extractBodyError(response) ?? (usage ? undefined : extractBodyError(tryParseText(text)));
      onComplete({ response: truncated ? undefined : response, responseTruncated: truncated, responseBytes: total, usage, firstByteAt, error });
    },
    async cancel(reason) {
      try { await stream.cancel(reason) } catch { /* noop */ }
    },
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out;
}

function tryParseText(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text) } catch { return text.length > MAX_BODY_ERROR_CHARS * 2 ? undefined : { error: text } }
}
