/**
 * Processed /v1/responses pipeline (ported from grok-api native responses path).
 * /raw/v1/responses bypasses this module and keeps original body forwarding.
 *
 * Includes chat eager-fallback for foreign opaque / previous_response_id lineage.
 */

import type { AppDatabase } from "../db"
import { getDatabase } from "../db"
import {
  buildCodexToolContextFromRequest,
  remapXaiResponsesJsonForCodex,
  transformXaiResponsesSseForCodex,
  type CodexToolContext,
} from "./codex-chat-compat"
import {
  extractContinuityKeysFromRequest,
  extractPlainMessagesFromInput,
  extractToolTurnReasoningFromResponsePayload,
  getConversationLineage,
  loadConversationMessages,
  loadConversationReasoning,
  rememberConversationTurn,
  rewriteResponsesBodyForContinuity,
  sanitizeResponsesInputItems,
  extractOpaqueItemsFromResponsePayload,
  type ConversationMessage,
} from "./conversation-store"
import {
  bodyHasServerSearchTool,
  injectDefaultServerTools,
  normalizeToolsInBody,
} from "./tool-schema"
import {
  buildChatFallbackFromResponsesWithContext,
  chatJsonToResponsesJson,
  shouldEagerFallbackResponses,
  transformChatSseToResponsesSse,
} from "./responses-fallback"

export type ResponsesProcessMode = "processed" | "raw"
export type ResponsesRouteMode = "responses" | "chat"

export interface PrepareResponsesMeta {
  injectedTools: boolean
  sanitized: boolean
  rewritten: boolean
  fixedReasoning?: number
  convertedCustomCalls?: number
  droppedItems?: number
  historyCount?: number
  reasoningItems: string[]
  route: ResponsesRouteMode
  routeReason?: string
  continuityKeys: string[]
  userMessages: ConversationMessage[]
}

export interface PrepareResponsesResult {
  /** Upstream request body (responses or chat.completions depending on route). */
  body: unknown
  /** Original responses-shaped body after inject/sanitize (useful for logging). */
  responsesBody: unknown
  toolContext: CodexToolContext
  route: ResponsesRouteMode
  routeReason?: string
  meta: PrepareResponsesMeta
  modelHint?: string
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// 白名单模型集合：已验证原生支持 responses 的模型，不应被会话血缘强制转 chat
const NATIVE_RESPONSES_MODELS = new Set(["gpt-5.6-luna", "muse-spark-1.2-contributor", "muse-spark-1.2"])

function ensureResponsesStreamUsage(body: unknown): unknown {
  if (!isObj(body)) return body
  const b = { ...body }
  if (b.stream === true) {
    if (b.include_usage == null) b.include_usage = true
    if (b.stream_options && typeof b.stream_options === "object") {
      const prev = { ...(b.stream_options as Record<string, unknown>) }
      if (prev.include_usage == null) prev.include_usage = true
      b.stream_options = prev
    } else {
      b.stream_options = { include_usage: true }
    }
  }
  return b
}

/**
 * 为白名单模型自动补充 include 参数，合并用户已有 include 并去重。
 * 目的：确保 reasoning.encrypted_content 随 responses 返回，便于客户端按协议回显血缘。
 * 非白名单模型不动；/raw 直通路径不经过此函数。
 */
function ensureResponsesInclude(body: unknown): unknown {
  if (!isObj(body)) return body
  const model = typeof body.model === "string" ? body.model : ""
  if (!NATIVE_RESPONSES_MODELS.has(model)) return body
  const b = { ...body }
  const needed = "reasoning.encrypted_content"
  let arr: string[] = []
  const raw = (b as Record<string, unknown>).include
  if (Array.isArray(raw)) {
    arr = raw.map((v) => String(v).trim()).filter(Boolean)
  } else if (typeof raw === "string" && raw.trim()) {
    arr = [raw.trim()]
  } else if (raw != null) {
    // 未知形态的 include（如对象），保持原样不处理
    return b
  }
  if (!arr.includes(needed)) arr.push(needed)
  // 去重保持顺序
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v)
      deduped.push(v)
    }
  }
  ;(b as Record<string, unknown>).include = deduped
  return b
}

function bodyHasToolType(body: unknown, type: string): boolean {
  if (!isObj(body) || !Array.isArray(body.tools)) return false
  return body.tools.some((tool) => isObj(tool) && String(tool.type || "").toLowerCase() === type)
}

