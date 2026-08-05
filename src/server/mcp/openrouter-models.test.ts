import { describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import {
  parseOpenRouterModels,
  fetchOpenRouterModalities,
  filterVisionModels,
  modelSupportsImage,
  hasImageInBody,
} from "./openrouter-models"

function mockFetch(payload: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch
}

const OR_PAYLOAD = {
  data: [
    { id: "qwen/qwen3.7-plus", architecture: { input_modalities: ["text", "image"] } },
    { id: "minimax/minimax-m3", architecture: { input_modalities: ["text", "image", "video"] } },
    { id: "deepseek/deepseek-v4-flash", architecture: { input_modalities: ["text"] } },
    { id: "qwen/qwen3.7-max", architecture: { input_modalities: ["text"] } },
    { id: "xiaomi/mimo-v2.5", architecture: { input_modalities: ["text", "audio", "image", "video"] } },
  ],
}

function makeDb(): AppDatabase {
  const db = createDatabase(":memory:")
  return db
}

describe("parseOpenRouterModels", () => {
  it("解析 input_modalities", () => {
    const infos = parseOpenRouterModels(OR_PAYLOAD)
    expect(infos).toHaveLength(5)
    expect(infos.find((i) => i.id === "qwen/qwen3.7-plus")?.inputModalities).toEqual(["text", "image"])
  })

  it("非法 payload 返回空数组", () => {
    expect(parseOpenRouterModels(null)).toEqual([])
    expect(parseOpenRouterModels({})).toEqual([])
    expect(parseOpenRouterModels({ data: "x" })).toEqual([])
  })
})

describe("fetchOpenRouterModalities", () => {
  it("拉取并归一化为 slug -> 模态", async () => {
    const map = await fetchOpenRouterModalities(mockFetch(OR_PAYLOAD))
    expect(map).toEqual({
      "qwen3.7-plus": ["text", "image"],
      "minimax-m3": ["text", "image", "video"],
      "deepseek-v4-flash": ["text"],
      "qwen3.7-max": ["text"],
      "mimo-v2.5": ["text", "audio", "image", "video"],
    })
  })

  it("上游失败返回 null", async () => {
    const fetchImpl = vi.fn(async () => new Response("err", { status: 500 })) as unknown as typeof fetch
    expect(await fetchOpenRouterModalities(fetchImpl)).toBeNull()
  })
})

describe("filterVisionModels", () => {
  it("只返回 OpenRouter 确认支持图片的模型", async () => {
    const db = makeDb()
    const vision = await filterVisionModels(
      ["qwen3.7-plus", "deepseek-v4-flash", "qwen3.7-max", "mimo-v2.5", "minimax-m3"],
      db,
      mockFetch(OR_PAYLOAD),
    )
    expect(vision.sort()).toEqual(["minimax-m3", "mimo-v2.5", "qwen3.7-plus"].sort())
    db.close()
  })
})

describe("modelSupportsImage", () => {
  it("支持图片返回 true", async () => {
    const db = makeDb()
    expect(await modelSupportsImage("qwen3.7-plus", db, mockFetch(OR_PAYLOAD))).toBe(true)
    db.close()
  })

  it("明确不支持返回 false", async () => {
    const db = makeDb()
    expect(await modelSupportsImage("deepseek-v4-flash", db, mockFetch(OR_PAYLOAD))).toBe(false)
    db.close()
  })

  it("OpenRouter 无此模型且不在白名单返回 null（未知放行）", async () => {
    const db = makeDb()
    expect(await modelSupportsImage("some-new-model-xyz", db, mockFetch(OR_PAYLOAD))).toBeNull()
    db.close()
  })

  it("OpenRouter 拉取失败时回退白名单", async () => {
    const db = makeDb()
    const failFetch = vi.fn(async () => { throw new Error("network down") }) as unknown as typeof fetch
    expect(await modelSupportsImage("mimo-v2.5", db, failFetch)).toBe(true)
    db.close()
  })
})

describe("hasImageInBody", () => {
  it("chat 格式 image_url", () => {
    expect(hasImageInBody({
      model: "x",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "u" } }] }],
    })).toBe(true)
  })

  it("responses 格式顶层 input_image", () => {
    expect(hasImageInBody({ model: "x", input: [{ type: "input_image", image_url: "u" }] })).toBe(true)
  })

  it("responses 格式 message 内 input_image", () => {
    expect(hasImageInBody({ model: "x", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "u" }] }] })).toBe(true)
  })

  it("纯文本请求返回 false", () => {
    expect(hasImageInBody({ model: "x", messages: [{ role: "user", content: "hi" }] })).toBe(false)
    expect(hasImageInBody({ model: "x", input: [{ role: "user", content: "hi" }] })).toBe(false)
  })

  it("无图片时返回 false", () => {
    expect(hasImageInBody(null)).toBe(false)
    expect(hasImageInBody({})).toBe(false)
    expect(hasImageInBody("str")).toBe(false)
  })
})
