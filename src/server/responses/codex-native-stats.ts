/**
 * Codex 原生直通流的日志指标提取（共享模块，避免 gateway 与 capture 重复实现）。
 *
 * 背景（2026-09-08 生产实测确认）：openai 池（Codex 上游
 * chatgpt.com/backend-api/codex）原生 responses 直通请求的日志里 usage
 *（prompt/completion/total/cached/reasoning）、firstTokenMs、tps、hasResponse
 * 全空，但客户端拿到了完整流（200 成功）。对照 muse 流式日志指标全齐——
 * 缺口只在 codex 原生直通路径。
 *
 * 根因（gateway.ts:1047 + capture.ts:620-663）：网关按上游 content-type
 * 分流——Codex 上游 SSE 无 content-type 响应头，落不到 1047 行标准 SSE
 * 流分支（readFirstSseEvent + teeAndCapture 逐行解析 usage/firstContent），
 * 而是走到 processResponses 非流式整包分支（1188 行附近）：SSE 文本整包
 * JSON.parse 抛错 → remappedJson 保持 undefined → usage 恒 undefined、
 * responseBody 恒 undefined（has_response=0）；firstTokenMs 更无来源
 *（tps 由 completionTokens + 延迟窗口在展示层派生，同样为空）。
 * 692cbca 只修了转换层（custom-provider-compat.iterSseDataPayloads 逐行解析 +
 * looksLikeResponsesSse 无头嗅探，覆盖 chat 入口的 attemptResponsesToChat
 * 分支），responses 原生直通分支的日志提取 tap 未覆盖。
 *
 * 修复入口：gateway.ts processResponses 原生直通分支（1188 行附近）——
 * 上游 body 先缓冲为文本，命中本模块形状时走 completed 聚合（usage）+
 * remap 后 teeAndCapture（firstToken/responseBody）；未命中走原 JSON 整包
 * 解析（零回归）。
 *
 * 解析规则与转换层同源（custom-provider-compat.iterSseDataPayloads 逐行
 * 解析，不依赖空行；looksLikeResponsesSse 无头嗅探已在 gateway 侧判定，
 * 这里只做形状确认 + 指标提取）：
 * - usage：取 completed 事件 response.usage（input/output/total/cached/
 *   reasoning 全字段）；completed 缺失时回退最后一个带 response.usage 的事件。
 * - firstToken：首个 output_text.delta（含空 delta 跳过）/ reasoning 类 delta /
 *   function_call_arguments.delta / tool_calls 非空帧；空 content 首帧不算。
 * - 序号从 0 起按 data 载荷顺序计数（[DONE] 独立成帧，不计入内容序号；
 *   调用方按首包字节到达时间 + 序号映射到时间戳，gateway 侧只用"是否命中"——
 *   命中即记无头嗅探首包时间）。
 */

import type { TokenUsage } from "../capture"
import { extractUsage } from "../capture"
import { iterSseDataPayloads } from "./custom-provider-compat"

export interface CodexNativeStreamStats {
  /** 是否确认是 Codex 原生 responses SSE 形状（至少一个 response.* data 载荷可解析）。 */
  matched: boolean
  /** completed（或回退事件）response.usage 提取的 token 用量（与 capture.extractUsage 同口径）。 */
  usage?: TokenUsage
  /** 首个内容载荷在 data 载荷序列中的序号（0 起；空 delta/空 content 不计）。 */
  firstContentIndex?: number
  /** data 载荷总数（含 [DONE]，用于调用方诊断）。 */
  payloadCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** payload 是否 response.* 事件对象（Codex 原生形状确认）。 */
function isResponsesEventObject(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const type = typeof payload.type === "string" ? payload.type : ""
  return type.startsWith("response.")
}

/** payload 是否携带实际内容（首 token 判定：空 delta 不算）。 */
function isContentPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const type = typeof payload.type === "string" ? payload.type : ""
  if (type === "response.output_text.delta" || type === "response.reasoning_summary_text.delta") {
    return typeof payload.delta === "string" && payload.delta.length > 0
  }
  if (
    type === "response.function_call_arguments.delta" ||
    type === "response.custom_tool_call_input.delta"
  ) {
    return typeof payload.delta === "string" && payload.delta.length > 0
  }
  // 通用兜底：data 帧自带 content / tool_calls 非空（标准 SSE 经 remap 后的残留形态）。
  if (typeof (payload as Record<string, unknown>).content === "string" && ((payload as Record<string, unknown>).content as string).length > 0) return true
  const toolCalls = (payload as Record<string, unknown>).tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true
  return false
}

/**
 * 上游 SSE 文本是否为 Codex 原生 responses 形状（至少一个可解析的
 * response.* data 载荷）。空流 / [DONE] / 乱码返回 false。
 */
export function isCodexNativeStreamShape(rawText: string): boolean {
  for (const raw of iterSseDataPayloads(rawText)) {
    if (!raw || raw === "[DONE]") continue
    try {
      if (isResponsesEventObject(JSON.parse(raw))) return true
    } catch { /* 非 JSON 载荷，继续 */ }
  }
  return false
}

/**
 * 从上游原始 SSE 文本提取 Codex 原生流的日志指标。
 * - 非 Codex 形状返回 { matched: false }（调用方忽略，不影响标准路径）。
 * - usage 取 completed 事件 response.usage；无 completed 时回退最后一个
 *   带 response.usage 的事件；全程无 usage 则 usage 保持 undefined。
 *   注意 completed 的 usage 藏在 response.usage（responses 嵌套），而 extractUsage
 *   对 response.completed 事件根的解析要求 response 字段为对象——Codex completed
 *   的 response.output=[] 空数组不影响 usage 候选（extractUsage 只读 usage 键）。
 * - firstContentIndex 取首个内容载荷序号；纯 reasoning 空流则保持 undefined。
 */
export function extractCodexNativeStreamStats(rawText: string): CodexNativeStreamStats {
  const payloads = iterSseDataPayloads(rawText)
  let matched = false
  let usage: TokenUsage | undefined
  let fallbackUsage: TokenUsage | undefined
  let firstContentIndex: number | undefined
  let index = 0
  for (const raw of payloads) {
    if (!raw || raw === "[DONE]") {
      index += 1
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      index += 1
      continue
    }
    if (!isResponsesEventObject(parsed)) {
      index += 1
      continue
    }
    matched = true
    if (firstContentIndex === undefined && isContentPayload(parsed)) firstContentIndex = index
    // usage 提取复用 capture.extractUsage（含 input/output/total/cached/reasoning
    // 全字段 + responses 嵌套 response.usage 候选），与标准路径口径一致。
    const parsedUsage = extractUsage(parsed)
    if (parsedUsage) {
      const type = String((parsed as Record<string, unknown>).type ?? "")
      if (type === "response.completed") usage = parsedUsage
      else fallbackUsage = parsedUsage
    }
    index += 1
  }
  return {
    matched,
    usage: usage ?? fallbackUsage,
    firstContentIndex,
    payloadCount: payloads.length,
  }
}