export async function prepareResponsesRequestBody(
  body: unknown,
  opts?: {
    injectServerTools?: boolean
    /** Paid xAI seats may receive default web_search/x_search; free seats never auto-inject. */
    paidAccount?: boolean
    isCompact?: boolean
    db?: AppDatabase
  },
): Promise<PrepareResponsesResult> {
  const db = opts?.db ?? getDatabase()
  const model = isObj(body) && typeof body.model === "string" ? body.model : ""
  const looksXaiModel = /grok/i.test(model)
  // Free Grok accounts cannot execute server tools reliably; only paid seats auto-inject.
  const injectEnabled =
    opts?.injectServerTools === true
      ? true
      : opts?.injectServerTools === false
        ? false
        : Boolean(opts?.paidAccount && looksXaiModel)
  const isCompact = opts?.isCompact === true

  const continuityKeys = extractContinuityKeysFromRequest(body)
  const userMessages = extractPlainMessagesFromInput(isObj(body) ? body.input : undefined)
  const lineage = await getConversationLineage(continuityKeys, db)
  const reasoningItems = await loadConversationReasoning(continuityKeys, db)

  // PHASE 1: decide route on (possibly) tool-injected body, before heavy sanitize.
  let bodyForRoute: unknown = body
  let injectedTools = false
  if (!isCompact && injectEnabled) {
    const before = bodyForRoute
    bodyForRoute = injectDefaultServerTools(bodyForRoute, {
      enabled: true,
      tools: ["web_search", "x_search"],
    })
    const beforeCount = isObj(before) && Array.isArray(before.tools) ? before.tools.length : 0
    const afterCount = isObj(bodyForRoute) && Array.isArray(bodyForRoute.tools) ? bodyForRoute.tools.length : 0
    injectedTools = afterCount > beforeCount
  }

  const preferResponsesForServerTools =
    injectEnabled || bodyHasServerSearchTool(body) || bodyHasServerSearchTool(bodyForRoute)

  let route: ResponsesRouteMode = "responses"
  let routeReason = "responses_native"
  if (isCompact) {
    route = "responses"
    routeReason = "responses_compact"
  } else {
    const eager = shouldEagerFallbackResponses(bodyForRoute, {
      preferredMode: lineage.preferredMode ?? null,
      storeHit: lineage.hit,
      preferResponsesForServerTools,
    })
    // 白名单模型豁免：session_lineage_chat / foreign_opaque:* / foreign_history:* 均保持原生 responses
    // 原因：foreign_opaque/history 的 encrypted reasoning 等 opaque 项本就是上游 responses 产出后由客户端按协议回显的，
    // 原生 responses 转发可保留完整推理上下文；sanitizeResponsesInputItems 对带 encrypted_content 的 reasoning/compaction
    // 项会保留原样或用服务端存储的 opaque 恢复，不会剥离（见 conversation-store.ts sanitizeResponsesInputItems）。
    const isWhitelisted = typeof model === "string" && NATIVE_RESPONSES_MODELS.has(model);
    // 检测请求 input 是否携带 encrypted_content（客户端回显本网关产出的 response id 时的协议内连续性标识）
    const hasEncryptedContentInInput = (() => {
      if (!isObj(bodyForRoute)) return false
      const input = (bodyForRoute as Record<string, unknown>).input
      const items = Array.isArray(input) ? input : input != null ? [input] : []
      for (const it of items) {
        if (!isObj(it)) continue
        const enc = (it as Record<string, unknown>).encrypted_content
        if (typeof enc === "string" && enc.trim().length > 0) return true
        if (enc != null && String(enc).trim().length > 0) return true
      }
      return false
    })()
    // isWhitelistedExemptReason：白名单模型的血缘豁免判定
    // - session_lineage_chat / foreign_opaque:* / foreign_history:* 始终豁免
    // - foreign_previous_response_id 仅当请求携带 encrypted_content 或 lineage.storeHit 为 true 时豁免
    //   中文说明：客户端回显本网关产出的 response id 属于协议内连续性，不应降级为 chat；其余 foreign_previous_response_id 场景（指向非本网关产出且未命中存储）保持转 chat 兜底。
    const isWhitelistedExemptReason = (reason?: string) => {
      if (reason === "session_lineage_chat") return true
      if (typeof reason === "string" && (reason.startsWith("foreign_opaque:") || reason.startsWith("foreign_history:"))) return true
      if (reason === "foreign_previous_response_id" && (hasEncryptedContentInInput || lineage.hit)) return true
      return false
    }
    const shouldFallback = eager.eager && !(isWhitelisted && isWhitelistedExemptReason(eager.reason));
    if (shouldFallback) {
      route = "chat"
      routeReason = eager.reason || "session_lineage_chat"
    } else if (isWhitelisted && isWhitelistedExemptReason(eager.reason)) {
      routeReason = "responses_native"
    } else if (eager.reason) {
      routeReason = eager.reason
    }
  }

  // PHASE 2: process only for chosen path.
  if (route === "chat") {
    const stored = await loadConversationMessages(continuityKeys, db)
    // Use bodyForRoute so any injected server tools survive decision metadata;
    // chat conversion itself still only keeps function tools (xAI chat has no x_search).
    const converted = buildChatFallbackFromResponsesWithContext(bodyForRoute, stored, {
      reasoningItems: reasoningItems.map((reasoning_content) => ({ reasoning_content })),
    })
    const chatBody = prepareChatRequestBody(converted.body)
    return {
      body: chatBody,
      responsesBody: bodyForRoute,
      toolContext: converted.toolContext,
      route: "chat",
      routeReason,
      modelHint: model || undefined,
      meta: {
        injectedTools,
        sanitized: false,
        rewritten: false,
        reasoningItems,
        route: "chat",
        routeReason,
        continuityKeys,
        userMessages,
      },
    }
  }

  // Native responses path.
  let work: unknown = bodyForRoute
  if (isCompact && isObj(work)) {
    const b = { ...work }
    delete b.tools
    delete b.functions
    delete b.tool_choice
    delete b.parallel_tool_calls
    delete b.max_tool_calls
    delete b.previous_response_id
    work = b
  }

  const rewritten = await rewriteResponsesBodyForContinuity(work, db)
  work = rewritten.body
  const sanitized = await sanitizeResponsesInputItems(work, db)
  work = sanitized.body
  work = normalizeToolsInBody(work, { mode: "responses" })
  work = ensureResponsesStreamUsage(work)
  work = ensureResponsesInclude(work)

  const toolContext = buildCodexToolContextFromRequest(body)
  return {
    body: work,
    responsesBody: bodyForRoute,
    toolContext,
    route: "responses",
    routeReason,
    modelHint: model || undefined,
    meta: {
      injectedTools,
      sanitized: sanitized.modified,
      rewritten: rewritten.rewritten,
      fixedReasoning: sanitized.fixedReasoning,
      convertedCustomCalls: sanitized.convertedCustomCalls,
      droppedItems: sanitized.droppedItems,
      historyCount: rewritten.historyCount,
      reasoningItems,
      route: "responses",
      routeReason,
      continuityKeys,
      userMessages,
    },
  }
}

