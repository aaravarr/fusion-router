/**
 * Lightweight Responses continuity helpers ported from grok-api.
 * Focus: sanitize input items for xAI ModelInput, continuity key extraction,
 * and optional opaque item persistence via SQLite.
 */

import { randomUUID } from "node:crypto"
import type { AppDatabase } from "../db"
import { getDatabase } from "../db"
import { stripServerSearchQueryPrefix } from "./codex-chat-compat"

type Obj = Record<string, unknown>

export interface ConversationMessage {
  role: string
  content: string
  ts?: number
}

export interface ConversationReasoningItem {
  reasoning_content: string
  ts?: number
  responseId?: string
}

export interface ConversationRecord {
  id: string
  continuityKey: string
  opaqueItems: unknown[]
  messages: ConversationMessage[]
  reasoningItems: ConversationReasoningItem[]
  preferredMode: "responses" | "chat" | null
  updatedAt: string
  createdAt: string
}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function asArgsString(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v ?? {})
  } catch {
    return String(v ?? "")
  }
}

/** xAI function tools require arguments to be a JSON object string. */
function asJsonObjectArgsString(v: unknown): string {
  const raw = asArgsString(v)
  const s = String(raw || "").trim()
  if (!s) return "{}"
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(parsed)
    }
    return JSON.stringify({ input: parsed })
  } catch {
    return JSON.stringify({ input: raw })
  }
}

function boundedCloneOpaqueItem(item: unknown): unknown | null {
  if (!isObj(item)) return null
  try {
    return JSON.parse(JSON.stringify(item))
  } catch {
    return null
  }
}

function capOpaqueItems(items: unknown[] | undefined | null, max = 24): unknown[] {
  if (!Array.isArray(items) || items.length === 0) return []
  const out: unknown[] = []
  for (const item of items) {
    const c = boundedCloneOpaqueItem(item)
    if (c != null) out.push(c)
    if (out.length >= max) break
  }
  return out
}

export function isOpaqueInputItem(item: unknown): boolean {
  if (!isObj(item)) return false
  const type = String(item.type || "").toLowerCase()
  const enc = item.encrypted_content
  const hasEnc = typeof enc === "string" ? enc.trim().length > 0 : enc != null
  if (type.includes("compaction") && hasEnc) return true
  if (hasEnc) return true
  if (type.includes("encrypted") && hasEnc) return true
  return false
}

