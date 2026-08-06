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

export interface McpStreamOptions {
  /** 客户端通过 params._meta.progressToken 请求的进度通知 token。 */
  progressToken?: string | number
}

/**
 * Streams describe_image through MCP Streamable HTTP（标准实现）：
 * - 可选发送 notifications/progress 进度通知（客户端请求 progressToken 时）；
 * - 最后发送一条带完整 result.content 的 JSON-RPC response 后关闭流。
 * 上游（chat-completions）请求在流内执行，客户端能立即收到响应头。
 */
export async function describeImageStream(
  input: { images: string[]; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  id: unknown,
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
  options?: McpStreamOptions,
): Promise<ReadableStream<Uint8Array>> {
  const { config, ownerUserId, body } = buildDescribeRequestBody(input, db, ctx, true)

  const request = new Request("http://internal/mcp/describe_image", {
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
        const response = await gateway(request, "chat/completions")
        if (!response.ok) {
          const message = await extractUpstreamErrorMessage(response, `识图请求失败 (${response.status})`)
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
          const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
          const raw = data.choices?.[0]?.message?.content
          text = typeof raw === "string" ? raw : ""
        } else {
          // SSE upstream: accumulate the full text from chat-completions delta events.
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
                  const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> }
                  const delta = parsed.choices?.[0]?.delta?.content
                  if (typeof delta === "string" && delta) text += delta
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
        emit(toolResult(id, `识图失败：${message}`, true))
      } finally {
        controller.close()
      }
    },
    cancel() {
      // 客户端断开：不再推送。
    },
  })
}