/**
 * OpenAI 客户端（Codex CLI / MiniMax Code 等）常发 `developer` role，但 MiniMax
 * Console Go 等上游只接受 system/user/assistant/tool。`developer` 与 `system`
 * 语义等价（OpenAI 对 reasoning 模型的新叫法），统一归一化为 `system`，兼容面最广。
 */
function normalizeChatMessageRoles(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body
  let changed = false
  const messages = body.messages.map((message) => {
    if (!isObj(message) || message.role !== "developer") return message
    changed = true
    return { ...message, role: "system" }
  })
  return changed ? { ...body, messages } : body
}

export function prepareChatRequestBody(body: unknown): unknown {
  const normalized = normalizeToolsInBody(body, { mode: "chat" })
  if (!isObj(normalized)) return normalized
  const b = normalizeChatMessageRoles(normalized)
  // reasoning 参数去重：同时携带 reasoning.effort 与 reasoning_effort 时仅保留一个
  // （优先 reasoning.effort 的值，统一收敛到 chat 上游通用的 reasoning_effort 字段，
  // 删除 reasoning 对象），避免上游因重复/冲突参数返回 400。
  // 对齐 responses->chat 转换（codex-chat-compat）的取舍：纯结构整理，不新增语义。
  if (isObj(b.reasoning) && typeof b.reasoning.effort === "string") {
    b.reasoning_effort = b.reasoning.effort
    delete b.reasoning
  }
  if (b.stream === true) {
    const prev =
      b.stream_options && typeof b.stream_options === "object"
        ? { ...(b.stream_options as Record<string, unknown>) }
        : {}
    b.stream_options = { ...prev, include_usage: true }
  }
  return b
}

export function remapResponsesSuccessBody(body: unknown, toolContext?: CodexToolContext): unknown {
  return remapXaiResponsesJsonForCodex(body, toolContext)
}

export function remapResponsesSuccessStream(
  stream: ReadableStream<Uint8Array>,
  toolContext?: CodexToolContext,
): ReadableStream<Uint8Array> {
  return transformXaiResponsesSseForCodex(stream, toolContext)
}

export function convertChatJsonToResponses(
  chat: unknown,
  modelHint?: string,
  toolContext?: CodexToolContext,
): unknown {
  return chatJsonToResponsesJson(chat, modelHint, toolContext)
}

export function convertChatStreamToResponses(
  stream: ReadableStream<Uint8Array>,
  modelHint?: string,
  toolContext?: CodexToolContext,
): ReadableStream<Uint8Array> {
  return transformChatSseToResponsesSse(stream, modelHint, toolContext)
}

export async function rememberResponsesTurn(opts: {
  responsePayload?: unknown
  responseId?: string
  continuityKeys?: string[]
  userMessages?: ConversationMessage[]
  preferredMode?: "responses" | "chat"
  db?: AppDatabase
}): Promise<void> {
  const opaqueItems = opts.responsePayload
    ? extractOpaqueItemsFromResponsePayload(opts.responsePayload)
    : []
  const reasoningItems = opts.responsePayload
    ? extractToolTurnReasoningFromResponsePayload(opts.responsePayload, opts.responseId)
    : []
  await rememberConversationTurn({
    responseId: opts.responseId,
    previousKeys: opts.continuityKeys,
    opaqueItems,
    messages: opts.userMessages,
    reasoningItems,
    preferredMode: opts.preferredMode,
    db: opts.db,
  })
}