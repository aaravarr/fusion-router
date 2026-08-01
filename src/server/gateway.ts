import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { authenticateApiKey } from "./repository"
import { AccountRepository } from "./repository"
import { NoEligibleAccountError, RoutingService } from "./routing"
import { getLogSettings, getSystemSettings, type LogSettings } from "./settings"
import type { PoolType, QuotaKind } from "./types"
import { collectRequestHeaders } from "./client-meta"
import { captureJsonResponse, ensureStreamUsage, extractBodyError, extractUsage, isLogOk, safeCloneBody, teeAndCapture, type CaptureResult, type TokenUsage } from "./capture"
import { convertChatJsonToResponses, convertChatStreamToResponses, prepareChatRequestBody, prepareResponsesRequestBody, remapResponsesSuccessBody, remapResponsesSuccessStream, rememberResponsesTurn, type PrepareResponsesResult } from "./responses/pipeline"
import type { CodexToolContext } from "./responses/codex-chat-compat"
import { tryGetProvider, getProviderRegistry, type UpstreamErrorClassification } from "./providers"
import { isXaiPaidAccount } from "./providers/xai-grok"
import { injectDefaultServerTools, normalizeToolsInBody } from "./responses/tool-schema"
import { resolveMirrorUrlForContext } from "./api-fetch"
import { upsertLocalRollingUsage } from "./quota-usage"
import { buildChatFallbackFromResponsesWithContext } from "./responses/responses-fallback"
import { chatRequestToResponses, responsesJsonToChatCompletion, responsesSseToChatStream } from "./responses/custom-provider-compat"
import { normalizeOpenCodeGoResponsesSse } from "./responses/opencode-go-compat"

export interface AccessCredential { accountId: string; goApiKey: string; credentialVersion: number }
export interface CredentialProvider { get(ownerUserId: string, accountId: string): Promise<AccessCredential> }
export interface GatewayRequestOptions {
  raw?: boolean
  principal?: { ownerUserId: string; label?: string }
  routing?: { poolType?: PoolType | null; accountId?: string | null }
}

type GoLimit = { kind: QuotaKind; retryAfterSeconds: number | null }
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
const MAX_ERROR_CHARS = 2_000

interface RequestFinalizeInput {
  status: number
  outcome: string
  attempts: number
  ok?: number
  latencyMs?: number
  localPrepMs?: number
  firstTokenMs?: number
  error?: string | null
  accountId?: string | null
  accountName?: string | null
  responseSizeBytes?: number | null
  usage?: TokenUsage
  logSettings?: LogSettings
  requestBodyJson?: unknown
  responseBody?: unknown
  responseTruncated?: boolean
  meta?: { headers: Record<string, string> }
  inboundEndpoint?: string | null
  upstreamEndpoint?: string | null
  processMode?: string | null
  routeMode?: string | null
  routeReason?: string | null
  converted?: number
  transformSummary?: string | null
}

async function readRequestBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.method === "GET") return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const chunk = new Uint8Array(result.value)
      total += chunk.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        try { await reader.cancel("request body too large") } catch { /* 413 still wins. */ }
        return null
      }
      chunks.push(chunk)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

function errorType(body: string): string | null {
  try { const parsed = JSON.parse(body) as { error?: { type?: unknown } }; return typeof parsed.error?.type === "string" ? parsed.error.type : null } catch { return null }
}

function safeParse(body: string): unknown {
  if (!body) return undefined
  try { return JSON.parse(body) } catch { return undefined }
}

function truncateError(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MAX_ERROR_CHARS ? value.slice(0, MAX_ERROR_CHARS) : value
}

/**
 * Serialize transport/runtime failures for request logs. undici often puts the
 * useful detail on `error.cause` / AggregateError.errors while leaving
 * `message` as "fetch failed" or even empty.
 */
export function formatErrorDetail(cause: unknown, depth = 0): string {
  if (cause == null) return depth === 0 ? "Upstream request failed" : String(cause)
  if (typeof cause === "string") return cause.trim() || (depth === 0 ? "Upstream request failed" : "<empty>")
  if (typeof cause !== "object") return String(cause)

  const err = cause as Error & {
    code?: unknown
    errno?: unknown
    syscall?: unknown
    address?: unknown
    port?: unknown
    cause?: unknown
    errors?: unknown
  }
  const parts: string[] = []
  const name = typeof err.name === "string" && err.name && err.name !== "Error" ? err.name : null
  const message = typeof err.message === "string" ? err.message.trim() : ""
  if (name && message) parts.push(`${name}: ${message}`)
  else if (message) parts.push(message)
  else if (name) parts.push(name)
  else if (depth === 0) parts.push("Upstream request failed")

  const extras: string[] = []
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = err[key]
    if (value != null && String(value) !== "") extras.push(`${key}=${String(value)}`)
  }
  if (extras.length) parts.push(extras.join(" "))

  if (Array.isArray(err.errors) && err.errors.length && depth < 3) {
    parts.push(`errors=[${err.errors.map((item) => formatErrorDetail(item, depth + 1)).join("; ")}]`)
  }
  if (err.cause !== undefined && depth < 4) {
    parts.push(`cause: ${formatErrorDetail(err.cause, depth + 1)}`)
  }

  return parts.join(" | ") || "Upstream request failed"
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

export function classifyGoUsageLimit(response: Response, body: string): GoLimit | null {
  if (response.status !== 429) return null
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown }; metadata?: { limitName?: unknown } }
    if (parsed.error?.type !== "GoUsageLimitError") return null
    const name = parsed.metadata?.limitName
    const kind = name === "5 hour" ? "FIVE_HOUR" : name === "weekly" ? "WEEKLY" : name === "monthly" ? "MONTHLY" : "UNKNOWN_GO_LIMIT"
    return { kind, retryAfterSeconds: parseRetryAfter(response) }
  } catch { return null }
}

// Adapt GoLimit (legacy) to UpstreamErrorClassification (provider interface).
function goLimitToErrorClass(limit: GoLimit | null): UpstreamErrorClassification | null {
  if (!limit) return null
  return { shouldSwitchAccount: true, quotaKind: limit.kind, retryAfterSeconds: limit.retryAfterSeconds, errorType: "GoUsageLimitError" }
}