function codexThreadIdFromBody(body: Obj): string | null {
  const meta = isObj(body.client_metadata) ? body.client_metadata : null
  if (meta) {
    if (typeof meta.thread_id === "string" && meta.thread_id.trim()) return meta.thread_id.trim()
    if (typeof meta.session_id === "string" && meta.session_id.trim()) return meta.session_id.trim()
    const turnMeta = meta["x-codex-turn-metadata"]
    if (typeof turnMeta === "string" && turnMeta.trim().startsWith("{")) {
      try {
        const tm = JSON.parse(turnMeta) as Record<string, unknown>
        if (isObj(tm)) {
          if (typeof tm.thread_id === "string" && tm.thread_id.trim()) return tm.thread_id.trim()
          if (typeof tm.session_id === "string" && tm.session_id.trim()) return tm.session_id.trim()
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (isObj(body.metadata)) {
    if (typeof body.metadata.thread_id === "string" && body.metadata.thread_id.trim()) {
      return body.metadata.thread_id.trim()
    }
    if (typeof body.metadata.session_id === "string" && body.metadata.session_id.trim()) {
      return body.metadata.session_id.trim()
    }
  }
  return null
}

function threadConvId(threadId: string): string {
  return `thread:${threadId}`
}

export function extractContinuityKeysFromRequest(body: unknown): string[] {
  if (!isObj(body)) return []
  const out: string[] = []
  const seen = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v !== "string") return
    const k = v.trim()
    if (!k || seen.has(k)) return
    if (k.startsWith("fp_") || k.includes("::fp_")) return
    seen.add(k)
    out.push(k)
  }

  const threadId = codexThreadIdFromBody(body)
  if (threadId) {
    add(threadConvId(threadId))
    add(threadId)
  }

  add(body.previous_response_id)
  add(body.response_id)
  add(body.conversation_id)

  const walk = (node: unknown, depth = 0) => {
    if (depth > 6 || node == null) return
    if (Array.isArray(node)) {
      for (const it of node) walk(it, depth + 1)
      return
    }
    if (!isObj(node)) return
    if (typeof node.id === "string") {
      const id = node.id.trim()
      if (id.startsWith("cmp_") || id.startsWith("resp_") || id.startsWith("rs_")) add(id)
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v, depth + 1)
    }
  }
  walk(body.input)
  return out
}

function requestHasOpaqueItems(body: unknown): boolean {
  if (!isObj(body)) return false
  const input = body.input
  const items = Array.isArray(input) ? input : input != null ? [input] : []
  return items.some((item) => isOpaqueInputItem(item))
}

function loadConversation(db: AppDatabase, keys: string[]): ConversationRecord | null {
  if (!keys.length) return null
  const stmt = db.prepare(
    "SELECT id, continuity_key, opaque_items_json, messages_json, reasoning_items_json, preferred_mode, updated_at, created_at FROM response_conversations WHERE continuity_key = ?",
  )
  for (const key of keys) {
    const row = stmt.get(key) as
      | {
          id: string
          continuity_key: string
          opaque_items_json: string
          messages_json: string | null
          reasoning_items_json: string | null
          preferred_mode: string | null
          updated_at: string
          created_at: string
        }
      | undefined
    if (!row) continue
    let opaqueItems: unknown[] = []
    let messages: ConversationMessage[] = []
    try {
      const parsed = JSON.parse(row.opaque_items_json || "[]")
      if (Array.isArray(parsed)) opaqueItems = parsed
    } catch {
      opaqueItems = []
    }
    try {
      const parsed = JSON.parse(row.messages_json || "[]")
      if (Array.isArray(parsed)) {
        messages = parsed
          .filter((m): m is ConversationMessage => !!m && typeof m === "object" && typeof (m as ConversationMessage).role === "string" && typeof (m as ConversationMessage).content === "string")
          .map((m) => ({ role: m.role, content: m.content, ts: typeof m.ts === "number" ? m.ts : undefined }))
      }
    } catch {
      messages = []
    }
    let reasoningItems: ConversationReasoningItem[] = []
    try {
      const parsed = JSON.parse(row.reasoning_items_json || "[]")
      if (Array.isArray(parsed)) {
        reasoningItems = parsed
          .filter((item): item is ConversationReasoningItem => !!item && typeof item === "object" && typeof (item as ConversationReasoningItem).reasoning_content === "string")
          .map((item) => ({
            reasoning_content: item.reasoning_content,
            ts: typeof item.ts === "number" ? item.ts : undefined,
            responseId: typeof item.responseId === "string" ? item.responseId : undefined,
          }))
      }
    } catch {
      reasoningItems = []
    }
    return {
      id: row.id,
      continuityKey: row.continuity_key,
      opaqueItems,
      messages,
      reasoningItems,
      preferredMode: row.preferred_mode === "chat" || row.preferred_mode === "responses" ? row.preferred_mode : null,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    }
  }
  return null
}

function findStoredOpaqueByEncryptedContent(db: AppDatabase, enc: string): Record<string, unknown> | null {
  if (!enc.trim()) return null
  const rows = db
    .prepare("SELECT opaque_items_json FROM response_conversations ORDER BY updated_at DESC LIMIT 40")
    .all() as { opaque_items_json: string }[]
  for (const row of rows) {
    try {
      const items = JSON.parse(row.opaque_items_json || "[]")
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (!isObj(item)) continue
        if (item.encrypted_content === enc) return item
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

export async function sanitizeResponsesInputItems(
  body: unknown,
  db: AppDatabase = getDatabase(),
): Promise<{
  body: unknown
  modified: boolean
  fixedReasoning: number
  convertedCustomCalls: number
  droppedItems: number
}> {
  if (!isObj(body)) {
    return { body, modified: false, fixedReasoning: 0, convertedCustomCalls: 0, droppedItems: 0 }
  }
  const input = body.input
  if (!Array.isArray(input)) {
    return { body, modified: false, fixedReasoning: 0, convertedCustomCalls: 0, droppedItems: 0 }
  }

  const keys = extractContinuityKeysFromRequest(body)
  const rec = loadConversation(db, keys)
  const storedOpaque = Array.isArray(rec?.opaqueItems) ? rec!.opaqueItems : []
  const byEnc = new Map<string, Record<string, unknown>>()
  for (const it of storedOpaque) {
    if (!isObj(it)) continue
    const enc = it.encrypted_content
    if (typeof enc === "string" && enc.trim()) byEnc.set(enc, it)
  }

  let modified = false
  let fixedReasoning = 0
  let convertedCustomCalls = 0
  let droppedItems = 0
  const nextItems: unknown[] = []

  for (const item of input) {
    if (!isObj(item)) {
      nextItems.push(item)
      continue
    }
    const type = String(item.type || "").toLowerCase()

    if (type === "tool_search_call") {
      const callId = String(item.call_id || item.id || `call_${nextItems.length + 1}`)
      const args = asJsonObjectArgsString(item.arguments ?? item.input ?? {})
      const out: Record<string, unknown> = {
        type: "function_call",
        call_id: callId,
        name: "tool_search",
        arguments: args,
      }
      if (typeof item.status === "string" && item.status.trim()) out.status = item.status
      if (typeof item.id === "string" && item.id.trim()) out.id = item.id
      nextItems.push(out)
      convertedCustomCalls += 1
      modified = true
      continue
    }
    if (type === "tool_search_output") {
      const callId = String(item.call_id || item.id || `call_${nextItems.length + 1}`)
      let output: string
      if (typeof item.output === "string") output = item.output
      else if (item.output != null) output = asArgsString(item.output)
      else {
        const cloneItem: Record<string, unknown> = { ...item }
        delete cloneItem.type
        delete cloneItem.call_id
        delete cloneItem.id
        delete cloneItem.status
        delete cloneItem.execution
        output = asArgsString(Object.keys(cloneItem).length ? cloneItem : "")
      }
      nextItems.push({
        type: "function_call_output",
        call_id: callId,
        output,
      })
      convertedCustomCalls += 1
      modified = true
      continue
    }

    if (type === "custom_tool_call") {
      const callId = String(item.call_id || item.id || `call_${nextItems.length + 1}`)
      const name = String(item.name || "tool")
      const rawInput = item.input ?? item.arguments ?? ""
      let args: string
      if (typeof rawInput === "string") {
        args = JSON.stringify({ input: rawInput })
      } else {
        args = asJsonObjectArgsString(rawInput)
      }
      const out: Record<string, unknown> = {
        type: "function_call",
        call_id: callId,
        name,
        arguments: args,
      }
      if (typeof item.status === "string" && item.status.trim()) out.status = item.status
      if (typeof item.id === "string" && item.id.trim()) out.id = item.id
      nextItems.push(out)
      convertedCustomCalls += 1
      modified = true
      continue
    }
    if (type === "custom_tool_call_output") {
      const callId = String(item.call_id || item.id || `call_${nextItems.length + 1}`)
      const output = typeof item.output === "string" ? item.output : asArgsString(item.output)
      nextItems.push({
        type: "function_call_output",
        call_id: callId,
        output,
      })
      convertedCustomCalls += 1
      modified = true
      continue
    }

    if (type === "web_search_call" || type === "x_search_call") {
      const out: Record<string, unknown> = { ...item }
      const xaiTool = String(out.xai_tool || "").toLowerCase()
      if (type === "web_search_call" && (xaiTool === "x_search" || xaiTool.startsWith("x_"))) {
        out.type = "x_search_call"
        modified = true
      } else {
        out.type = type
      }
      if (typeof out.status !== "string" || !out.status.trim()) {
        out.status = "completed"
        modified = true
      }
      if (isObj(out.action)) {
        const action = { ...(out.action as Record<string, unknown>) }
        const clean =
          typeof out.xai_query === "string" && out.xai_query.trim()
            ? String(out.xai_query).trim()
            : stripServerSearchQueryPrefix(action.query)
        if (typeof action.query === "string" && action.query !== clean) {
          action.query = clean
          modified = true
        }
        out.action = action
      }
      if ("xai_tool" in out) {
        delete out.xai_tool
        modified = true
      }
      if ("xai_query" in out) {
        delete out.xai_query
        modified = true
      }
      nextItems.push(out)
      continue
    }

    if (type === "function_call") {
      const out: Record<string, unknown> = { ...item, type: "function_call" }
      const nextArgs = asJsonObjectArgsString(out.arguments ?? out.input ?? {})
      if (out.arguments !== nextArgs) {
        out.arguments = nextArgs
        modified = true
      }
      if (!out.call_id && typeof out.id === "string") out.call_id = out.id
      if ("content" in out && out.content == null) {
        delete out.content
        modified = true
      }
      nextItems.push(out)
      continue
    }
    if (type === "function_call_output") {
      const out: Record<string, unknown> = { ...item, type: "function_call_output" }
      if (typeof out.output !== "string") {
        out.output = asArgsString(out.output)
        modified = true
      }
      nextItems.push(out)
      continue
    }

    if (type === "reasoning" || type.includes("compaction")) {
      const enc = item.encrypted_content
      const hasEnc = typeof enc === "string" && enc.trim().length > 0

      if (hasEnc) {
        let restored = byEnc.get(enc as string) || null
        if (!restored) restored = findStoredOpaqueByEncryptedContent(db, enc as string)
        if (restored) {
          const c = boundedCloneOpaqueItem(restored)
          if (c != null) nextItems.push(c)
          fixedReasoning += 1
          modified = true
          continue
        }
      } else if (type === "reasoning") {
        droppedItems += 1
        fixedReasoning += 1
        modified = true
        continue
      }

      const out: Record<string, unknown> = { ...item }
      if (type === "reasoning") {
        if ("content" in out && out.content == null) {
          delete out.content
          modified = true
          fixedReasoning += 1
        }
        if (typeof out.encrypted_content === "string" && !String(out.encrypted_content).trim()) {
          delete out.encrypted_content
          modified = true
        }
        out.type = "reasoning"
        if (typeof out.id === "string" && !out.id.trim()) {
          delete out.id
          modified = true
        }
        if (out.status != null && typeof out.status !== "string") {
          delete out.status
          modified = true
        }
        const stillNoEnc = !(typeof out.encrypted_content === "string" && out.encrypted_content.trim())
        if (stillNoEnc) {
          droppedItems += 1
          fixedReasoning += 1
          modified = true
          continue
        }
      }
      if (type.includes("compaction")) {
        if ("content" in out && out.content == null) {
          delete out.content
          modified = true
        }
        if (!hasEnc) {
          droppedItems += 1
          modified = true
          continue
        }
      }
      nextItems.push(out)
      continue
    }

    if (type === "message" || item.role) {
      const out: Record<string, unknown> = { ...item }
      if ("content" in out && out.content == null) {
        delete out.content
        modified = true
      }
      if (Array.isArray(out.content)) {
        // 兼容归一化：会话历史回放的 part 可能是 chat 变体（text/image_url），
        // 上游 Responses API 只接受 input_text / input_image / output_text 等。
        const normalized = out.content.map((part) => {
          if (!part || typeof part !== "object") return part
          const p = part as Record<string, unknown>
          const pt = String(p.type ?? "")
          if (pt === "text" && typeof p.text === "string") {
            modified = true
            return { ...p, type: "input_text" }
          }
          if (pt === "image_url") {
            modified = true
            return { ...p, type: "input_image" }
          }
          return p
        })
        out.content = normalized
      }
      nextItems.push(out)
      continue
    }

    nextItems.push(item)
  }

  if (!modified) {
    return { body, modified: false, fixedReasoning: 0, convertedCustomCalls: 0, droppedItems: 0 }
  }
  return {
    body: { ...body, input: nextItems },
    modified: true,
    fixedReasoning,
    convertedCustomCalls,
    droppedItems,
  }
}

export async function applyStoredOpaqueContinuity(
  body: unknown,
  db: AppDatabase = getDatabase(),
): Promise<{
  body: unknown
  rewritten: boolean
  injectedOpaque: number
  usedConversationId?: string
}> {
  if (!isObj(body)) return { body, rewritten: false, injectedOpaque: 0 }
  if (requestHasOpaqueItems(body)) return { body, rewritten: false, injectedOpaque: 0 }

  const keys = extractContinuityKeysFromRequest(body)
  if (!keys.length) return { body, rewritten: false, injectedOpaque: 0 }

  const rec = loadConversation(db, keys)
  const opaque = Array.isArray(rec?.opaqueItems) ? rec!.opaqueItems : []
  if (!opaque.length) {
    return { body, rewritten: false, injectedOpaque: 0, usedConversationId: rec?.id }
  }

  const input = body.input
  const clientItems = Array.isArray(input) ? input : input != null ? [input] : []
  const kept = clientItems.filter((it) => !isOpaqueInputItem(it))
  const injected = capOpaqueItems(opaque)
  return {
    body: { ...body, input: [...injected, ...kept] },
    rewritten: true,
    injectedOpaque: injected.length,
    usedConversationId: rec?.id,
  }
}

export async function rewriteResponsesBodyForContinuity(
  body: unknown,
  db: AppDatabase = getDatabase(),
): Promise<{
  body: unknown
  rewritten: boolean
  historyCount: number
  strippedOpaque: number
}> {
  const r = await applyStoredOpaqueContinuity(body, db)
  return {
    body: r.body,
    rewritten: r.rewritten,
    historyCount: r.injectedOpaque,
    strippedOpaque: 0,
  }
}

export function extractOpaqueItemsFromResponsePayload(payload: unknown): unknown[] {
  if (!isObj(payload)) return []
  const out: unknown[] = []
  const walk = (node: unknown) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const it of node) walk(it)
      return
    }
    if (!isObj(node)) return
    if (isOpaqueInputItem(node)) {
      const c = boundedCloneOpaqueItem(node)
      if (c != null) out.push(c)
    }
    if (Array.isArray(node.output)) walk(node.output)
    if (isObj(node.response)) walk(node.response)
  }
  walk(payload)
  return capOpaqueItems(out)
}

export function extractToolTurnReasoningFromResponsePayload(
  payload: unknown,
  responseId?: string,
): ConversationReasoningItem[] {
  if (!isObj(payload)) return []
  const now = Date.now()
  const out: ConversationReasoningItem[] = []

  const isToolCallItem = (node: unknown): boolean => {
    if (!isObj(node)) return false
    const type = String(node.type || "").toLowerCase()
    return (
      type === "function_call" ||
      type === "custom_tool_call" ||
      type === "tool_search_call" ||
      type.includes("tool_call")
    )
  }

  const reasoningText = (node: unknown): string => {
    if (!isObj(node)) return ""
    let text = ""
    if (Array.isArray(node.summary)) {
      for (const part of node.summary) {
        if (typeof part === "string") text += part
        else if (isObj(part) && typeof part.text === "string") text += part.text
      }
    }
    if (Array.isArray(node.content)) {
      for (const part of node.content) {
        if (typeof part === "string") text += part
        else if (isObj(part) && typeof part.text === "string") text += part.text
      }
    }
    if (typeof node.text === "string") text += node.text
    return text
  }

  const walkOutput = (node: unknown): void => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const it of node) walkOutput(it)
      return
    }
    if (!isObj(node)) return
    if (Array.isArray(node.output)) {
      const output = node.output
      let hasToolCall = false
      const found: ConversationReasoningItem[] = []
      for (const item of output) {
        if (!isObj(item)) continue
        const type = String(item.type || "").toLowerCase()
        if (isToolCallItem(item)) hasToolCall = true
        if (type.includes("reasoning")) {
          const text = reasoningText(item).trim()
          if (text) found.push({ reasoning_content: text, ts: now, responseId })
        }
      }
      if (hasToolCall && found.length) out.push(...found)
      walkOutput(output)
    }
    if (isObj(node.response)) walkOutput(node.response)
  }

  walkOutput(payload)
  return out
}

