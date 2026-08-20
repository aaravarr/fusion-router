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

  // muse 家族等已验证原生支持 responses 的模型，不应被会话血缘强制转 chat
  const NATIVE_RESPONSES_MODELS = new Set(["gpt-5.6-luna", "muse-spark-1.2-contributor", "muse-spark-1.2"]);
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
    // 项会保留原样或用服务端存储的 opaque 恢复，不会剥离（见 conversation-store.ts sanitizeResponsesInputItems）；
    // 而 foreign_previous_response_id 指向非本网关产出的 response，未命中存储时仍需 chat 兜底，故不豁免。
    const isWhitelisted = typeof model === "string" && NATIVE_RESPONSES_MODELS.has(model);
    const isWhitelistedExemptReason = (reason?: string) =>
      reason === "session_lineage_chat" ||
      (typeof reason === "string" &&
        (reason.startsWith("foreign_opaque:") || reason.startsWith("foreign_history:")));
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
