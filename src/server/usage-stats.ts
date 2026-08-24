import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { estimateUsageCost } from "./model-pricing"

export interface UsageBucketRow {
  started_at: string;
  status: number | null;
  ok: number | null;
  latency_ms: number | null;
  local_prep_ms: number | null;
  first_token_ms: number | null;
  model: string | null;
  account_id: string | null;
  account_name: string | null;
  api_key_id: string | null;
  api_key_prefix: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  stream: number | null;
}

export interface UsageModelTokenTotals {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

export interface UsageBucket {
  key: string
  label: string
  requests: number
  ok: number
  fail: number
  latencySum: number
  firstTokenSum: number
  firstTokenCount: number
  tpsSampleCount: number
  genLatencySum: number
  genTokensForTps: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  reasoningTokens: number
  costUsd: number
  poolType?: string
  modelTokens?: Map<string, UsageModelTokenTotals>
}

export function createBucket(key: string, label: string): UsageBucket {
  return { key, label, requests: 0, ok: 0, fail: 0, latencySum: 0, firstTokenSum: 0, firstTokenCount: 0, tpsSampleCount: 0, genLatencySum: 0, genTokensForTps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0, modelTokens: new Map() }
}

export function addRow(bucket: UsageBucket, row: UsageBucketRow): void {
  bucket.requests += 1
  const ok = row.ok === 1
  if (ok) bucket.ok += 1; else bucket.fail += 1
  if (row.latency_ms != null) bucket.latencySum += row.latency_ms
  if (row.first_token_ms != null) { bucket.firstTokenSum += row.first_token_ms; bucket.firstTokenCount += 1 }
  const localPrep = row.local_prep_ms ?? 0
  const firstToken = row.first_token_ms ?? 0
  // TPS 窗口 = 首 chunk → 完成（latency - 本地准备 - 首 token）；分子只用 completion_tokens。
  // 窗口 <200ms 说明内容是末尾 burst（如 reasoning 流思考完一次性吐出），TPS 无意义，不采样。
  const genWindow = (row.latency_ms ?? 0) - localPrep - firstToken
  if (row.latency_ms != null && row.completion_tokens != null && genWindow >= 200) {
    bucket.tpsSampleCount += 1
    bucket.genLatencySum += genWindow
    bucket.genTokensForTps += row.completion_tokens
  }
  bucket.promptTokens += row.prompt_tokens ?? 0
  bucket.completionTokens += row.completion_tokens ?? 0
  bucket.totalTokens += row.total_tokens ?? 0
  bucket.cachedTokens += row.cached_tokens ?? 0
  bucket.reasoningTokens += row.reasoning_tokens ?? 0
  if (!bucket.modelTokens) bucket.modelTokens = new Map()
  const modelKey = row.model ?? "(unknown)"
  const tokens = bucket.modelTokens.get(modelKey) ?? { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
  tokens.promptTokens += row.prompt_tokens ?? 0
  tokens.completionTokens += row.completion_tokens ?? 0
  tokens.cachedTokens += row.cached_tokens ?? 0
  bucket.modelTokens.set(modelKey, tokens)
}

export function finalizeBucketCost(bucket: UsageBucket, db: AppDatabase = getDatabase()): void {
  let costUsd = 0
  const totals = bucket.modelTokens
  if (totals) {
    for (const [model, tokens] of totals) {
      const cost = estimateUsageCost({ model, promptTokens: tokens.promptTokens, completionTokens: tokens.completionTokens, cachedTokens: tokens.cachedTokens }, db).costUsd
      if (cost != null) costUsd += cost
    }
  }
  bucket.costUsd = costUsd
  delete bucket.modelTokens
}

export interface UsageSummary {
  requests: number;
  ok: number;
  fail: number;
  avgLatencyMs: number;
  avgFirstTokenMs: number | null;
  avgTps: number | null;
  tpsSampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export function finalizeSummary(b: UsageBucket, latencyCount: number): UsageSummary {
  return {
    requests: b.requests,
    ok: b.ok,
    fail: b.fail,
    avgLatencyMs: latencyCount > 0 ? b.latencySum / latencyCount : 0,
    avgFirstTokenMs: b.firstTokenCount > 0 ? b.firstTokenSum / b.firstTokenCount : null,
    avgTps: b.tpsSampleCount > 0 && b.genLatencySum > 0 ? b.genTokensForTps / (b.genLatencySum / 1000) : null,
    tpsSampleCount: b.tpsSampleCount,
    promptTokens: b.promptTokens,
    completionTokens: b.completionTokens,
    totalTokens: b.totalTokens,
    cachedTokens: b.cachedTokens,
    reasoningTokens: b.reasoningTokens,
    costUsd: b.costUsd,
  }
}
