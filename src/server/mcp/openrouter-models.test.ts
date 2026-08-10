import { describe, expect, it, vi } from "vitest"
import { createDatabase, type AppDatabase } from "@/server/db"
import {
  parseOpenRouterModels,
  fetchOpenRouterModalities,
  filterVisionModels,
  modelSupportsImage,
  isVisionModel,
  hasImageInBody,
  rewriteImagesToText,
  MODEL_SLUG_ALIASES,
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
    { id: "moonshotai/kimi-k3", architecture: { input_modalities: ["text", "image"] } },
  ],
}

function makeDb(): AppDatabase {
  const db = createDatabase(":memory:")
  return db
}

describe("parseOpenRouterModels", () => {
  it("解析 input_modalities", () => {
    const infos = parseOpenRouterModels(OR_PAYLOAD)
    expect(infos).toHaveLength(6)
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
      "kimi-k3": ["text", "image"],
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


describe("rewriteImagesToText 完整 URL", () => {
  it("data URI 落盘后生成带 host 的完整签名 URL 引用", async () => {
    const db = createDatabase(":memory:")
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const result = await rewriteImagesToText(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "看看" }, { type: "image_url", image_url: { url: dataUri } }] }],
      },
      db,
      "http://49.233.103.93:13600",
    )
    expect(result.converted).toBe(true)
    const content = (result.body as any).messages[0].content as Array<{ type: string; text: string }>
    const imageText = content.find((p) => p.type === "text" && p.text.includes("图片"))
    expect(imageText).toBeTruthy()
    expect(imageText!.text).toMatch(/^\[图片: http:\/\/49\.233\.103\.93:13600\/mcp\/media\/[0-9a-f]{32}\?exp=\d+&sig=[0-9a-f]{32}\]$/)
    db.close()
  })

  it("http(s) URL 图片不落盘，直接文本化 URL", async () => {
    const db = createDatabase(":memory:")
    const result = await rewriteImagesToText(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      },
      db,
      "http://49.233.103.93:13600",
    )
    const content = (result.body as any).messages[0].content as Array<{ type: string; text: string }>
    expect(content[0].text).toBe("[图片: https://example.com/a.png]")
    db.close()
  })
})


describe("kimi-code 池别名映射（MODEL_SLUG_ALIASES）", () => {
  it("别名常量覆盖四个 kimi-code 池模型 id", () => {
    expect(MODEL_SLUG_ALIASES).toEqual({
      "k3": "kimi-k3",
      "k3-256k": "kimi-k3",
      "kimi-for-coding": "kimi-k3",
      "kimi-for-coding-highspeed": "kimi-k3",
    })
  })

  it("modelSupportsImage 对 kimi-code 池模型经别名映射返回 true", async () => {
    const db = makeDb()
    for (const m of ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]) {
      expect(await modelSupportsImage(m, db, mockFetch(OR_PAYLOAD))).toBe(true)
    }
    db.close()
  })

  it("isVisionModel 对 kimi-code 池模型返回 true", async () => {
    const db = makeDb()
    for (const m of ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]) {
      expect(await isVisionModel(m, db, mockFetch(OR_PAYLOAD))).toBe(true)
    }
    db.close()
  })

  it("filterVisionModels 返回全部 kimi-code 池模型", async () => {
    const db = makeDb()
    const input = ["k3-256k", "k3", "kimi-for-coding", "kimi-for-coding-highspeed"]
    const vision = await filterVisionModels(input, db, mockFetch(OR_PAYLOAD))
    expect(vision.sort()).toEqual(input.slice().sort())
    db.close()
  })
})

describe("hasImageInBody Anthropic messages 图片 block", () => {
  it("messages[].content 数组里的 Anthropic image block 返回 true", () => {
    expect(hasImageInBody({
      model: "k3-256k",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "描述这张图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      }],
    })).toBe(true)
  })

  it("url source 的 Anthropic image block 返回 true", () => {
    expect(hasImageInBody({
      model: "k3-256k",
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
      }],
    })).toBe(true)
  })

  it("纯文本 content 返回 false", () => {
    expect(hasImageInBody({
      model: "k3-256k",
      messages: [{ role: "user", content: "纯文本" }],
    })).toBe(false)
  })
})

describe("rewriteImagesToText Anthropic messages 图片 block", () => {
  it("base64 source 归一化 data URI 落盘为签名 URL 文本 part 且 converted=true", async () => {
    const db = createDatabase(":memory:")
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const result = await rewriteImagesToText(
      {
        model: "k3-256k",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "看看" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        }],
      },
      db,
      "http://49.233.103.93:13600",
    )
    expect(result.converted).toBe(true)
    const content = (result.body as any).messages[0].content as Array<{ type: string; text: string }>
    const imageText = content.find((p) => p.type === "text" && p.text.includes("图片"))
    expect(imageText).toBeTruthy()
    expect(imageText!.text).toMatch(/^\[图片: http:\/\/49\.233\.103\.93:13600\/mcp\/media\/[0-9a-f]{32}\?exp=\d+&sig=[0-9a-f]{32}\]$/)
    db.close()
  })

  it("url source 直接文本化 URL，不需要 db", async () => {
    const db = createDatabase(":memory:")
    const result = await rewriteImagesToText(
      {
        model: "k3-256k",
        messages: [{
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
        }],
      },
      db,
      "http://49.233.103.93:13600",
    )
    expect(result.converted).toBe(true)
    const content = (result.body as any).messages[0].content as Array<{ type: string; text: string }>
    expect(content[0].text).toBe("[图片: https://example.com/a.png]")
    db.close()
  })

  it("source 缺失时 fallback 文本且 converted=true", async () => {
    const db = createDatabase(":memory:")
    const result = await rewriteImagesToText(
      {
        model: "k3-256k",
        messages: [{ role: "user", content: [{ type: "image" }] }],
      },
      db,
    )
    expect(result.converted).toBe(true)
    const content = (result.body as any).messages[0].content as Array<{ type: string; text: string }>
    expect(content[0].text).toBe("[用户上传了一张图片，图片数据未随请求发送]")
    db.close()
  })
})
