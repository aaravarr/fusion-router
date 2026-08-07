import { randomUUID } from "node:crypto"
import type { AppDatabase } from "@/server/db"

export const DEFAULT_DESCRIBE_IMAGE_PROMPT = ""

export interface DescribeImageConfig {
  poolType: string | null
  model: string
  prompt: string
  maxTokens: number
  temperature: number
  reasoningEnabled: boolean
  reasoningEffort: "low" | "medium" | "high" | null
}

export type DeepseekWebSearchReasoningEffort = "none" | "low" | "medium" | "high" | "max"

export interface DeepseekWebSearchConfig {
  /** 明确指定的 Provider（poolType，内置或自定义）；不做按模型自动路由。 */
  provider: string | null
  model: string
  maxTokens: number
  temperature: number
  /** Responses API reasoning.effort；null 表示不传，走模型默认。 */
  reasoningEffort: DeepseekWebSearchReasoningEffort | null
  /** Responses API max_tool_calls，限制本轮服务端工具（含 web_search）调用次数。 */
  maxToolCalls: number
}

export type McpToolConfig = DescribeImageConfig | DeepseekWebSearchConfig

export interface McpToolRecord {
  id: string
  toolType: string
  name: string
  description: string
  enabled: boolean
  config: McpToolConfig
  createdAt: string
  updatedAt: string
}

export interface McpToolDefinition {
  toolType: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  defaultConfig: McpToolConfig
}

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    toolType: "describe_image",
    name: "describe_image",
    description: "识图工具：向多模态大模型询问图片内容并返回描述",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          oneOf: [
            { type: "string", description: "图片地址（https/http URL 或 data:image/...;base64, 数据 URI）" },
            { type: "array", items: { type: "string" }, description: "多张图片地址，一次提问同时分析" },
          ],
          description: "图片地址：单张传字符串，多张传字符串数组（https/http URL 或 data:image/...;base64, 数据 URI）",
        },
        prompt: {
          type: "string",
          description: "可选：本次调用的提问/提示词；不传则由模型直接看图回答",
        },
      },
      required: ["image"],
      additionalProperties: false,
    },
    defaultConfig: {
      poolType: null,
      model: "",
      prompt: DEFAULT_DESCRIBE_IMAGE_PROMPT,
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEnabled: false,
      reasoningEffort: null,
    },
  },
  {
    toolType: "deepseek_web_search",
    name: "deepseek_web_search",
    description: "网页搜索工具：把内容交给配置的 Provider 模型（Responses API + 无版本号 web_search），把搜索结果原样返回",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "要搜索的内容/问题；模型会调用原生 web search 获取结果",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    defaultConfig: {
      provider: null,
      model: "",
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEffort: null,
      maxToolCalls: 3,
    },
  },
]

interface McpToolRow {
  id: string
  tool_type: string
  name: string
  description: string
  enabled: number
  config_json: string
  created_at: string
  updated_at: string
}

function defaultConfigFor(toolType: string): McpToolConfig {
  return (
    MCP_TOOL_DEFINITIONS.find((definition) => definition.toolType === toolType)?.defaultConfig ?? {
      poolType: null,
      model: "",
      prompt: DEFAULT_DESCRIBE_IMAGE_PROMPT,
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEnabled: false,
      reasoningEffort: null,
    }
  )
}

function rowToRecord(row: McpToolRow): McpToolRecord {
  let config: McpToolConfig
  try {
    config = JSON.parse(row.config_json) as DescribeImageConfig
  } catch {
    config = defaultConfigFor(row.tool_type)
  }
  return {
    id: row.id,
    toolType: row.tool_type,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function ensureDefaultMcpTools(db: AppDatabase): void {
  const now = new Date().toISOString()
  const insert = db.prepare(
    `INSERT INTO mcp_tools(id, tool_type, name, description, enabled, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  )
  const find = db.prepare("SELECT id FROM mcp_tools WHERE tool_type = ?")
  for (const definition of MCP_TOOL_DEFINITIONS) {
    if (!find.get(definition.toolType)) {
      insert.run(
        randomUUID(),
        definition.toolType,
        definition.name,
        definition.description,
        JSON.stringify(definition.defaultConfig),
        now,
        now,
      )
    }
  }
}

export function listMcpTools(db: AppDatabase): McpToolRecord[] {
  const rows = db.prepare("SELECT * FROM mcp_tools ORDER BY created_at").all() as unknown as McpToolRow[]
  return rows.map(rowToRecord)
}

export function getMcpTool(toolType: string, db: AppDatabase): McpToolRecord | null {
  const row = db.prepare("SELECT * FROM mcp_tools WHERE tool_type = ?").get(toolType) as unknown as McpToolRow | undefined
  return row ? rowToRecord(row) : null
}

export function updateMcpTool(
  toolType: string,
  input: {
    name?: string
    description?: string
    enabled?: boolean
    config?: Partial<DescribeImageConfig> & Partial<DeepseekWebSearchConfig>
  },
  db: AppDatabase,
): McpToolRecord {
  const existing = getMcpTool(toolType, db)
  if (!existing) throw new Error(`MCP tool not found: ${toolType}`)

  if (input.config) {
    if ("model" in input.config && typeof input.config.model !== "string") {
      throw new Error("model 必须是字符串")
    }
    if ("maxTokens" in input.config) {
      const value = input.config.maxTokens
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 32768) {
        throw new Error("maxTokens 必须是 1 到 32768 之间的整数")
      }
    }
    if ("temperature" in input.config) {
      const value = input.config.temperature
      if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 2) {
        throw new Error("temperature 必须是 0 到 2 之间的数字")
      }
    }
    if (existing.toolType === "deepseek_web_search") {
      // 搜索工具必须明确指定 Provider，不允许自动路由
      if ("provider" in input.config && input.config.provider !== null && typeof input.config.provider !== "string") {
        throw new Error("provider 必须是字符串或 null")
      }
      if ("reasoningEffort" in input.config) {
        const value = input.config.reasoningEffort as DeepseekWebSearchReasoningEffort | null | undefined
        if (
          value !== null &&
          value !== undefined &&
          value !== "none" &&
          value !== "low" &&
          value !== "medium" &&
          value !== "high" &&
          value !== "max"
        ) {
          throw new Error("reasoningEffort 必须是 none、low、medium、high、max 之一或 null")
        }
      }
      if ("maxToolCalls" in input.config) {
        const value = input.config.maxToolCalls
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
          throw new Error("maxToolCalls 必须是 1 到 20 之间的整数")
        }
      }
    } else {
      if ("reasoningEnabled" in input.config && typeof input.config.reasoningEnabled !== "boolean") {
        throw new Error("reasoningEnabled 必须是布尔值")
      }
      if ("reasoningEffort" in input.config) {
        const value = input.config.reasoningEffort
        if (value !== null && value !== "low" && value !== "medium" && value !== "high") {
          throw new Error("reasoningEffort 必须是 low、medium、high 之一或 null")
        }
      }
    }
  }

  const config = { ...existing.config, ...(input.config ?? {}) }
  const enabled = input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE mcp_tools SET name = ?, description = ?, enabled = ?, config_json = ?, updated_at = ?
     WHERE tool_type = ?`,
  ).run(
    input.name ?? existing.name,
    input.description ?? existing.description,
    enabled,
    JSON.stringify(config),
    now,
    toolType,
  )
  const updated = getMcpTool(toolType, db)
  if (!updated) throw new Error(`MCP tool not found: ${toolType}`)
  return updated
}