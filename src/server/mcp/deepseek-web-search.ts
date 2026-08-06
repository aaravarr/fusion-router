import type { AppDatabase } from "@/server/db"
import { tryGetProvider, type PoolType } from "@/server/providers"
import { AccountRepository } from "@/server/repository"
import type { AccountRecord } from "@/server/types"
import { ensureDefaultMcpTools, getMcpTool, type DeepseekWebSearchConfig } from "./mcp-tools"

/**
 * 原生 web search 工具，格式与 DeepSeek Anthropic-compatible messages API
 * 实测可用的一致（2026-08-07 实测：OpenAI 兼容端点不支持该工具类型，仅
 * Anthropic messages 端点支持）。
 */
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 }

/** Anthropic messages 端点的鉴权/版本头。 */
const ANTHROPIC_VERSION = "2023-06-01"
const REQUEST_TIMEOUT_MS = 120_000

export interface DeepseekWebSearchResult {
  text: string
  model: string
  accountName: string | null
}

interface SearchResultEntry {
  title: string
  url: string
}

function pickReadyAccount(ownerUserId: string, poolType: string, db: AppDatabase): AccountRecord | null {
  const accounts = new AccountRepository(ownerUserId, db).list()
  return (
    accounts.find(
      (account) =>
        account.poolType === poolType &&
        account.adminState === "ENABLED" &&
        account.authState === "VALID",
    ) ?? null
  )
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
 * 解析 Anthropic messages 响应，提取模型最终文本与搜索结果条目。
 * content 块类型（实测）：thinking / server_tool_use / web_search_tool_result
 * （内含 web_search_result：title + url + encrypted_content，正文加密不可读）。
 */
function parseSearchResponse(data: unknown): { answer: string; results: SearchResultEntry[] } {
  const record = data && typeof data === "object" ? (data as { content?: unknown }) : {}
  if (!Array.isArray(record.content)) return { answer: "", results: [] }

  let answer = ""
  const results: SearchResultEntry[] = []
  for (const block of record.content) {
    if (!block || typeof block !== "object") continue
    const item = block as { type?: unknown; text?: unknown; content?: unknown }
    if (item.type === "text" && typeof item.text === "string") {
      answer = answer ? `${answer}\n\n${item.text}` : item.text
      continue
    }
    if (item.type === "web_search_tool_result" && Array.isArray(item.content)) {
      for (const entry of item.content) {
        if (!entry || typeof entry !== "object") continue
        const result = entry as { type?: unknown; title?: unknown; url?: unknown }
        if (result.type === "web_search_result") {
          results.push({
            title: typeof result.title === "string" ? result.title : "",
            url: typeof result.url === "string" ? result.url : "",
          })
        }
      }
    }
  }
  return { answer, results }
}

/** 模型答案 + 搜索来源列表，原样返回（不加工内容）。 */
function formatResult(parsed: { answer: string; results: SearchResultEntry[] }): string {
  const lines: string[] = []
  if (parsed.answer) lines.push(parsed.answer)
  if (parsed.results.length) {
    lines.push("", "搜索结果来源：")
    parsed.results.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.title}${entry.url ? ` — ${entry.url}` : ""}`)
    })
  }
  return lines.join("\n")
}

/**
 * 调用配置的 Provider 的原生 web search（Anthropic messages 端点，
 * `${baseUrl}/anthropic/v1/messages`，x-api-key 鉴权）并把搜索结果原样返回。
 *
 * Provider 必须由用户明确指定（不按模型自动路由——同一模型在不同 Provider
 * 支持的能力可能不同），选哪些 Provider/模型不做限制，由用户配置后自行测试。
 */
export async function deepseekWebSearch(
  input: { content: string },
  db: AppDatabase,
  ctx: { ownerUserId: string },
  callGateway?: (request: Request, endpoint: string) => Promise<Response>,
): Promise<DeepseekWebSearchResult> {
  if (!ctx.ownerUserId) throw new Error("未指定调用用户")

  const content = input.content.trim()
  if (!content) throw new Error("请提供要搜索的内容")

  let tool = getMcpTool("deepseek_web_search", db)
  if (!tool) {
    ensureDefaultMcpTools(db)
    tool = getMcpTool("deepseek_web_search", db)
  }
  if (!tool) throw new Error("网页搜索工具未初始化")

  const config = tool.config as DeepseekWebSearchConfig
  if (!config.provider) {
    throw new Error("尚未配置 Provider：请先在管理后台 MCP 页面选择 Provider（同一模型在不同 Provider 支持的能力可能不同，需明确指定）")
  }
  if (!config.model) throw new Error("尚未配置模型：请先在管理后台 MCP 页面填写模型名")

  const provider = tryGetProvider(config.provider as PoolType)
  if (!provider) throw new Error(`Provider 不存在: ${config.provider}`)
  const account = pickReadyAccount(ctx.ownerUserId, config.provider, db)
  if (!account) throw new Error(`Provider ${config.provider} 没有可用账号，请先在管理后台添加 API Key 并启用`)

  const credential = await provider.getCredential(account)
  const baseUrl = provider.getUpstreamBaseUrl(account).replace(/\/+$/, "")
  const endpoint = `${baseUrl}/anthropic/v1/messages`
  const headers = {
    "content-type": "application/json",
    "x-api-key": credential.token,
    "anthropic-version": ANTHROPIC_VERSION,
    accept: "application/json",
  }
  const body = JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: [{ role: "user", content: [{ type: "text", text: content }] }],
    tools: [WEB_SEARCH_TOOL],
  })

  let response: Response
  if (callGateway) {
    response = await callGateway(new Request(endpoint, { method: "POST", headers, body }), endpoint)
  } else {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }
  if (!response.ok) {
    throw new Error(await extractUpstreamErrorMessage(response, `网页搜索请求失败 (${response.status})`))
  }

  const data = await response.json().catch(() => null)
  const parsed = parseSearchResponse(data)
  const text = formatResult(parsed)
  if (!text) throw new Error("模型未返回内容")

  return { text, model: config.model, accountName: account.name ?? null }
}
