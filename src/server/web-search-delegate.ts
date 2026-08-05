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
} from "@/server/mcp/mcp-tools"

export interface DelegateSearchResult {
  /** 实际搜索词（取上游返回的 web_search_call 查询词，找不到时回退输入 query） */
  query: string
  /** 搜索模型给出的总结文本（message 文本） */
  text: string
  /** 实际使用的模型名 */
  model: string
}

/** 从 responses 请求的 input 里提取最后一条 user 文本作为搜索词。 */
export function extractSearchQueryFromResponsesBody(body: unknown): string {
  if (!body || typeof body !== "object") return ""
  const input = (body as { input?: unknown }).input
  const candidates: string[] = []
  const pushText = (part: unknown): void => {
    if (!part || typeof part !== "object") return
    const record = part as { type?: unknown; text?: unknown; content?: unknown; role?: unknown }
    if (typeof record.text === "string" && record.text.trim()) candidates.push(record.text.trim())
    if (Array.isArray(record.content)) {
      for (const c of record.content) {
        if (c && typeof c === "object") {
          const ct = (c as { text?: unknown }).text
          if (typeof ct === "string" && ct.trim()) candidates.push(ct.trim())
        }
      }
    }
  }
  if (typeof input === "string") {
    if (input.trim()) candidates.push(input.trim())
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue
      const record = item as { role?: unknown; type?: unknown }
      const role = String(record.role ?? "").toLowerCase()
      if (role !== "user" && role !== "assistant") continue
      // responses item: {type:"message", role, content:[...]} 或 chat 式 {role, content:[...]} 或 {type:"input_text", text}
      if (Array.isArray((item as { content?: unknown }).content)) pushText(item)
      else if (typeof (item as { text?: unknown }).text === "string") pushText(item)
    }
  }
  return candidates[candidates.length - 1] ?? ""
}

/** 从上游 responses JSON 提取 message 文本与 web_search_call 查询词。 */
function extractSearchOutput(data: unknown): { text: string; query: string } {
  let text = ""
  let query = ""
  if (!data || typeof data !== "object" || !Array.isArray((data as { output?: unknown }).output)) {
    return { text, query }
  }
  for (const item of (data as { output: unknown[] }).output) {
    if (!item || typeof item !== "object") continue
    const record = item as { type?: unknown; content?: unknown; action?: unknown }
    const type = String(record.type ?? "")
    if (type === "message" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object") continue
        const t = (part as { text?: unknown }).text
        if (typeof t === "string" && t) text += t
      }
    }
    if (type === "web_search_call" && !query) {
      const action = record.action
      if (action && typeof action === "object") {
        const a = action as { query?: unknown; queries?: unknown; type?: unknown }
        if (a.type === "search") {
          const q = a.query
          if (typeof q === "string" && q.trim()) query = q.trim()
          if (!query && Array.isArray(a.queries)) {
            for (const qq of a.queries) {
              if (typeof qq === "string" && qq.trim() && !qq.includes("ws_call_id=")) {
                query = qq.trim()
                break
              }
            }
          }
        }
      }
    }
  }
  return { text, query }
}

/**
 * 使用配置的 Provider+模型执行一次联网搜索（上游 responses API + web_search 内置工具），
 * 返回搜索模型的总结文本。供两类场景复用：
 * - MCP web_search 工具（直接返回给调用方）
 * - 网关搜索委托：主模型 Provider（如 opencode-go）不支持 web_search 时，
 *   自动用本函数（DeepSeek 官方池）完成搜索步骤。
 */
export async function delegateWebSearch(
  input: {
    query: string
    prompt?: string
    ownerUserId: string
    db: AppDatabase
    /** 未配置搜索模型时的兜底模型名（通常取主请求的 model） */
    fallbackModel?: string
  },
): Promise<DelegateSearchResult> {
  const { query, ownerUserId, db, fallbackModel } = input
  if (!ownerUserId) throw new Error("未指定调用用户")
  if (!query.trim()) throw new Error("缺少搜索词")

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
  const model = config.model || fallbackModel || ""
  if (!model) throw new Error("尚未配置搜索模型，请先在管理后台 MCP 页面选择模型")

  const promptText = (input.prompt ?? config.prompt ?? DEFAULT_WEB_SEARCH_PROMPT).trim()
  const text = [promptText, query].filter(Boolean).join("\n\n")
  const body = {
    model,
    stream: false,
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
    tools: [{ type: "web_search" }],
    max_output_tokens: config.maxTokens,
    temperature: config.temperature,
    reasoning: { effort: "none" as const },
  }

  const request = new Request("http://internal/gateway/web-search-delegate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const gateway = new GatewayService({ get: getGoCredential }, db)
  const response = await gateway.handle(request, "responses", {
    principal: { ownerUserId, label: "gateway-web-search-delegate" },
    routing: config.poolType ? { poolType: config.poolType as PoolType } : undefined,
  })
  if (!response.ok) {
    let message = `搜索委托请求失败 (${response.status})`
    try {
      const parsed = (await response.json()) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === "string" && parsed.error.message) message = parsed.error.message
    } catch {
      // 保留默认错误信息
    }
    throw new Error(message)
  }

  const data = (await response.json()) as { output?: unknown }
  const { text: searchText, query: actualQuery } = extractSearchOutput(data)
  if (!searchText) throw new Error("搜索模型未返回内容")
  return { query: actualQuery || query, text: searchText, model }
}
