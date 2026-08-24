import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetModelPricingCacheForTests, refreshModelPricing } from "./model-pricing"
import { createDatabase } from "./db"
import { addRow, createBucket, finalizeBucketCost, finalizeSummary, type UsageBucketRow } from "./usage-stats"

function makeRow(overrides: Partial<UsageBucketRow>): UsageBucketRow {
  return {
    started_at: "2026-01-01T00:00:00.000Z",
    status: 200,
    ok: 1,
    latency_ms: 100,
    local_prep_ms: 10,
    first_token_ms: 50,
    model: null,
    account_id: null,
    account_name: null,
    api_key_id: null,
    api_key_prefix: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    cached_tokens: null,
    reasoning_tokens: null,
    stream: 0,
    ...overrides,
  }
}

describe("usage-stats", () => {
  afterEach(() => {
    __resetModelPricingCacheForTests()
    vi.unstubAllGlobals()
  })

  it("聚合多个同模型请求后按总 token 定价", async () => {
    const db = createDatabase(":memory:")
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        data: [
          { id: "openai/gpt-4o", name: "GPT-4o", pricing: { prompt: "0.00001", completion: "0.00003" } },
        ],
      }),
    ))
    await refreshModelPricing(db)

    const bucket = createBucket("test", "测试")
    for (const [promptTokens, completionTokens] of [[1000, 100], [2000, 200], [3000, 300]]) {
      addRow(bucket, makeRow({
        model: "openai/gpt-4o",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      }))
    }
    finalizeBucketCost(bucket, db)

    expect(bucket.costUsd).toBeCloseTo(6000 * 0.00001 + 600 * 0.00003, 10)
    expect("modelTokens" in bucket).toBe(false)
  })

  it("不同模型分别定价", async () => {
    const db = createDatabase(":memory:")
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        data: [
          { id: "openai/gpt-4o", name: "GPT-4o", pricing: { prompt: "0.00001", completion: "0.00003" } },
          {
            id: "anthropic/claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
            pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
          },
        ],
      }),
    ))
    await refreshModelPricing(db)

    const bucket = createBucket("test", "测试")
    addRow(bucket, makeRow({
      model: "openai/gpt-4o",
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 300,
      total_tokens: 1200,
    }))
    addRow(bucket, makeRow({
      model: "anthropic/claude-sonnet-4.5",
      prompt_tokens: 2000,
      completion_tokens: 400,
      cached_tokens: 500,
      total_tokens: 2400,
    }))
    finalizeBucketCost(bucket, db)

    const gpt4oCost = 700 * 0.00001 + 300 * 0.00001 + 200 * 0.00003
    const claudeCost = 1500 * 0.000003 + 500 * 0.0000003 + 400 * 0.000015
    expect(bucket.costUsd).toBeCloseTo(gpt4oCost + claudeCost, 10)
  })

  it("无定价模型不计入", async () => {
    const db = createDatabase(":memory:")
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        data: [
          { id: "openai/gpt-4o", name: "GPT-4o", pricing: { prompt: "0.00001", completion: "0.00003" } },
        ],
      }),
    ))
    await refreshModelPricing(db)

    const bucket = createBucket("test", "测试")
    addRow(bucket, makeRow({
      model: "openai/gpt-4o",
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    }))
    addRow(bucket, makeRow({
      model: "totally-unknown-model-xyz",
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    }))
    finalizeBucketCost(bucket, db)

    expect(bucket.costUsd).toBeCloseTo(1000 * 0.00001 + 100 * 0.00003, 10)

    const unknownOnly = createBucket("unknown", "未知")
    addRow(unknownOnly, makeRow({
      model: "totally-unknown-model-xyz",
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    }))
    finalizeBucketCost(unknownOnly, db)

    expect(unknownOnly.costUsd).toBe(0)
  })

  it("reasoning 流末尾 burst（TPS 窗口<200ms）不采样，avgTps 记 null", () => {
    const bucket = createBucket("t", "测试")
    // 病例复刻：总延迟 25905ms、首 token 25784ms（思考期），生成窗口仅 ~111ms
    addRow(bucket, makeRow({
      latency_ms: 25905,
      local_prep_ms: 10,
      first_token_ms: 25784,
      completion_tokens: 1900,
      reasoning_tokens: 5000,
      stream: 1,
    }))
    expect(bucket.tpsSampleCount).toBe(0)
    expect(finalizeSummary(bucket, 1).avgTps).toBeNull()
  })

  it("正常流 TPS：分子只用 completion_tokens，窗口 = 首 chunk → 完成", () => {
    const bucket = createBucket("t", "测试")
    addRow(bucket, makeRow({
      latency_ms: 3000,
      local_prep_ms: 100,
      first_token_ms: 400,
      completion_tokens: 600,
      reasoning_tokens: 9000,
      stream: 1,
    }))
    expect(bucket.tpsSampleCount).toBe(1)
    expect(bucket.genLatencySum).toBe(2500)
    expect(bucket.genTokensForTps).toBe(600)
    expect(finalizeSummary(bucket, 1).avgTps).toBeCloseTo(240, 5)
  })

  it("tokens 缺失时 TPS 记 null", () => {
    const bucket = createBucket("t", "测试")
    addRow(bucket, makeRow({
      latency_ms: 5000,
      local_prep_ms: 100,
      first_token_ms: 400,
      completion_tokens: null,
      stream: 1,
    }))
    expect(bucket.tpsSampleCount).toBe(0)
    expect(finalizeSummary(bucket, 1).avgTps).toBeNull()
  })
})