function classifyFirstSseEvent(headers: Headers, chunk: string): GoLimit | null {
  const data = firstSseData(chunk)
  return !data ? null : classifyGoUsageLimit(new Response(null, { status: 429, headers }), data)
}

function firstSseData(chunk: string): string | null {
  const lf = chunk.indexOf("\n\n")
  const crlf = chunk.indexOf("\r\n\r\n")
  const boundaries = [lf, crlf].filter((value) => value >= 0)
  const event = boundaries.length ? chunk.slice(0, Math.min(...boundaries)) : chunk
  const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
  return !data || data === "[DONE]" ? null : data
}

function embeddedSseErrorStatus(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null
    const numeric = [parsed.status, parsed.status_code, error?.status, error?.status_code]
      .map(Number).find((value) => Number.isInteger(value) && value >= 400 && value <= 599)
    if (numeric) return numeric
    const type = [parsed.type === "error" ? parsed.type : "", parsed.code, error?.type, error?.code]
      .filter((value) => typeof value === "string").join(" ").toLowerCase()
    if (type.includes("rate_limit") || type.includes("too_many_requests")) return 429
    if (type.includes("permission-denied") || type.includes("permission_denied")) return 403
    return null
  } catch { return null }
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset"]) {
    const value = source.get(name); if (value) headers.set(name, value)
  }
  return headers
}

function prependChunk(first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(first) },
    async pull(controller) { const value = await reader.read(); if (value.done) controller.close(); else controller.enqueue(value.value) },
    async cancel(reason) { await reader.cancel(reason) },
  })
}

async function readFirstSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ bytes: Uint8Array; text: string }> {
  const chunks: Uint8Array[] = []
  let total = 0
  let text = ""
  const decoder = new TextDecoder()
  while (!text.includes("\n\n") && !text.includes("\r\n\r\n")) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
    total += next.value.byteLength
    text += decoder.decode(next.value, { stream: true })
  }
  text += decoder.decode()
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { bytes, text }
}

function upstreamHeaders(request: Request, goApiKey: string, endpoint: string): Headers {
  const headers = new Headers()
  for (const name of ["accept", "content-type", "anthropic-version", "anthropic-beta", "user-agent"]) {
    const value = request.headers.get(name); if (value) headers.set(name, value)
  }
  if (!headers.has("content-type") && request.method !== "GET") headers.set("content-type", "application/json")
  if (endpoint === "messages") headers.set("x-api-key", goApiKey)
  else headers.set("authorization", `Bearer ${goApiKey}`)
  return headers
}

export class GatewayService {
  constructor(private readonly credentials: CredentialProvider, readonly db: AppDatabase = getDatabase(), private readonly fetcher: typeof fetch = fetch, private readonly keyHasher?: ApiKeyHasher) {}
  // Note: the default fetcher is the global fetch. For upstream requests we
  // use apiFetch which transparently applies domain mirror mappings. Test
  // code that passes a custom fetcher will bypass mirrors, which is fine
  // since tests use mocked responses.
  // When fetching upstream, we resolve mirror URLs before passing to fetcher.
  // Note: the default fetcher is the global fetch. For upstream requests we
  // use apiFetch which transparently applies domain mirror mappings. Test
  // code that passes a custom fetcher will bypass mirrors, which is fine
  // since tests use mocked responses.

