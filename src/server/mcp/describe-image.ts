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

export async function describeImage(
  input: { image: string; prompt?: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<DescribeImageResult> {
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
  const imageUrl = normalizeImageInput(input.image)
  const content = promptText
    ? [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: imageUrl } },
      ]
    : [{ type: "image_url", image_url: { url: imageUrl } }]

  const body: {
    model: string
    stream: boolean
    messages: Array<{
      role: string
      content: Array<{ type: string; text?: string; image_url?: { url: string } }>
    }>
    max_tokens: number
    temperature: number
    reasoning_effort?: "low" | "medium" | "high"
  } = {
    model: config.model,
    stream: false,
    messages: [
      {
        role: "user",
        content,
      },
    ],
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  }
  if (config.reasoningEnabled && config.reasoningEffort) {
    body.reasoning_effort = config.reasoningEffort
  }

  const request = new Request("http://internal/mcp/describe_image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const gateway =
    callGateway ??
    (async (req: Request, endpoint: string) =>
      new GatewayService({ get: getGoCredential }, db).handle(req, endpoint, {
        principal: { ownerUserId: ctx.ownerUserId, label: "mcp-describe-image" },
        routing: config.poolType ? { poolType: config.poolType as PoolType } : undefined,
      }))

  const response = await gateway(request, "chat/completions")
  if (!response.ok) {
    let message = `识图请求失败 (${response.status})`
    try {
      const parsed = (await response.json()) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === "string" && parsed.error.message) message = parsed.error.message
    } catch {
      // 保留默认错误信息
    }
    throw new Error(message)
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
  const raw = data.choices?.[0]?.message?.content
  const text = typeof raw === "string" ? raw : ""
  if (!text) throw new Error("模型未返回内容")

  return { text, model: config.model, accountName: null }
}