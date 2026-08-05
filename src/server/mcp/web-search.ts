import type { AppDatabase } from "@/server/db"
import { GatewayService } from "@/server/gateway"
import { getGoCredential } from "@/server/opencode-web/service"
import type { PoolType } from "@/server/types"
import {
  DEFAULT_WEB_SEARCH_PROMPT,
  ensureDefaultMcpTools,
  getMcpTool,
  MCP_TOOL_DEFINITIONS,
  type McpToolConfig,
} from "./mcp-tools"

export interface WebSearchResult {
  text: string
  model: string
  accountName: string | null
}

interface WebSearchRequestBody {
  config: McpToolConfig
  ownerUserId: string
  body: {
    model: string
    stream: boolean
    input: Array<{
      role: string
      content: Array<{ type: string; text: string }>
    }>
    tools: Array<{ type: "web_search" }>
    max_output_tokens: number
    temperature: number
    reasoning: { effort: "none" | "low" | "medium" | "high" }
  }
}

/**
 * 组装 responses 请求体：
 * - 文本 = 默认提示词 + 调用方附加指令 + 搜索词（用户问题）
 * - tools 只带内置 web_search 服务器工具
 * - reasoning 开启时用配置的 effort（缺省 medium），否则显式 none
 */
function buildWebSearchRequestBody(
  input: { query: string; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  stream: boolean,
): WebSearchRequestBody {
  if (!ctx.ownerUserId) throw new Error("未指定调用用户")

  let tool = getMcpTool("web_search", db)
  if (!tool) {
    ensureDefaultMcpTools(db)
    tool = getMcpTool("web_search", db)
  }
  if (!tool) throw new Error("搜索工具未初始化")

  const definition = MCP_TOOL_DEFINITIONS.find((item) => item.toolType === "web_search")
  const defaultConfig: McpToolConfig =
    definition?.defaultConfig ?? {
      poolType: null,
      model: "",
      prompt: DEFAULT_WEB_SEARCH_PROMPT,
      maxTokens: 2048,
      temperature: 0.3,
      reasoningEnabled: false,
      reasoningEffort: null,
    }
  const config: McpToolConfig = { ...defaultConfig, ...tool.config }
  if (!config.model) throw new Error("尚未配置搜索模型，请先在管理后台 MCP 页面选择模型")

  const text = [config.prompt, input.prompt, input.query].filter(Boolean).join("\n\n")

  const body: WebSearchRequestBody["body"] = {
    model: config.model,
    stream,
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
    tools: [{ type: "web_search" }],
    max_output_tokens: config.maxTokens,
    temperature: config.temperature,
    reasoning: config.reasoningEnabled
      ? { effort: config.reasoningEffort ?? "medium" }
      : { effort: "none" },
  }

  return { config, ownerUserId: ctx.ownerUserId, body }
}

function defaultGateway(db: AppDatabase, ownerUserId: string, config: McpToolConfig) {
  return (req: Request, endpoint: string) =>
    new GatewayService({ get: getGoCredential }, db).handle(req, endpoint, {
      principal: { ownerUserId, label: "mcp-web-search" },
      routing: config.poolType ? { poolType: config.poolType as PoolType } : undefined,
    })
}

async function extractUpstreamErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: { message?: unknown } }
    if (typeof parsed.error?.message === "string" && parsed.error.message) return parsed.error.message
  } catch {
    // 保留默认错误信息
  }
  return fallback
}

/**
 * 从 responses JSON 的 output[] 提取回答文本：
 * 只取 type==="message" 的 item，拼接其 content[] 里所有 text 字段，
 * 跳过 reasoning / web_search_call / function_call 等其它 item 类型。
 */
function extractResponseText(data: unknown): string {
  if (!data || typeof data !== "object" || !Array.isArray((data as { output?: unknown }).output)) return ""
  const parts: string[] = []
  for (const item of (data as { output: unknown[] }).output) {
    if (!item || typeof item !== "object") continue
    const record = item as { type?: unknown; content?: unknown }
    if (record.type !== "message") continue
    if (!Array.isArray(record.content)) continue
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue
      const text = (part as { text?: unknown }).text
      if (typeof text === "string" && text) parts.push(text)
    }
  }
  return parts.join("")
}