  async handle(request: Request, endpoint: string, options?: GatewayRequestOptions): Promise<Response> {
    const t0 = Date.now()
    const auth = request.headers.get("authorization")
    const plaintext = auth?.startsWith("Bearer ") ? auth.slice(7) : request.headers.get("x-api-key") ?? ""
    const apiKey = options?.principal
      ? {
          id: null,
          ownerUserId: options.principal.ownerUserId,
          prefix: options.principal.label ?? "dashboard-chat",
          allowedModels: null,
        }
      : plaintext ? authenticateApiKey(plaintext, this.db, this.keyHasher) : null
    if (!apiKey) return Response.json({ error: { type: "authentication_error", message: "Invalid gateway API key" } }, { status: 401 })

    // /models endpoint: aggregate available models from all active providers.
    if (endpoint === "models" && request.method === "GET") return this.handleModels(apiKey.ownerUserId)

    const declaredLength = Number(request.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) return Response.json({ error: { type: "request_too_large", message: "Request body exceeds 10 MiB" } }, { status: 413 })
    const requestId = randomUUID()
    const requestBytes = await readRequestBody(request)
    if (request.method !== "GET" && requestBytes === null) return Response.json({ error: { type: "request_too_large", message: "Request body exceeds 10 MiB" } }, { status: 413 })

    let model: string | null = null
    let stream = false
    let requestBodyJson: unknown = undefined
    if (requestBytes?.length) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(requestBytes)) as { model?: unknown; stream?: unknown }
        if (typeof parsed.model === "string") model = parsed.model
        if (parsed.stream === true) stream = true
        requestBodyJson = parsed
      } catch { /* Upstream validates. */ }
    }
    const inferenceRequest = request.method !== "GET" && endpoint !== "models"
    if (inferenceRequest && apiKey.allowedModels?.length && !model) return Response.json({ error: { type: "model_required", message: "A string model is required for restricted API keys" } }, { status: 400 })
    if (apiKey.allowedModels?.length && model && !apiKey.allowedModels.includes(model)) return Response.json({ error: { type: "model_not_allowed", message: "This API key cannot use the requested model" } }, { status: 403 })

    const logSettings = getLogSettings(this.db)
    const logging = logSettings.loggingEnabled
    const configuredMaxFailoverAttempts = getSystemSettings(this.db).maxFailoverAttempts
    // Keep a hard runtime ceiling even if the persisted setting was edited
    // outside the validated settings API.
    const maxFailoverAttempts = Math.max(1, Math.min(32, Number(configuredMaxFailoverAttempts) || 12))
    const meta = collectRequestHeaders(request.headers)

    let upstreamBytes: Uint8Array<ArrayBuffer> | null = requestBytes
    let responsesToolContext: CodexToolContext | undefined
    let responsesProcessMeta: PrepareResponsesResult["meta"] | undefined
    let responsesRoute: "responses" | "chat" = "responses"
    let responsesRouteReason: string | undefined
    let responsesModelHint: string | undefined
    let responsesNativeBody: unknown = undefined
    let effectiveEndpoint = endpoint
    const processResponses = endpoint === "responses" && options?.raw !== true
    const processChat = endpoint === "chat/completions" && options?.raw !== true

    if (requestBodyJson && typeof requestBodyJson === "object") {
      if (processResponses) {
        const prepared = await prepareResponsesRequestBody(requestBodyJson, {
          // Account-tier-aware inject happens after routing selects a seat.
          injectServerTools: false,
          paidAccount: false,
          isCompact: false,
          db: this.db,
        })
        responsesToolContext = prepared.toolContext
        responsesProcessMeta = prepared.meta
        responsesRoute = prepared.route
        responsesRouteReason = prepared.routeReason
        responsesModelHint = prepared.modelHint
        responsesNativeBody = prepared.responsesBody
        requestBodyJson = prepared.body
        if (typeof (prepared.body as { stream?: unknown }).stream === "boolean") {
          stream = (prepared.body as { stream?: boolean }).stream === true
        }
        if (prepared.route === "chat") effectiveEndpoint = "chat/completions"
        upstreamBytes = new TextEncoder().encode(JSON.stringify(prepared.body))
      } else if (processChat) {
        const prepared = prepareChatRequestBody(requestBodyJson)
        requestBodyJson = prepared
        if (typeof (prepared as { stream?: unknown }).stream === "boolean") {
          stream = (prepared as { stream?: boolean }).stream === true
        }
        upstreamBytes = new TextEncoder().encode(JSON.stringify(prepared))
      } else if (stream && logging) {
        const rewritten = ensureStreamUsage(requestBodyJson, endpoint === "responses" ? "responses" : "chat")
        upstreamBytes = new TextEncoder().encode(JSON.stringify(rewritten))
      }
    }

    const chatFallbackUsed = processResponses && responsesRoute === "chat"
    const inboundEndpoint = options?.raw ? `raw/v1/${endpoint}` : `v1/${endpoint}`
    const processMode = options?.raw ? "raw" : (processResponses || processChat ? "processed" : "passthrough")
    const routeMode = processResponses ? responsesRoute : (endpoint === "chat/completions" ? "chat" : endpoint === "responses" ? "responses" : endpoint)
    const routeReason = processResponses
      ? (responsesRouteReason || (responsesRoute === "chat" ? "chat_fallback" : "responses_native"))
      : (options?.raw ? "raw_passthrough" : "direct")
    const converted = Number(chatFallbackUsed)
    const transformParts: string[] = []
    if (options?.raw) transformParts.push("raw")
    if (processResponses) {
      transformParts.push(responsesRoute === "chat" ? "responses->chat" : "responses-native")
      if (responsesProcessMeta?.injectedTools) transformParts.push("inject:web_search+x_search")
      if (responsesProcessMeta?.sanitized) transformParts.push("sanitize-input")
      if (responsesProcessMeta?.rewritten) transformParts.push("rewrite-continuity")
      if (responsesRoute === "responses") transformParts.push("remap-codex")
      if (responsesRoute === "chat") transformParts.push("chat-to-responses")
    } else if (processChat) {
      transformParts.push("chat-normalize")
    }
    if (routeReason) transformParts.push(`reason:${routeReason}`)
    const transformSummary = transformParts.join(" | ")
    const routeMeta = {
      inboundEndpoint,
      upstreamEndpoint: effectiveEndpoint,
      processMode,
      routeMode,
      routeReason,
      converted,
      transformSummary,
    }
    const routing = new RoutingService(apiKey.ownerUserId, this.db)
    routing.setModel(model)
    routing.setRequestConstraint({
      poolType: options?.routing?.poolType ?? null,
      accountId: options?.routing?.accountId ?? null,
    })
    const tried = new Set<string>()
    const permanentlyDisabled = new Set<string>()
    let attemptNumber = 0
    let lastAttemptAccountId: string | undefined
    let lastAttemptAccountName: string | undefined
    let retryAfterSeconds: number | undefined

    while (true) {
      if (attemptNumber >= maxFailoverAttempts) {
        const type = "failover_attempt_limit_reached"
        const status = 503
        const payload = {
          error: {
            type,
            message: `Upstream failover stopped after ${attemptNumber} attempts.`,
            attempts: attemptNumber,
            max_attempts: maxFailoverAttempts,
            ...(retryAfterSeconds ? { retry_after: retryAfterSeconds } : {}),
          },
        }
        const body = JSON.stringify(payload)
        const headers = retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : undefined
        this.finalizeRequest(requestId, {
          status,
          outcome: type,
          attempts: attemptNumber,
          ok: 0,
          latencyMs: Date.now() - t0,
          localPrepMs: 0,
          error: type,
          accountId: lastAttemptAccountId,
          accountName: lastAttemptAccountName,
          responseSizeBytes: new TextEncoder().encode(body).byteLength,
          logSettings,
          requestBodyJson,
          responseBody: payload,
          responseTruncated: false,
          meta,
          ...routeMeta,
        })
        return new Response(body, { status, headers: { "content-type": "application/json", ...(headers ?? {}) } })
      }
      let selection
      try { selection = routing.select(requestId, effectiveEndpoint, tried) } catch (cause) {
        if (cause instanceof NoEligibleAccountError) {
          const exhausted = cause.reason === "EXHAUSTED" || (tried.size > permanentlyDisabled.size)
          const status = exhausted ? 429 : 503
          const headers = exhausted && cause.retryAfterSeconds ? { "retry-after": String(cause.retryAfterSeconds) } : undefined
          const type = exhausted ? "all_provider_accounts_limited" : "no_eligible_account"
          // Do not create dashboard noise for requests that never reached an
          // upstream account; clients commonly retry these 429/503 responses.
          if (attemptNumber > 0) this.finalizeRequest(requestId, { status, outcome: type, attempts: attemptNumber, ok: 0, latencyMs: Date.now() - t0, localPrepMs: 0, error: type, logSettings, requestBodyJson, meta, ...routeMeta })
          return Response.json({ error: { type, message: exhausted ? "All eligible provider accounts are temporarily rate-limited or quota-limited." : "No eligible provider account is available.", ...(cause.retryAfterSeconds ? { retry_after: cause.retryAfterSeconds } : {}) } }, { status, headers })
        }
        throw cause
      }

      if (attemptNumber === 0) {
        try {
          this.db.prepare("INSERT INTO gateway_requests(id,owner_user_id,api_key_id,endpoint,model,started_at,stream,api_key_prefix,client,user_agent,origin,request_size_bytes,inbound_endpoint,upstream_endpoint,process_mode,route_mode,route_reason,converted,transform_summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(requestId, apiKey.ownerUserId, apiKey.id, endpoint, model, new Date().toISOString(), Number(stream), apiKey.prefix, meta.client, meta.userAgent, meta.origin, requestBytes?.byteLength ?? 0, inboundEndpoint, effectiveEndpoint, processMode, routeMode, routeReason, converted, transformSummary)
        } catch (cause) {
          routing.releaseLease(selection.leaseId)
          throw cause
        }
      }
      attemptNumber += 1
      lastAttemptAccountId = selection.account.id
      lastAttemptAccountName = selection.account.name
      const attemptId = randomUUID()
      const attemptStartedAt = Date.now()
      this.db.prepare("INSERT INTO gateway_attempts(id,owner_user_id,request_id,account_id,attempt_number,started_at,account_name) VALUES(?,?,?,?,?,?,?)")
        .run(attemptId, apiKey.ownerUserId, requestId, selection.account.id, attemptNumber, new Date().toISOString(), selection.account.name)
      const upstreamStartedAt = Date.now()
      try {
       const provider = tryGetProvider(selection.account.poolType)
       let attemptUpstreamBytes = upstreamBytes
       let attemptEndpoint = effectiveEndpoint
       let attemptChatFallbackUsed = chatFallbackUsed
       let attemptResponsesRoute = responsesRoute
       let attemptResponsesRouteReason = responsesRouteReason
       let attemptToolContext = responsesToolContext
       let attemptResponsesToChat = false
       if (provider && selection.account.poolType.startsWith("custom:")) {
         const interfaceType = (provider as typeof provider & { interfaceType?: "chat" | "responses" }).interfaceType
         if (processResponses && interfaceType === "chat" && !attemptChatFallbackUsed) {
           const convertedRequest = buildChatFallbackFromResponsesWithContext(responsesNativeBody ?? requestBodyJson)
           attemptUpstreamBytes = new TextEncoder().encode(JSON.stringify(prepareChatRequestBody(convertedRequest.body)))
           attemptToolContext = convertedRequest.toolContext
           attemptEndpoint = "chat/completions"
           attemptChatFallbackUsed = true
           attemptResponsesRoute = "chat"
           attemptResponsesRouteReason = "custom_provider_chat_interface"
         } else if (processResponses && interfaceType === "responses" && attemptChatFallbackUsed) {
           attemptUpstreamBytes = new TextEncoder().encode(JSON.stringify(responsesNativeBody ?? requestBodyJson))
           attemptEndpoint = "responses"
           attemptChatFallbackUsed = false
           attemptResponsesRoute = "responses"
           attemptResponsesRouteReason = "custom_provider_responses_interface"
         } else if (processChat && interfaceType === "responses") {
           attemptUpstreamBytes = new TextEncoder().encode(JSON.stringify(chatRequestToResponses(requestBodyJson)))
           attemptEndpoint = "responses"
           attemptResponsesToChat = true
         }
       }
       if (processResponses && selection.account.poolType === "opencode-go" && !attemptChatFallbackUsed) {
         const convertedRequest = buildChatFallbackFromResponsesWithContext(responsesNativeBody ?? requestBodyJson)
         attemptUpstreamBytes = new TextEncoder().encode(JSON.stringify(prepareChatRequestBody(convertedRequest.body)))
         attemptToolContext = convertedRequest.toolContext
         attemptEndpoint = "chat/completions"
         attemptChatFallbackUsed = true
         attemptResponsesRoute = "chat"
         attemptResponsesRouteReason = "opencode_go_responses_to_chat"
       }
       routeMeta.upstreamEndpoint = attemptEndpoint
       routeMeta.routeMode = processResponses ? attemptResponsesRoute : attemptResponsesToChat ? "responses" : routeMode
       routeMeta.routeReason = attemptResponsesRouteReason || (attemptResponsesToChat ? "custom_provider_responses_interface" : routeReason)
       routeMeta.converted = Number(attemptChatFallbackUsed || attemptResponsesToChat)
       if (processResponses && attemptChatFallbackUsed && !chatFallbackUsed) routeMeta.transformSummary = "responses->chat | reason:" + (attemptResponsesRouteReason || "custom_provider_chat_interface")
       else if (processResponses && !attemptChatFallbackUsed && chatFallbackUsed) routeMeta.transformSummary = "responses-native | reason:custom_provider_responses_interface"
       else if (attemptResponsesToChat) routeMeta.transformSummary = "chat->responses | reason:custom_provider_responses_interface"
       let upstream: Response
       if (provider) {
          let credential: import("./providers").ProviderCredential
          try {
            credential = await provider.getCredential(selection.account)
          } catch {
            // Fallback to legacy CredentialProvider (e.g., in-memory test DB).
            const legacy = await this.credentials.get(apiKey.ownerUserId, selection.account.id)
            credential = { token: legacy.goApiKey, credentialVersion: legacy.credentialVersion }
          }
          const upstreamModel = provider.resolveModel(selection.account, model ?? "")
          // Free xAI seats never auto-inject server tools; paid seats get web_search/x_search.
          if (
            processResponses
            && responsesRoute === "responses"
            && selection.account.poolType === "xai-grok"
            && isXaiPaidAccount(selection.account.id)
            && upstreamBytes
          ) {
            try {
              const current = JSON.parse(new TextDecoder().decode(upstreamBytes)) as unknown
              const injected = injectDefaultServerTools(current, { enabled: true, tools: ["web_search", "x_search"] })
              const normalized = normalizeToolsInBody(injected, { mode: "responses" })
              const currentTools = current && typeof current === "object" ? (current as { tools?: unknown }).tools : null
              const normalizedTools = normalized && typeof normalized === "object" ? (normalized as { tools?: unknown }).tools : null
              const beforeCount = Array.isArray(currentTools) ? currentTools.length : 0
              const afterCount = Array.isArray(normalizedTools) ? normalizedTools.length : 0
              if (afterCount > beforeCount) {
                upstreamBytes = new TextEncoder().encode(JSON.stringify(normalized))
                requestBodyJson = normalized
                if (responsesProcessMeta) responsesProcessMeta.injectedTools = true
                const parts = String(routeMeta.transformSummary || "").split(" | ").filter(Boolean)
                if (!parts.some((p) => p.startsWith("inject:"))) parts.splice(1, 0, "inject:web_search+x_search")
                routeMeta.transformSummary = parts.join(" | ")
                this.db.prepare("UPDATE gateway_requests SET transform_summary=?, process_mode=process_mode WHERE id=?")
                  .run(routeMeta.transformSummary, requestId)
              }
            } catch { /* keep original body */ }
          }
          // OpenCode Go rejects Responses server search tools (web_search/x_search).
          if (
            processResponses
            && selection.account.poolType === "opencode-go"
            && attemptUpstreamBytes
          ) {
            try {
              const current = JSON.parse(new TextDecoder().decode(attemptUpstreamBytes)) as { tools?: unknown; tool_choice?: unknown }
              if (Array.isArray(current.tools)) {
                const kept = current.tools.filter((tool) => {
                  if (!tool || typeof tool !== "object") return true
                  const type = String((tool as { type?: unknown }).type || "").toLowerCase()
                  return type !== "web_search" && type !== "x_search"
                })
                if (kept.length !== current.tools.length) {
                  if (kept.length === 0) delete current.tools
                  else current.tools = kept
                  if (current.tool_choice && typeof current.tool_choice === "object") {
                    const choice = current.tool_choice as { name?: unknown; function?: { name?: unknown } }
                    const choiceName = String(choice.name || (choice.function && choice.function.name) || "").toLowerCase()
                    if (choiceName === "web_search" || choiceName === "x_search") current.tool_choice = "auto"
                  }
                  attemptUpstreamBytes = new TextEncoder().encode(JSON.stringify(current))
                  requestBodyJson = current
                  const parts = String(routeMeta.transformSummary || "").split(" | ").filter(Boolean)
                  if (!parts.some((p) => p.startsWith("strip:"))) parts.splice(1, 0, "strip:web_search+x_search")
                  routeMeta.transformSummary = parts.join(" | ")
                  this.db.prepare("UPDATE gateway_requests SET transform_summary=?, process_mode=process_mode WHERE id=?")
                    .run(routeMeta.transformSummary, requestId)
                }
              }
            } catch { /* keep original body */ }
          }
          const target = provider.buildForwardTarget({
            method: request.method, endpoint: attemptEndpoint, model: model ?? "", upstreamModel,
            body: attemptUpstreamBytes, headers: request.headers,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
          }, credential, selection.account)
          upstream = await this.fetcher(resolveMirrorUrlForContext(target.url, { account: selection.account }), {
            method: request.method,
            headers: target.headers,
            body: target.body,
            redirect: "error",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
          })
        } else {
          const credential = await this.credentials.get(apiKey.ownerUserId, selection.account.id)
          const path = attemptEndpoint.replace(/^\/+/, "")
          upstream = await this.fetcher(resolveMirrorUrlForContext(`${selection.target.baseUrl}/${path}`, { account: selection.account }), {
            method: request.method,
            headers: upstreamHeaders(request, credential.goApiKey, effectiveEndpoint),
            body: attemptUpstreamBytes,
            redirect: "error",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
          })
        }
        if (!upstream.ok) {
          const body = await upstream.text()
          const errorClass = (provider ? provider.classifyError(upstream.status, body, upstream.headers) : null)
            ?? (upstream.status === 429 ? goLimitToErrorClass(classifyGoUsageLimit(upstream, body)) : null)
          if (errorClass?.permanentlyDisableAccount) {
            tried.add(selection.account.id)
            permanentlyDisabled.add(selection.account.id)
            routing.markPermanentlyDisabled(selection.account.id, errorClass.errorType, extractBodyError(safeParse(body)) ?? body)
            this.finishAttempt(attemptId, upstream.status, "RETRY_NEXT_ACCOUNT", errorClass.errorType, Date.now() - attemptStartedAt, "账号已被上游永久禁用", selection.account.name, body)
            continue
          }
          if (errorClass?.shouldSwitchAccount) {
            tried.add(selection.account.id)
            const attemptRetryAfterSeconds = errorClass.retryAfterSeconds ?? parseRetryAfter(upstream)
            if (attemptRetryAfterSeconds && attemptRetryAfterSeconds > 0) {
              retryAfterSeconds = retryAfterSeconds == null
                ? attemptRetryAfterSeconds
                : Math.min(retryAfterSeconds, attemptRetryAfterSeconds)
            }
            routing.markQuota(selection.account.id, errorClass.quotaKind ?? "UNKNOWN_GO_LIMIT", attemptRetryAfterSeconds)
            this.finishAttempt(attemptId, upstream.status, "RETRY_NEXT_ACCOUNT", errorClass.errorType, Date.now() - attemptStartedAt, errorClass.errorType, selection.account.name, body)
            continue
          }
          const type = errorType(body)
          const parsed = safeParse(body)
          const bodyError = extractBodyError(parsed) ?? null
          const status = upstream.status
          this.finishAttempt(attemptId, status, "RETURN_DIRECTLY", type, Date.now() - attemptStartedAt, bodyError, selection.account.name, body)
          this.finalizeRequest(requestId, { status, outcome: type ?? "upstream_error", attempts: attemptNumber, ok: isLogOk(status, bodyError) ? 1 : 0, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, error: bodyError, accountId: selection.account.id, accountName: selection.account.name, responseSizeBytes: body.length, usage: extractUsage(parsed), logSettings, requestBodyJson, responseBody: parsed, responseTruncated: false, meta, ...routeMeta })
          return new Response(body, { status, headers: responseHeaders(upstream.headers) })
        }

        if (attemptResponsesToChat && !(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
          const raw = await upstream.text()
          let converted: unknown
          try { converted = responsesJsonToChatCompletion(JSON.parse(raw)) } catch { converted = { error: { type: "invalid_upstream_response", message: raw.slice(0, 500) } } }
          const body = JSON.stringify(converted)
          routing.markSuccess(selection.account.id)
          const status = upstream.status
          this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, null, selection.account.name)
          this.finalizeRequest(requestId, { status, outcome: "SUCCESS", attempts: attemptNumber, ok: 1, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, usage: extractUsage(converted), accountId: selection.account.id, accountName: selection.account.name, responseSizeBytes: body.length, logSettings, requestBodyJson, responseBody: logging ? converted : undefined, responseTruncated: false, meta, ...routeMeta })
          return new Response(body, { status, headers: responseHeaders(upstream.headers) })
        }

        const contentType = upstream.headers.get("content-type") ?? ""
        if (contentType.includes("text/event-stream") && upstream.body) {
          const reader = upstream.body.getReader()
          const first = await readFirstSseEvent(reader)
          const sseData = firstSseData(first.text)
          const embeddedStatus = sseData ? embeddedSseErrorStatus(sseData) : null
          const sseLimit = (provider && sseData && embeddedStatus ? provider.classifyError(embeddedStatus, sseData, upstream.headers) : null)
            ?? (first.text.includes("GoUsageLimitError") ? goLimitToErrorClass(classifyFirstSseEvent(upstream.headers, first.text)) : null)
          if (sseLimit?.permanentlyDisableAccount) {
            await reader.cancel(); tried.add(selection.account.id); permanentlyDisabled.add(selection.account.id)
            routing.markPermanentlyDisabled(selection.account.id, sseLimit.errorType, extractBodyError(safeParse(sseData ?? "")) ?? sseLimit.errorType)
            this.finishAttempt(attemptId, embeddedStatus ?? 403, "RETRY_NEXT_ACCOUNT", sseLimit.errorType, Date.now() - attemptStartedAt, "账号已被上游永久禁用", selection.account.name, first.text)
            continue
          }
          if (sseLimit?.shouldSwitchAccount) {
            await reader.cancel(); tried.add(selection.account.id)
            const attemptRetryAfterSeconds = sseLimit.retryAfterSeconds ?? parseRetryAfter(upstream)
            if (attemptRetryAfterSeconds && attemptRetryAfterSeconds > 0) {
              retryAfterSeconds = retryAfterSeconds == null
                ? attemptRetryAfterSeconds
                : Math.min(retryAfterSeconds, attemptRetryAfterSeconds)
            }
            routing.markQuota(selection.account.id, sseLimit.quotaKind ?? "UNKNOWN_GO_LIMIT", attemptRetryAfterSeconds)
            this.finishAttempt(attemptId, 429, "RETRY_NEXT_ACCOUNT", sseLimit.errorType, Date.now() - attemptStartedAt, sseLimit.errorType, selection.account.name, first.text)
            continue
          }
          routing.markSuccess(selection.account.id)
          if (provider?.extractQuotaFromResponse) {
            const qw = provider.extractQuotaFromResponse(upstream.headers)
            if (qw) this.recordPassiveQuota(selection.account.id, qw)
          }
          const rebuilt = prependChunk(first.bytes, reader)
          const firstTokenAt = Date.now()
          const status = upstream.status
          // Always capture usage for dashboard stats, even when body logging is off.
          const onComplete = (r: CaptureResult) => {
            const latencyMs = Date.now() - t0
            const firstTokenMs = firstTokenAt - upstreamStartedAt
            this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, r.error ?? null, selection.account.name)
            this.finalizeRequest(requestId, {
              status,
              outcome: "SUCCESS",
              attempts: attemptNumber,
              ok: isLogOk(status, r.error) ? 1 : 0,
              latencyMs,
              localPrepMs: upstreamStartedAt - t0,
              firstTokenMs,
              usage: r.usage,
              error: r.error,
              accountId: selection.account.id,
              accountName: selection.account.name,
              responseSizeBytes: r.responseBytes ?? null,
              logSettings,
              requestBodyJson,
              responseBody: logging ? r.response : undefined,
              responseTruncated: r.responseTruncated,
              meta,
              ...routeMeta,
            })
            if (processResponses && responsesProcessMeta) {
              void rememberResponsesTurn({
                responsePayload: r.response,
                continuityKeys: responsesProcessMeta.continuityKeys,
                userMessages: responsesProcessMeta.userMessages,
                preferredMode: attemptChatFallbackUsed ? "chat" : "responses",
                db: this.db,
              })
            }
          }
          let outStream: ReadableStream<Uint8Array> = teeAndCapture(rebuilt, onComplete)
          if (selection.account.poolType === "opencode-go" && processResponses && !attemptChatFallbackUsed && !attemptResponsesToChat) {
            outStream = normalizeOpenCodeGoResponsesSse(outStream)
            if (attemptToolContext) outStream = remapResponsesSuccessStream(outStream, attemptToolContext)
          } else if (attemptChatFallbackUsed) outStream = convertChatStreamToResponses(outStream, responsesModelHint, attemptToolContext)
          else if (attemptResponsesToChat) outStream = responsesSseToChatStream(outStream)
          else if (processResponses && attemptToolContext) outStream = remapResponsesSuccessStream(outStream, attemptToolContext)
          const headers = responseHeaders(upstream.headers)
          if (processResponses) {
            headers.set("x-responses-route", attemptResponsesRoute)
            if (attemptResponsesRouteReason) headers.set("x-responses-route-reason", attemptResponsesRouteReason)
          }
          if (attemptChatFallbackUsed) {
            headers.set("x-grok-fallback", "chat_completions")
            headers.set("x-grok-fallback-from", "/v1/responses")
            headers.set("x-grok-fallback-to", "/v1/chat/completions")
            if (attemptResponsesRouteReason) headers.set("x-grok-fallback-reason", attemptResponsesRouteReason)
          }
          return new Response(outStream, { status, headers })
        }
        routing.markSuccess(selection.account.id)
        if (provider?.extractQuotaFromResponse) {
          const qw = provider.extractQuotaFromResponse(upstream.headers)
          if (qw) this.recordPassiveQuota(selection.account.id, qw)
        }
        const status = upstream.status
        // Non-stream JSON path for processed /v1/responses (native or chat-fallback).
        if (processResponses && upstream.body) {
          const reader = upstream.body.getReader()
          const chunks: Uint8Array[] = []
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            if (next.value) chunks.push(next.value)
          }
          let total = 0
          for (const chunk of chunks) total += chunk.byteLength
          const buf = new Uint8Array(total)
          let off = 0
          for (const chunk of chunks) { buf.set(chunk, off); off += chunk.byteLength }
          let outBytes = buf
          let remappedJson: unknown = undefined
          try {
            const json = JSON.parse(new TextDecoder().decode(buf))
            if (attemptChatFallbackUsed) remappedJson = convertChatJsonToResponses(json, responsesModelHint, attemptToolContext)
            else if (attemptToolContext) remappedJson = remapResponsesSuccessBody(json, attemptToolContext)
            else remappedJson = json
            outBytes = new TextEncoder().encode(JSON.stringify(remappedJson))
          } catch { /* keep original bytes */ }

          if (processResponses && responsesProcessMeta) {
            void rememberResponsesTurn({
              responsePayload: remappedJson,
              continuityKeys: responsesProcessMeta.continuityKeys,
              userMessages: responsesProcessMeta.userMessages,
              preferredMode: attemptChatFallbackUsed ? "chat" : "responses",
              db: this.db,
            })
          }

          const headers = responseHeaders(upstream.headers)
          if (processResponses) {
            headers.set("x-responses-route", attemptResponsesRoute)
            if (attemptResponsesRouteReason) headers.set("x-responses-route-reason", attemptResponsesRouteReason)
          }
          if (attemptChatFallbackUsed) {
            headers.set("x-grok-fallback", "chat_completions")
            headers.set("x-grok-fallback-from", "/v1/responses")
            headers.set("x-grok-fallback-to", "/v1/chat/completions")
            if (attemptResponsesRouteReason) headers.set("x-grok-fallback-reason", attemptResponsesRouteReason)
          }

          const usage = extractUsage(remappedJson)
          this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, null, selection.account.name)
          this.finalizeRequest(requestId, {
            status,
            outcome: "SUCCESS",
            attempts: attemptNumber,
            ok: 1,
            latencyMs: Date.now() - t0,
            localPrepMs: upstreamStartedAt - t0,
            usage,
            accountId: selection.account.id,
            accountName: selection.account.name,
            responseSizeBytes: outBytes.byteLength,
            logSettings,
            requestBodyJson,
            responseBody: logging ? remappedJson : undefined,
            responseTruncated: false,
            meta,
            ...routeMeta,
          })
          return new Response(outBytes, { status, headers })
        }

        if (upstream.body) {
          const onComplete = (r: CaptureResult) => {
            const latencyMs = Date.now() - t0
            this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, r.error ?? null, selection.account.name)
            this.finalizeRequest(requestId, {
              status,
              outcome: "SUCCESS",
              attempts: attemptNumber,
              ok: isLogOk(status, r.error) ? 1 : 0,
              latencyMs,
              localPrepMs: upstreamStartedAt - t0,
              usage: r.usage,
              error: r.error,
              accountId: selection.account.id,
              accountName: selection.account.name,
              responseSizeBytes: r.responseBytes ?? null,
              logSettings,
              requestBodyJson,
              responseBody: logging ? r.response : undefined,
              responseTruncated: r.responseTruncated,
              meta,
              ...routeMeta,
            })
          }
          return new Response(captureJsonResponse(upstream.body, onComplete), { status, headers: responseHeaders(upstream.headers) })
        }
        this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, null, selection.account.name)
        this.finalizeRequest(requestId, { status, outcome: "SUCCESS", attempts: attemptNumber, ok: 1, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, accountId: selection.account.id, accountName: selection.account.name, logSettings, requestBodyJson, meta, ...routeMeta })
        return new Response(upstream.body, { status, headers: responseHeaders(upstream.headers) })
      } catch (cause) {
        const message = formatErrorDetail(cause)
        this.finishAttempt(attemptId, 502, "RETURN_DIRECTLY", "NETWORK", Date.now() - attemptStartedAt, message, selection.account.name, null)
        this.finalizeRequest(requestId, { status: 502, outcome: "NETWORK", attempts: attemptNumber, ok: 0, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, error: message, accountId: selection.account.id, accountName: selection.account.name, logSettings, requestBodyJson, meta, ...routeMeta })
        return Response.json({ error: { type: "upstream_transport_error", message } }, { status: 502 })
      } finally { routing.releaseLease(selection.leaseId) }
    }
  }

  private finishAttempt(id: string, status: number, decision: string, error: string | null, latencyMs?: number, errorMessage?: string | null, accountName?: string | null, responseBody?: string | null) {
    this.db.prepare("UPDATE gateway_attempts SET status=?,decision=?,error_type=?,completed_at=?,latency_ms=?,error_message=?,account_name=?,response_body=? WHERE id=?")
      .run(status, decision, error, new Date().toISOString(), latencyMs ?? null, truncateError(errorMessage), accountName ?? null, responseBody ?? null, id)
  }

  private finalizeRequest(id: string, input: RequestFinalizeInput): void {
    const usage = input.usage ?? {}
    this.db.prepare(`UPDATE gateway_requests SET status=?,outcome=?,attempt_count=?,completed_at=?,ok=?,latency_ms=?,local_prep_ms=?,first_token_ms=?,error=?,account_id=?,account_name=?,response_size_bytes=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,cached_tokens=?,reasoning_tokens=?,text_tokens=?,image_tokens=?,audio_tokens=?,inbound_endpoint=COALESCE(?,inbound_endpoint),upstream_endpoint=COALESCE(?,upstream_endpoint),process_mode=COALESCE(?,process_mode),route_mode=COALESCE(?,route_mode),route_reason=COALESCE(?,route_reason),converted=COALESCE(?,converted),transform_summary=COALESCE(?,transform_summary) WHERE id=?`)
      .run(
        input.status, input.outcome, input.attempts, new Date().toISOString(),
        input.ok ?? 0, input.latencyMs ?? null, input.localPrepMs ?? null, input.firstTokenMs ?? null, truncateError(input.error),
        input.accountId ?? null, input.accountName ?? null, input.responseSizeBytes ?? null,
        usage.promptTokens ?? null, usage.completionTokens ?? null, usage.totalTokens ?? null, usage.cachedTokens ?? null, usage.reasoningTokens ?? null, usage.textTokens ?? null, usage.imageTokens ?? null, usage.audioTokens ?? null,
        input.inboundEndpoint ?? null, input.upstreamEndpoint ?? null, input.processMode ?? null, input.routeMode ?? null, input.routeReason ?? null, input.converted ?? null, input.transformSummary ?? null,
        id,
      )
    // xAI free tier headers are often stale (remaining always 1M). After a
    // successful response, recompute rolling usage from local request logs so
    // the progress bar reflects actual consumption.
    if (input.ok === 1 && input.accountId) {
      const account = this.db.prepare("SELECT owner_user_id, pool_type FROM accounts WHERE id=?").get(input.accountId) as { owner_user_id: string; pool_type: string } | undefined
      if (account?.pool_type === "xai-grok") {
        try { upsertLocalRollingUsage(account.owner_user_id, input.accountId, this.db) } catch { /* best-effort */ }
      }
    }
    const settings = input.logSettings
    if (settings && settings.loggingEnabled) {
      const wantBodies = settings.logBodies || (input.ok !== 1 && settings.logBodiesOnError)
      if (wantBodies) this.writeBodies(id, settings.maxBodyCaptureBytes, input.requestBodyJson, input.responseBody, input.responseTruncated, input.meta)
    }
  }

  private writeBodies(id: string, maxBytes: number, requestBodyJson: unknown, responseBody: unknown, responseTruncated: boolean | undefined, meta: { headers: Record<string, string> } | undefined): void {
    const reqCloned = requestBodyJson !== undefined ? safeCloneBody(requestBodyJson, maxBytes) : { value: undefined as unknown, truncated: false }
    const resCloned = responseBody !== undefined ? safeCloneBody(responseBody, maxBytes) : { value: undefined as unknown, truncated: false }
    this.db.prepare("INSERT OR REPLACE INTO request_bodies(request_id,request_body_json,response_body_json,request_headers_json,request_truncated,response_truncated,has_request,has_response,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        reqCloned.value === undefined ? null : JSON.stringify(reqCloned.value),
        resCloned.value === undefined ? null : JSON.stringify(resCloned.value),
        meta ? JSON.stringify(meta.headers) : null,
        reqCloned.truncated ? 1 : 0,
        responseTruncated || resCloned.truncated ? 1 : 0,
        reqCloned.value !== undefined ? 1 : 0,
        resCloned.value !== undefined ? 1 : 0,
        new Date().toISOString(),
      )
  }

  private handleModels(ownerUserId: string): Response {
    const accounts = new AccountRepository(ownerUserId, this.db).list()
    const registry = getProviderRegistry()
    const activePoolTypes = registry.activePoolTypes(accounts)
    const modelSet = new Set<string>()
    for (const poolType of activePoolTypes) {
      const provider = registry.tryGet(poolType)
      if (!provider) continue
      const poolAccounts = accounts.filter((a) => a.poolType === poolType)
      for (const model of provider.getAvailableModels(poolAccounts)) modelSet.add(model)
    }
    if (modelSet.size === 0) {
      for (const provider of registry.all()) {
        for (const model of provider.getAvailableModels([])) modelSet.add(model)
      }
    }
    const models = [...modelSet].sort().map((id) => ({ id, object: "model", created: 0, owned_by: "gateway" }))
    return Response.json({ object: "list", data: models })
  }

  private recordPassiveQuota(accountId: string, windows: { kind: QuotaKind; usagePercent: number; resetInSeconds: number | null; limitValue?: number | null; remainingValue?: number | null }[]): void {
    const now = new Date()
    const timestamp = now.toISOString()
    const ownerRow = this.db.prepare("SELECT owner_user_id FROM accounts WHERE id=?").get(accountId) as { owner_user_id: string } | undefined
    const ownerUserId = ownerRow?.owner_user_id ?? ""
    for (const w of windows) {
      // Ignore obviously-stale full-remaining token windows from xAI headers.
      // Local usage tracking will fill the real progress after the request completes.
      if (w.kind === "ROLLING_24H" && w.limitValue && w.remainingValue != null && w.limitValue === w.remainingValue && w.usagePercent === 0) {
        continue
      }
      const resetAt = w.resetInSeconds ? new Date(now.getTime() + w.resetInSeconds * 1000).toISOString() : null
      this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
        VALUES(?,?,?,?,?,'UPSTREAM_HEADER',?,?,?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
        usage_percent=excluded.usage_percent,reset_at=excluded.reset_at,source='UPSTREAM_HEADER',limit_value=excluded.limit_value,
        remaining_value=excluded.remaining_value,observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
        .run(ownerUserId, accountId, w.kind, w.usagePercent, resetAt, timestamp, w.limitValue ?? null, w.remainingValue ?? null)
    }
  }
}
