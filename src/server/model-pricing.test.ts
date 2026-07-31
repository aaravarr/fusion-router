import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetModelPricingCacheForTests,
  estimateUsageCost,
  findModelPrice,
  formatUsd,
  refreshModelPricing,
} from "./model-pricing"
import { createDatabase } from "./db"

function stubPricingFetch(openRouterModels: unknown, modelsDev: unknown, failModelsDev = false) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("models.dev")) {
      if (failModelsDev) throw new Error("models.dev unavailable")
      return Response.json(modelsDev)
    }
    return Response.json(openRouterModels)
  }))
}

describe("model-pricing", () => {
  afterEach(() => {
    __resetModelPricingCacheForTests()
    vi.unstubAllGlobals()
  })

  it("indexes openrouter models and estimates cost", async () => {
    const db = createDatabase(":memory:")
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        data: [
          {
            id: "x-ai/grok-4.5",
            name: "Grok 4.5",
            pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
          },
          {
            id: "openai/gpt-5.3-codex",
            name: "GPT-5.3 Codex",
            pricing: { prompt: "0.000001", completion: "0.000004" },
          },
        ],
      }),
    ))
    const status = await refreshModelPricing(db)
    expect(status.modelCount).toBe(2)
    expect(findModelPrice("grok-4.5", db)?.id).toBe("x-ai/grok-4.5")
    const cost = estimateUsageCost({
      model: "grok-4.5",
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 200,
    }, db)
    // uncached 800 * 0.000003 + cached 200 * 0.0000003 + 500 * 0.000015
    expect(cost.costUsd).toBeCloseTo(800 * 0.000003 + 200 * 0.0000003 + 500 * 0.000015, 10)
    expect(cost.breakdown).toEqual({
      uncachedPromptTokens: 800,
      cachedTokens: 200,
      completionTokens: 500,
      promptRate: 0.000003,
      cacheRate: 0.0000003,
      completionRate: 0.000015,
    })
    expect(formatUsd(cost.costUsd)).toMatch(/^\$/)
  })

  it("returns null cost when model unmatched", async () => {
    const db = createDatabase(":memory:")
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ data: [{ id: "openai/gpt-4o", name: "GPT-4o", pricing: { prompt: "0.00001", completion: "0.00003" } }] }),
    ))
    await refreshModelPricing(db)
    const cost = estimateUsageCost({ model: "totally-unknown-model-xyz", promptTokens: 10, completionTokens: 10 }, db)
    expect(cost.costUsd).toBeNull()
    expect(cost.breakdown).toBeNull()
  })

  it("applies models.dev official cache price over openrouter", async () => {
    const db = createDatabase(":memory:")
    stubPricingFetch(
      { data: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", pricing: { prompt: "0.00000014", completion: "0.00000028", input_cache_read: "0.000000028" } }] },
      { deepseek: { id: "deepseek", name: "DeepSeek", models: { "deepseek-v4-flash": { cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } } } } },
    )
    await refreshModelPricing(db)
    expect(findModelPrice("deepseek-v4-flash", db)?.cacheRead).toBeCloseTo(2.8e-9, 12)
    expect(findModelPrice("deepseek/deepseek-v4-flash", db)?.prompt).toBeCloseTo(1.4e-7, 12)
  })

  it("keeps openrouter pricing when models.dev unavailable", async () => {
    const db = createDatabase(":memory:")
    stubPricingFetch(
      { data: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", pricing: { prompt: "0.00000014", completion: "0.00000028", input_cache_read: "0.000000028" } }] },
      {},
      true,
    )
    await refreshModelPricing(db)
    expect(findModelPrice("deepseek-v4-flash", db)?.cacheRead).toBeCloseTo(2.8e-8, 12)
  })

  it("indexes models.dev entries not present on openrouter", async () => {
    const db = createDatabase(":memory:")
    stubPricingFetch(
      { data: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", pricing: { prompt: "0.000000435", completion: "0.00000087" } }] },
      {
        deepseek: {
          id: "deepseek",
          name: "DeepSeek",
          models: {
            "deepseek-v4-flash": {
              name: "DeepSeek V4 Flash",
              cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
            },
          },
        },
      },
    )
    await refreshModelPricing(db)
    expect(findModelPrice("deepseek-v4-flash", db)?.cacheRead).toBeCloseTo(2.8e-9, 12)
  })

  it("keeps models.dev catalog when openrouter unavailable", async () => {
    const db = createDatabase(":memory:")
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("models.dev")) {
        return Response.json({
          deepseek: {
            id: "deepseek",
            name: "DeepSeek",
            models: {
              "deepseek-v4-flash": {
                name: "DeepSeek V4 Flash",
                cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
              },
            },
          },
        })
      }
      throw new Error("openrouter unavailable")
    }))
    await refreshModelPricing(db)
    expect(findModelPrice("deepseek-v4-flash", db)?.cacheRead).toBeCloseTo(2.8e-9, 12)
  })
})
