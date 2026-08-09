import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import {
  DEFAULT_DESCRIBE_IMAGE_PROMPT,
  ensureDefaultMcpTools,
  getMcpTool,
  listMcpTools,
  updateMcpTool,
  type WebSearchConfig,
  type DescribeImageConfig,
} from "./mcp-tools"

let db: AppDatabase

beforeEach(() => {
  db = createDatabase(":memory:")
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at)
     VALUES ('admin-1', 'admin', 'admin', '管理员', 'ADMIN', 'ACTIVE', 'hash', ?, ?)`,
  ).run(now, now)
})

afterEach(() => {
  db.close()
})

describe("mcp tools", () => {
  it("ensureDefaultMcpTools 初始化 describe_image 默认配置且幂等", () => {
    ensureDefaultMcpTools(db)
    const tool = getMcpTool("describe_image", db)
    expect(tool).not.toBeNull()
    expect(tool!.name).toBe("describe_image")
    expect(tool!.description).toContain("识图工具")
    expect(tool!.enabled).toBe(true)
    expect(tool!.config).toEqual({
      poolType: null,
      model: "",
      prompt: DEFAULT_DESCRIBE_IMAGE_PROMPT,
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEnabled: false,
      reasoningEffort: null,
    })
    expect(DEFAULT_DESCRIBE_IMAGE_PROMPT).toBe("")

    const before = listMcpTools(db).length
    ensureDefaultMcpTools(db)
    expect(listMcpTools(db).length).toBe(before)
  })

  it("ensureDefaultMcpTools 初始化 web_search 默认配置且幂等", () => {
    ensureDefaultMcpTools(db)
    const tool = getMcpTool("web_search", db)
    expect(tool).not.toBeNull()
    expect(tool!.name).toBe("web_search")
    expect(tool!.description).toContain("网页搜索")
    expect(tool!.enabled).toBe(true)
    expect(tool!.config).toEqual({
      provider: null,
      model: "",
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEffort: null,
      maxToolCalls: 3,
    })

    const before = listMcpTools(db).length
    ensureDefaultMcpTools(db)
    expect(listMcpTools(db).length).toBe(before)
  })

  it("web_search 支持配置 provider 并校验字段", () => {
    ensureDefaultMcpTools(db)
    const updated = updateMcpTool(
      "web_search",
      {
        config: {
          provider: "custom:deepseek-official",
          model: "deepseek-v4-flash",
          maxTokens: 2048,
          reasoningEffort: "high",
          maxToolCalls: 5,
        },
      },
      db,
    )
    expect((updated.config as WebSearchConfig).provider).toBe("custom:deepseek-official")
    expect((updated.config as WebSearchConfig).model).toBe("deepseek-v4-flash")
    expect((updated.config as WebSearchConfig).maxTokens).toBe(2048)
    expect((updated.config as WebSearchConfig).reasoningEffort).toBe("high")
    expect((updated.config as WebSearchConfig).maxToolCalls).toBe(5)
    // 未提供的字段保持原值
    expect((updated.config as WebSearchConfig).temperature).toBe(0.3)
  })

  it("web_search 拒绝非法 reasoningEffort / maxToolCalls", () => {
    ensureDefaultMcpTools(db)
    expect(() =>
      updateMcpTool("web_search", { config: { reasoningEffort: "ultra" as "high" } }, db),
    ).toThrow(/reasoningEffort/)
    expect(() =>
      updateMcpTool("web_search", { config: { maxToolCalls: 0 } }, db),
    ).toThrow(/maxToolCalls/)
  })

  it("web_search 拒绝非法 provider", () => {
    ensureDefaultMcpTools(db)
    expect(() =>
      updateMcpTool("web_search", { config: { provider: 123 as unknown as string } }, db),
    ).toThrow(/provider/)
  })

  it("updateMcpTool 合并配置并校验字段", () => {
    ensureDefaultMcpTools(db)
    const updated = updateMcpTool(
      "describe_image",
      {
        description: "新描述",
        enabled: false,
        config: { model: "grok-4", maxTokens: 2048 },
      },
      db,
    )
    expect(updated.description).toBe("新描述")
    expect(updated.enabled).toBe(false)
    expect((updated.config as DescribeImageConfig).model).toBe("grok-4")
    expect((updated.config as DescribeImageConfig).maxTokens).toBe(2048)
    // 未提供的字段保持原值
    expect((updated.config as DescribeImageConfig).prompt).toBe(DEFAULT_DESCRIBE_IMAGE_PROMPT)
    expect((updated.config as DescribeImageConfig).temperature).toBe(0.3)

    // 继续更新会基于上次合并
    const again = updateMcpTool("describe_image", { config: { temperature: 1 } }, db)
    expect((again.config as DescribeImageConfig).model).toBe("grok-4")
    expect((again.config as DescribeImageConfig).temperature).toBe(1)
  })

  it("updateMcpTool 对非法配置抛错", () => {
    ensureDefaultMcpTools(db)
    expect(() => updateMcpTool("describe_image", { config: { maxTokens: 0 } }, db)).toThrow(/1 到 32768/)
    expect(() => updateMcpTool("describe_image", { config: { maxTokens: 40000 } }, db)).toThrow(/1 到 32768/)
    expect(() => updateMcpTool("describe_image", { config: { maxTokens: 12.5 } }, db)).toThrow(/1 到 32768/)
    expect(() => updateMcpTool("describe_image", { config: { temperature: 3 } }, db)).toThrow(/0 到 2/)
    expect(() => updateMcpTool("describe_image", { config: { temperature: -1 } }, db)).toThrow(/0 到 2/)
    expect(() => updateMcpTool("describe_image", { config: { model: 123 as unknown as string } }, db)).toThrow(/字符串/)
    expect(() => updateMcpTool("describe_image", { config: { reasoningEnabled: "yes" as unknown as boolean } }, db)).toThrow(/布尔值/)
    expect(() => updateMcpTool("describe_image", { config: { reasoningEffort: "extreme" as unknown as "low" } }, db)).toThrow(/low、medium、high/)
    expect(() => updateMcpTool("unknown_tool", {}, db)).toThrow(/not found/)
  })
})