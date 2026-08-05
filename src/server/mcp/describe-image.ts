import type { AppDatabase } from "@/server/db"
import { GatewayService } from "@/server/gateway"
import { getGoCredential } from "@/server/opencode-web/service"
import type { PoolType } from "@/server/types"
import {
  ensureDefaultMcpTools,
  getMcpTool,
  MCP_TOOL_DEFINITIONS,
  type DescribeImageConfig,
} from "./mcp-tools"

export function normalizeImageInput(image: string): string {
  const value = image.trim()
  if (!/^https?:\/\//i.test(value) && !/^data:image\//i.test(value)) {
    throw new Error("图片必须是 http(s) 地址或 data:image 数据 URI")
  }
  return value
}

export interface DescribeImageResult {
  text: string
  model: string
  accountName: string | null
}

interface DescribeRequestBody {
  config: DescribeImageConfig
  ownerUserId: string
  body: {
    model: string
    stream: boolean
    messages: Array<{
      role: string
      content: Array<{ type: string; text?: string; image_url?: { url: string } }>
    }>
    max_tokens: number
    temperature: number
    reasoning_effort?: "none" | "low" | "medium" | "high"
    thinking?: { type: string }
  }
}

/**
 * 思考参数按模型适配：
 * - MiniMax（M3 等）用 `thinking: { type }`，且只接受 "adaptive" / "disabled"，
 *   不支持 OpenAI 的 reasoning_effort（实测传 low/medium/high 无效）。
 * - 其它 OpenAI 兼容模型用 `reasoning_effort`，"none" 可显式关闭思考。
 */
function applyReasoningParams(
  body: DescribeRequestBody["body"],
  config: DescribeImageConfig,
): void {
  const model = config.model ?? ""
  const isMinimax = /minimax/i.test(model)
  if (!config.reasoningEnabled) {
    // 显式关闭思考：有些模型（如 minimax-m3）默认输出 <think>，必须显式关闭。
    if (isMinimax) body.thinking = { type: "disabled" }
    else body.reasoning_effort = "none"
    return
  }
  if (isMinimax) {
    // M3 没有思考等级，adaptive 即"自动判断是否需要思考"（等价开启）。
    body.thinking = { type: "adaptive" }
    return
  }
  if (config.reasoningEffort) {
    body.reasoning_effort = config.reasoningEffort
  }
  // reasoningEnabled=true 但未指定等级：不传，让模型用默认思考强度。
}

function buildDescribeRequestBody(
  input: { images: string[]; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  stream: boolean,
): DescribeRequestBody {
  if (!ctx.ownerUserId) throw new Error("未指定调用用户")

  let tool = getMcpTool("describe_image", db)
  if (!tool) {
    ensureDefaultMcpTools(db)
    tool = getMcpTool("describe_image", db)
  }
  if (!tool) throw new Error("识图工具未初始化")

  const definition = MCP_TOOL_DEFINITIONS.find((item) => item.toolType === "describe_image")
  const defaultConfig: DescribeImageConfig =
    definition?.defaultConfig ?? {
      poolType: null,
      model: "",
      prompt: "",
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEnabled: false,
      reasoningEffort: null,
    }
  const config: DescribeImageConfig = { ...defaultConfig, ...tool.config }
  if (!config.model) throw new Error("尚未配置识图模型，请先在管理后台 MCP 页面选择模型")

  const promptText = (input.prompt ?? config.prompt ?? "").trim()
  if (!input.images.length) throw new Error("请至少提供一张图片")
  const imageParts = input.images.map((image) => ({
    type: "image_url",
    image_url: { url: normalizeImageInput(image) },
  }))
  const content = promptText
    ? [{ type: "text", text: promptText }, ...imageParts]
    : imageParts

  const body: DescribeRequestBody["body"] = {
    model: config.model,
    stream,
    messages: [
      {
        role: "user",
        content,
      },
    ],
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  }
  applyReasoningParams(body, config)

  return { config, ownerUserId: ctx.ownerUserId, body }
}

function defaultGateway(db: AppDatabase, ownerUserId: string, config: DescribeImageConfig) {
  return (req: Request, endpoint: string) =>
    new GatewayService({ get: getGoCredential }, db).handle(req, endpoint, {
      principal: { ownerUserId, label: "mcp-describe-image" },
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

export async function describeImage(
  input: { images: string[]; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<DescribeImageResult> {
  const { config, ownerUserId, body } = buildDescribeRequestBody(input, db, ctx, false)

  const request = new Request("http://internal/mcp/describe_image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const gateway = callGateway ?? defaultGateway(db, ownerUserId, config)
  const response = await gateway(request, "chat/completions")
  if (!response.ok) {
    throw new Error(await extractUpstreamErrorMessage(response, `识图请求失败 (${response.status})`))
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
  const raw = data.choices?.[0]?.message?.content
  const text = typeof raw === "string" ? raw : ""
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
 * Streams describe_image through MCP streamable HTTP: an initial empty result
 * followed by content_block_start / content_block_delta / content_block_stop
 * notifications, fed from the upstream chat-completions SSE stream.
 */
export async function describeImageStream(
  input: { images: string[]; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  id: unknown,
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<ReadableStream<Uint8Array>> {
  const { config, ownerUserId, body } = buildDescribeRequestBody(input, db, ctx, true)

  const request = new Request("http://internal/mcp/describe_image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const gateway = callGateway ?? defaultGateway(db, ownerUserId, config)
  const response = await gateway(request, "chat/completions")
  if (!response.ok) {
    throw new Error(await extractUpstreamErrorMessage(response, `识图请求失败 (${response.status})`))
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
          const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
          const raw = data.choices?.[0]?.message?.content
          const text = typeof raw === "string" ? raw : ""
          if (text) controller.enqueue(mcpSseEvent(contentBlockDelta(text)))
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          controller.enqueue(mcpSseEvent(contentBlockDelta(`识图失败：${message}`)))
        }
        controller.enqueue(mcpSseEvent(contentBlockStop))
        controller.close()
      },
    })
  }

  // SSE upstream: parse chat-completions delta events and forward each chunk.
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
              const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> }
              const delta = parsed.choices?.[0]?.delta?.content
              if (typeof delta === "string" && delta) {
                controller.enqueue(mcpSseEvent(contentBlockDelta(delta)))
              }
            } catch {
              // 忽略无法解析的 data 行
            }
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        controller.enqueue(mcpSseEvent(contentBlockDelta(`识图流式传输中断：${message}`)))
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