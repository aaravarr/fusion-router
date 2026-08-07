import type { AppDatabase } from "@/server/db"
import { tryGetProvider, type PoolType } from "@/server/providers"
import { AccountRepository } from "@/server/repository"
import type { AccountRecord } from "@/server/types"
import { ensureDefaultMcpTools, getMcpTool, type DeepseekWebSearchConfig } from "./mcp-tools"

/**
 * Responses API 无版本号 web_search（服务端执行）。
 * DeepSeek / OpenAI / 多数兼容实现都认这个形态，比 Anthropic 的
 * web_search_20260209 兼容面更广。
 */
const WEB_SEARCH_TOOL = { type: "web_search" }

/**
 * 实测（DeepSeek /responses）：强制 tool_choice={type:"web_search"} 或 "required"
 * 时，模型往往只产出 web_search_call、不生成最终 message，导致空内容。
 * 用 instructions 引导检索，让模型自行决定何时结束并作答。
 */
const SEARCH_INSTRUCTIONS =
  "使用 web_search 检索最新公开信息，并基于检索结果给出完整、可核对的中文回答。"

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
    // keep fallback
  }
  return fallback
}

function pushResult(results: SearchResultEntry[], title: unknown, url: unknown) {
  const nextUrl = typeof url === "string" ? url.trim() : ""
  const nextTitle = typeof title === "string" ? title.trim() : ""
  if (!nextUrl && !nextTitle) return
  if (results.some((item) => item.url === nextUrl && item.title === nextTitle)) return
  results.push({ title: nextTitle || nextUrl, url: nextUrl })
}

/** DeepSeek open_page URL 常带 #ws_call_id=... 跟踪碎片，展示前去掉。 */
export function cleanSearchUrl(url: string): string {
  return url.replace(/#ws_call_id=.*$/i, "").trim()
}

/**
 * 解析 Responses API 响应：从 output 里取 message.output_text 与来源。
 * DeepSeek 会在检索过程中多次产出短 message（进度话术），最终答案在最后一条；
 * 来源优先取 output_text.annotations(url_citation)，其次 web_search_call.action
 * （含 open_page.url / sources / results）。
 */
export function parseResponsesSearchResult(data: unknown): { answer: string; results: SearchResultEntry[] } {
  const record = data && typeof data === "object" ? (data as { output?: unknown; output_text?: unknown }) : {}
  const topLevelAnswer = typeof record.output_text === "string" ? record.output_text : ""
  const results: SearchResultEntry[] = []
  const messageAnswers: string[] = []

  if (!Array.isArray(record.output)) return { answer: topLevelAnswer, results }

  for (const item of record.output) {
    if (!item || typeof item !== "object") continue
    const row = item as {
      type?: unknown
      content?: unknown
      action?: unknown
    }
    const type = String(row.type || "").toLowerCase()

    if (type === "message" && Array.isArray(row.content)) {
      const parts: string[] = []
      for (const part of row.content) {
        if (!part || typeof part !== "object") continue
        const block = part as {
          type?: unknown
          text?: unknown
          annotations?: unknown
        }
        const partType = String(block.type || "").toLowerCase()
        if ((partType === "output_text" || partType === "text") && typeof block.text === "string") {
          const text = block.text.trim()
          if (text) parts.push(block.text)
        }
        if (Array.isArray(block.annotations)) {
          for (const ann of block.annotations) {
            if (!ann || typeof ann !== "object") continue
            const a = ann as { type?: unknown; title?: unknown; url?: unknown }
            const annType = String(a.type || "").toLowerCase()
            if (annType === "url_citation" || annType === "citation" || a.url != null) {
              const url = typeof a.url === "string" ? cleanSearchUrl(a.url) : a.url
              pushResult(results, a.title, url)
            }
          }
        }
      }
      if (parts.length) messageAnswers.push(parts.join("\n\n"))
      continue
    }

    if (type === "web_search_call") {
      const action =
        row.action && typeof row.action === "object"
          ? (row.action as {
              type?: unknown
              query?: unknown
              url?: unknown
              title?: unknown
              sources?: unknown
              results?: unknown
            })
          : null
      if (action) {
        if (Array.isArray(action.sources)) {
          for (const source of action.sources) {
            if (!source || typeof source !== "object") continue
            const s = source as { title?: unknown; url?: unknown }
            const url = typeof s.url === "string" ? cleanSearchUrl(s.url) : s.url
            pushResult(results, s.title, url)
          }
        }
        if (Array.isArray(action.results)) {
          for (const entry of action.results) {
            if (!entry || typeof entry !== "object") continue
            const s = entry as { title?: unknown; url?: unknown }
            const url = typeof s.url === "string" ? cleanSearchUrl(s.url) : s.url
            pushResult(results, s.title, url)
          }
        }
        if (typeof action.url === "string" && action.url.trim()) {
          const url = cleanSearchUrl(action.url)
          pushResult(results, action.title, url)
        }
      }
    }
  }

  // 多轮 message 时取最后一条（最终汇总）；没有 message 时退回顶层 output_text。
  const answer = messageAnswers.length > 0 ? messageAnswers[messageAnswers.length - 1]! : topLevelAnswer
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
 * 调用配置 Provider 的 Responses API 原生 web_search（`${baseUrl}/responses`，
 * Bearer 鉴权），并把最终文本 + 来源原样返回。
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
  const endpoint = `${baseUrl}/responses`
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${credential.token}`,
    accept: "application/json",
  }
  const maxToolCalls =
    typeof config.maxToolCalls === "number" && Number.isInteger(config.maxToolCalls) && config.maxToolCalls > 0
      ? Math.min(20, config.maxToolCalls)
      : 3
  const requestBody: Record<string, unknown> = {
    model: config.model,
    max_output_tokens: config.maxTokens,
    temperature: config.temperature,
    instructions: SEARCH_INSTRUCTIONS,
    input: content,
    tools: [WEB_SEARCH_TOOL],
    max_tool_calls: maxToolCalls,
  }
  if (config.reasoningEffort) {
    requestBody.reasoning = { effort: config.reasoningEffort }
  }
  const body = JSON.stringify(requestBody)

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
  const parsed = parseResponsesSearchResult(data)
  const text = formatResult(parsed)
  if (!text) throw new Error("模型未返回内容")

  return { text, model: config.model, accountName: account.name ?? null }
}
