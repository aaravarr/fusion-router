/**
 * 接口格式决策表：入口格式 × 账号支持集合 → (上游端点, 转换链)。
 *
 * chat completions 是转换枢纽：
 * - messages 入口 → 支持 chat：messages→chat
 * - messages 入口 → 只支持 responses：messages→chat→responses（接力）
 * - chat 入口 → 只支持 responses：chat→responses
 * - responses 入口 → 只支持 chat：responses→chat
 * 原生命中（入口格式在支持集合内）时不做任何转换。
 */

export type InterfaceFormat = "chat" | "responses" | "messages"
export type UpstreamEndpoint = "chat/completions" | "responses" | "messages"

/** 请求方向的单步转换。响应方向沿同一条链逆向回放。 */
export type RequestTransform = "messages->chat" | "chat->responses" | "responses->chat"

export type ResponseTransform = "chat->messages" | "responses->chat" | "chat->responses"

export interface RouteDecision {
  /** 转发给上游的端点。 */
  upstreamEndpoint: UpstreamEndpoint
  /** 请求体需要依次套用的转换；空数组 = 原生直通。 */
  requestChain: RequestTransform[]
  /** 响应需要依次套用的转换（requestChain 的逆向）。 */
  responseChain: ResponseTransform[]
  /** 入口格式被原生支持。 */
  native: boolean
  /** 决策原因，写入 route_reason 日志维度。 */
  reason: string
}

const ENDPOINT_BY_FORMAT: Record<InterfaceFormat, UpstreamEndpoint> = {
  chat: "chat/completions",
  responses: "responses",
  messages: "messages",
}

export function endpointForFormat(format: InterfaceFormat): UpstreamEndpoint {
  return ENDPOINT_BY_FORMAT[format]
}

export function formatForEndpoint(endpoint: string): InterfaceFormat | null {
  const normalized = endpoint.replace(/^\/+/, "")
  if (normalized === "chat/completions") return "chat"
  if (normalized === "responses") return "responses"
  if (normalized === "messages") return "messages"
  return null
}

const RESPONSE_STEP: Record<RequestTransform, ResponseTransform> = {
  "messages->chat": "chat->messages",
  "chat->responses": "responses->chat",
  "responses->chat": "chat->responses",
}

const TARGET_FORMAT: Record<RequestTransform, InterfaceFormat> = {
  "messages->chat": "chat",
  "chat->responses": "responses",
  "responses->chat": "chat",
}

function decision(inbound: InterfaceFormat, requestChain: RequestTransform[], reason: string): RouteDecision {
  const target = requestChain.length ? TARGET_FORMAT[requestChain[requestChain.length - 1]] : inbound
  return {
    upstreamEndpoint: endpointForFormat(target),
    requestChain,
    responseChain: [...requestChain].reverse().map((step) => RESPONSE_STEP[step]),
    native: requestChain.length === 0,
    reason,
  }
}

/**
 * 计算入口格式到账号支持集合的路由。返回 null 表示该账号无法以任何
 * 已知转换链服务此入口格式（路由层应提前排除这类账号）。
 */
export function decideUpstreamRoute(inbound: InterfaceFormat, supported: readonly InterfaceFormat[]): RouteDecision | null {
  if (supported.includes(inbound)) return decision(inbound, [], `${inbound}_native`)
  if (inbound === "messages") {
    if (supported.includes("chat")) return decision(inbound, ["messages->chat"], "messages_to_chat")
    if (supported.includes("responses")) return decision(inbound, ["messages->chat", "chat->responses"], "messages_to_responses")
    return null
  }
  if (inbound === "chat") {
    if (supported.includes("responses")) return decision(inbound, ["chat->responses"], "chat_to_responses")
    return null
  }
  // inbound === "responses"
  if (supported.includes("chat")) return decision(inbound, ["responses->chat"], "responses_to_chat")
  return null
}

/** 账号能否服务该入口格式（原生或经转换链）。supported 为空/未知时视为可服务。 */
export function canServeInterface(inbound: InterfaceFormat, supported: readonly InterfaceFormat[] | null | undefined): boolean {
  if (!supported?.length) return true
  return decideUpstreamRoute(inbound, supported) !== null
}