/** SSE delta 兼容字符串与 { text } 两种形态。 */
function extractTextDelta(delta: unknown): string {
  if (typeof delta === "string") return delta
  if (delta && typeof delta === "object" && typeof (delta as { text?: unknown }).text === "string") {
    return (delta as { text: string }).text
  }
  return ""
}

export async function webSearch(
  input: { query: string; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<WebSearchResult> {
  const { config, ownerUserId, body } = buildWebSearchRequestBody(input, db, ctx, false)

  const request = new Request("http://internal/mcp/web_search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const gateway = callGateway ?? defaultGateway(db, ownerUserId, config)
  const response = await gateway(request, "responses")
  if (!response.ok) {
    throw new Error(await extractUpstreamErrorMessage(response, `联网搜索请求失败 (${response.status})`))
  }

  const data = (await response.json()) as { output?: unknown }
  const text = extractResponseText(data)
  if (!text) throw new Error("模型未返回内容")

  return { text, model: config.model, accountName: null }
}


function mcpSseEvent(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
}

/** 构造标准 tools/call 的 JSON-RPC result：完整 content 一次性返回。 */
function toolResult(id: unknown, text: string, isError: boolean): unknown {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      content: [{ type: "text", text }],
      isError,
    },
  }
}

/**
 * Streams web_search through MCP Streamable HTTP（标准实现）：
 * - 可选发送 notifications/progress 进度通知（客户端请求 progressToken 时）；
 * - 最后发送一条带完整 result.content 的 JSON-RPC response 后关闭流。
 * 上游（responses，DeepSeek 搜索可能 10~30s）请求在流内执行，客户端能立即收到响应头。
 * response.reasoning_text.delta 忽略，只累积 output_text.delta。
 */
export async function webSearchStream(
  input: { query: string; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  id: unknown,
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
  options?: { progressToken?: string | number },
): Promise<ReadableStream<Uint8Array>> {
  const { config, ownerUserId, body } = buildWebSearchRequestBody(input, db, ctx, true)

  const request = new Request("http://internal/mcp/web_search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (payload: unknown): void => controller.enqueue(mcpSseEvent(payload))
      const emitProgress = (progress: number, total: number): void => {
        if (options?.progressToken === undefined) return
        emit({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: options.progressToken, progress, total },
        })
      }
      try {
        emitProgress(0, 1)
        const gateway = callGateway ?? defaultGateway(db, ownerUserId, config)
        const response = await gateway(request, "responses")
        if (!response.ok) {
          const message = await extractUpstreamErrorMessage(response, `联网搜索请求失败 (${response.status})`)
          emit(toolResult(id, message, true))
          return
        }
        if (!response.body) {
          emit(toolResult(id, "上游未返回内容", true))
          return
        }

        const contentType = response.headers.get("content-type") ?? ""
        const isSse = contentType.includes("text/event-stream")
        let text = ""

        if (!isSse) {
          // Non-SSE upstream (some providers ignore stream): use the whole text once.
          const data = (await response.json()) as { output?: unknown }
          text = extractResponseText(data)
        } else {
          // SSE upstream: accumulate the full text from responses output_text.delta events.
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          try {
            outer: for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let nl: number
              while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, "")
                buffer = buffer.slice(nl + 1)
                if (!line.startsWith("data:")) continue
                const data = line.slice(5).trimStart()
                if (!data) continue
                if (data === "[DONE]") break outer
                try {
                  const parsed = JSON.parse(data) as { type?: string; delta?: unknown }
                  if (parsed.type !== "response.output_text.delta") continue
                  text += extractTextDelta(parsed.delta)
                } catch {
                  // 忽略无法解析的 data 行
                }
              }
            }
          } finally {
            try {
              await reader.cancel()
            } catch {
              // 已关闭
            }
          }
        }

        emitProgress(1, 1)
        emit(toolResult(id, text, false))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        emit(toolResult(id, `联网搜索失败：${message}`, true))
      } finally {
        controller.close()
      }
    },
    cancel() {
      // 客户端断开：不再推送。
    },
  })
}
