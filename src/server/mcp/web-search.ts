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

function contentBlockDelta(text: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "notifications/content_block_delta",
    params: { id: 0, delta: { type: "text", text } },
  }
}

/**
 * Streams web_search through MCP streamable HTTP: an initial empty result
 * followed by content_block_start / content_block_delta / content_block_stop
 * notifications, fed from the upstream responses SSE stream
 * (response.output_text.delta；response.reasoning_text.delta 忽略)。
 */
export async function webSearchStream(
  input: { query: string; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  id: unknown,
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<ReadableStream<Uint8Array>> {
  const { config, ownerUserId, body } = buildWebSearchRequestBody(input, db, ctx, true)

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

  const initial = {
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [], isError: false },
    meta: {},
  }
  const contentBlockStart = {
    jsonrpc: "2.0",
    method: "notifications/content_block_start",
    params: { id: 0, contentBlock: { type: "text", text: "" } },
  }
  const contentBlockStop = {
    jsonrpc: "2.0",
    method: "notifications/content_block_stop",
    params: { id: 0 },
  }

  if (!response.body) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(mcpSseEvent(initial))
        controller.enqueue(mcpSseEvent(contentBlockStart))
        controller.enqueue(mcpSseEvent(contentBlockDelta("上游未返回内容")))
        controller.enqueue(mcpSseEvent(contentBlockStop))
        controller.close()
      },
    })
  }

  const contentType = response.headers.get("content-type") ?? ""
  const isSse = contentType.includes("text/event-stream")

  // Non-SSE upstream (some providers ignore stream): emit the whole text once.
  if (!isSse) {
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(mcpSseEvent(initial))
        controller.enqueue(mcpSseEvent(contentBlockStart))
        try {
          const data = (await response.json()) as { output?: unknown }
          const text = extractResponseText(data)
          if (text) controller.enqueue(mcpSseEvent(contentBlockDelta(text)))
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          controller.enqueue(mcpSseEvent(contentBlockDelta(`联网搜索失败：${message}`)))
        }
        controller.enqueue(mcpSseEvent(contentBlockStop))
        controller.close()
      },
    })
  }

  // SSE upstream: parse responses delta events and forward text chunks.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(mcpSseEvent(initial))
      controller.enqueue(mcpSseEvent(contentBlockStart))
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
              const delta = extractTextDelta(parsed.delta)
              if (delta) controller.enqueue(mcpSseEvent(contentBlockDelta(delta)))
            } catch {
              // 忽略无法解析的 data 行
            }
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        controller.enqueue(mcpSseEvent(contentBlockDelta(`联网搜索流式传输中断：${message}`)))
      } finally {
        try {
          await reader.cancel()
        } catch {
          // 已关闭
        }
        controller.enqueue(mcpSseEvent(contentBlockStop))
        controller.close()
      }
    },
    cancel(reason) {
      try {
        void reader.cancel(reason)
      } catch {
        // 已关闭
      }
    },
  })
}