export function extractPlainMessagesFromInput(input: unknown): ConversationMessage[] {
  const items = Array.isArray(input) ? input : input != null ? [input] : []
  const out: ConversationMessage[] = []
  const now = Date.now()
  for (const item of items) {
    if (!isObj(item)) continue
    const type = String(item.type || "").toLowerCase()
    const role = typeof item.role === "string" ? item.role : type === "message" ? "user" : ""
    if (!role) continue
    if (type && type !== "message" && !item.role) continue
    let content = ""
    if (typeof item.content === "string") content = item.content
    else if (Array.isArray(item.content)) {
      content = item.content
        .map((part) => {
          if (typeof part === "string") return part
          if (!isObj(part)) return ""
          if (typeof part.text === "string") return part.text
          if (typeof part.input_text === "string") return part.input_text
          return ""
        })
        .filter(Boolean)
        .join("\n")
    } else if (typeof item.text === "string") content = item.text
    if (!content.trim()) continue
    out.push({ role, content: content.trim(), ts: now })
  }
  return out
}

export async function loadConversationMessages(
  keys: string[],
  db: AppDatabase = getDatabase(),
): Promise<ConversationMessage[]> {
  const rec = loadConversation(db, keys)
  return rec?.messages ? rec.messages.slice() : []
}

