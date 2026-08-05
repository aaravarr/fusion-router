import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import {
  DEFAULT_DESCRIBE_IMAGE_PROMPT,
  ensureDefaultMcpTools,
  getFirstAdminUserId,
  getMcpTool,
  listMcpTools,
  resolveMcpOwnerUserId,
  updateMcpTool,
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
      ownerUserId: null,
      poolType: null,
      model: "",
      prompt: DEFAULT_DESCRIBE_IMAGE_PROMPT,
      maxTokens: 1024,
      temperature: 0.3,
    })

    const before = listMcpTools(db).length
    ensureDefaultMcpTools(db)
    expect(listMcpTools(db).length).toBe(before)
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
    expect(updated.config.model).toBe("grok-4")
    expect(updated.config.maxTokens).toBe(2048)
    // 未提供的字段保持原值
    expect(updated.config.prompt).toBe(DEFAULT_DESCRIBE_IMAGE_PROMPT)
    expect(updated.config.temperature).toBe(0.3)
    expect(updated.config.ownerUserId).toBeNull()

    // 继续更新会基于上次合并
    const again = updateMcpTool("describe_image", { config: { temperature: 1 } }, db)
    expect(again.config.model).toBe("grok-4")
    expect(again.config.temperature).toBe(1)
  })

  it("updateMcpTool 对非法配置抛错", () => {
    ensureDefaultMcpTools(db)
    expect(() => updateMcpTool("describe_image", { config: { maxTokens: 0 } }, db)).toThrow(/1 到 32768/)
    expect(() => updateMcpTool("describe_image", { config: { maxTokens: 40000 } }, db)).toThrow(/1 到 32768/)
    expect(() => updateMcpTool("describe_image", { config: { maxTokens: 12.5 } }, db)).toThrow(/1 到 32768/)
    expect(() => updateMcpTool("describe_image", { config: { temperature: 3 } }, db)).toThrow(/0 到 2/)
    expect(() => updateMcpTool("describe_image", { config: { temperature: -1 } }, db)).toThrow(/0 到 2/)
    expect(() => updateMcpTool("describe_image", { config: { model: 123 as unknown as string } }, db)).toThrow(/字符串/)
    expect(() => updateMcpTool("unknown_tool", {}, db)).toThrow(/not found/)
  })

  it("getFirstAdminUserId 与 resolveMcpOwnerUserId", () => {
    expect(getFirstAdminUserId(db)).toBe("admin-1")
    const base = { poolType: null, model: "", prompt: "", maxTokens: 1024, temperature: 0.3 }
    expect(resolveMcpOwnerUserId({ ownerUserId: "user-x", ...base }, db)).toBe("user-x")
    expect(resolveMcpOwnerUserId({ ownerUserId: null, ...base }, db)).toBe("admin-1")
  })

  it("getFirstAdminUserId 无管理员时返回 null", () => {
    const empty = createDatabase(":memory:")
    expect(getFirstAdminUserId(empty)).toBeNull()
    empty.close()
  })
})