export async function loadConversationReasoning(
  keys: string[],
  db: AppDatabase = getDatabase(),
): Promise<string[]> {
  const rec = loadConversation(db, keys)
  if (!rec) return []
  return (rec.reasoningItems ?? [])
    .map((item) => item.reasoning_content)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
}

export async function getConversationLineage(
  keys: string[],
  db: AppDatabase = getDatabase(),
): Promise<{
  hit: boolean
  conversationId?: string
  preferredMode?: "responses" | "chat" | null
  messageCount: number
}> {
  const rec = loadConversation(db, keys)
  if (!rec) return { hit: false, messageCount: 0 }
  return {
    hit: true,
    conversationId: rec.id,
    preferredMode: rec.preferredMode ?? null,
    messageCount: Array.isArray(rec.messages) ? rec.messages.length : 0,
  }
}

export async function rememberConversationTurn(opts: {
  responseId?: string
  previousKeys?: string[]
  opaqueItems?: unknown[]
  messages?: ConversationMessage[]
  reasoningItems?: ConversationReasoningItem[]
  preferredMode?: "responses" | "chat"
  db?: AppDatabase
}): Promise<void> {
  const db = opts.db ?? getDatabase()
  const keys = [...(opts.previousKeys ?? [])]
  if (opts.responseId) keys.unshift(opts.responseId)
  const unique = [...new Set(keys.map((k) => String(k || "").trim()).filter(Boolean))]
  if (!unique.length) return

  const existing = loadConversation(db, unique)
  const opaque = capOpaqueItems(opts.opaqueItems?.length ? opts.opaqueItems : existing?.opaqueItems)
  const prevMessages = existing?.messages ?? []
  const nextMessages = Array.isArray(opts.messages) && opts.messages.length
    ? [...prevMessages, ...opts.messages].slice(-40)
    : prevMessages
  const mergedReasoning: ConversationReasoningItem[] = [
    ...(existing?.reasoningItems ?? []),
    ...(Array.isArray(opts.reasoningItems) ? opts.reasoningItems : []),
  ]
  const seenResponseIds = new Set<string>()
  const nextReasoning: ConversationReasoningItem[] = []
  for (const item of mergedReasoning) {
    if (!item || typeof item.reasoning_content !== "string" || !item.reasoning_content.trim()) continue
    const rid = item.responseId || ""
    if (rid && seenResponseIds.has(rid)) continue
    if (rid) seenResponseIds.add(rid)
    nextReasoning.push({
      reasoning_content: item.reasoning_content,
      ts: typeof item.ts === "number" ? item.ts : undefined,
      responseId: item.responseId,
    })
  }
  const cappedReasoning = nextReasoning.slice(-40)

  let preferredMode: "responses" | "chat" | null = existing?.preferredMode ?? null
  if (opts.preferredMode === "chat" || preferredMode === "chat") preferredMode = "chat"
  else if (opts.preferredMode === "responses") preferredMode = "responses"
  else if (!preferredMode) preferredMode = "responses"

  const now = new Date().toISOString()
  const continuityKey = unique[0]
  const id = existing && existing.continuityKey === continuityKey ? existing.id : randomUUID()
  const opaqueJson = JSON.stringify(opaque)
  const messagesJson = JSON.stringify(nextMessages)
  const reasoningJson = JSON.stringify(cappedReasoning)

  db.prepare(
    `INSERT INTO response_conversations(id, continuity_key, opaque_items_json, messages_json, reasoning_items_json, preferred_mode, updated_at, created_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(continuity_key) DO UPDATE SET
       opaque_items_json=excluded.opaque_items_json,
       messages_json=excluded.messages_json,
       reasoning_items_json=excluded.reasoning_items_json,
       preferred_mode=excluded.preferred_mode,
       updated_at=excluded.updated_at`,
  ).run(id, continuityKey, opaqueJson, messagesJson, reasoningJson, preferredMode, now, existing?.createdAt ?? now)

  for (const key of unique.slice(1, 6)) {
    db.prepare(
      `INSERT INTO response_conversations(id, continuity_key, opaque_items_json, messages_json, reasoning_items_json, preferred_mode, updated_at, created_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(continuity_key) DO UPDATE SET
         opaque_items_json=excluded.opaque_items_json,
         messages_json=excluded.messages_json,
         reasoning_items_json=excluded.reasoning_items_json,
         preferred_mode=excluded.preferred_mode,
         updated_at=excluded.updated_at`,
    ).run(randomUUID(), key, opaqueJson, messagesJson, reasoningJson, preferredMode, now, now)
  }
}