import { getDatabase } from "@/server/db";
import { requireSession } from "../_auth";
import { estimateUsageCost } from "@/server/model-pricing";
import { listPoolTypeOptions } from "@/server/pool-type-options";

export const runtime = "nodejs";

interface BucketRow {
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

interface Bucket {
  key: string;
  label: string;
  requests: number;
  ok: number;
  fail: number;
  latencySum: number;
  firstTokenSum: number;
  firstTokenCount: number;
  tpsSampleCount: number;
  genLatencySum: number;
  genTokensForTps: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  poolType?: string;
}

interface UsageSummary {
  requests: number;
  ok: number;
  fail: number;
  avgLatencyMs: number;
  avgFirstTokenMs: number | null;
  avgTps: number;
  tpsSampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

interface UsageStats {
  summary: UsageSummary;
  byTime: Bucket[];
  byModel: Bucket[];
  byAccount: Bucket[];
  byKey: Bucket[];
}

const MAX_BUCKETS = 1000;
const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { ts: number; data: UsageStats }>();

function granularitySeconds(gran: string): number {
  if (gran === "5m") return 300;
  if (gran === "1m") return 60;
  if (gran === "1h") return 3600;
  if (gran === "1d") return 86400;
  return 3600;
}

function autoGranularity(hours: number): string {
  if (hours <= 1) return "5m";
  if (hours <= 2) return "1m";
  if (hours <= 72) return "1h";
  return "1d";
}

function clampGranularity(hours: number, gran: string): string {
  let seconds = granularitySeconds(gran);
  let resolved = gran;
  while (Math.ceil((hours * 3600) / seconds) > MAX_BUCKETS) {
    if (resolved === "5m") { resolved = "1m"; seconds = 60 }
    else if (resolved === "1m") { resolved = "1h"; seconds = 3600 }
    else if (resolved === "1h") { resolved = "1d"; seconds = 86400 }
    else break;
  }
  return resolved;
}

function bucketLabel(bucketStartMs: number, gran: string): string {
  const date = new Date(bucketStartMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (gran === "1d") return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (gran === "1h") return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createBucket(key: string, label: string): Bucket {
  return { key, label, requests: 0, ok: 0, fail: 0, latencySum: 0, firstTokenSum: 0, firstTokenCount: 0, tpsSampleCount: 0, genLatencySum: 0, genTokensForTps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

function addRow(bucket: Bucket, row: BucketRow): void {
  bucket.requests += 1;
  const ok = row.ok === 1;
  if (ok) bucket.ok += 1; else bucket.fail += 1;
  if (row.latency_ms != null) bucket.latencySum += row.latency_ms;
  if (row.first_token_ms != null) { bucket.firstTokenSum += row.first_token_ms; bucket.firstTokenCount += 1 }
  const localPrep = row.local_prep_ms ?? 0;
  const firstToken = row.first_token_ms ?? 0;
  const genLatency = (row.latency_ms ?? 0) - localPrep - firstToken;
  if (row.latency_ms != null && genLatency >= 50) {
    bucket.tpsSampleCount += 1;
    bucket.genLatencySum += genLatency;
    bucket.genTokensForTps += (row.completion_tokens ?? 0) + (row.reasoning_tokens ?? 0);
  }
  bucket.promptTokens += row.prompt_tokens ?? 0;
  bucket.completionTokens += row.completion_tokens ?? 0;
  bucket.totalTokens += row.total_tokens ?? 0;
  bucket.cachedTokens += row.cached_tokens ?? 0;
  bucket.reasoningTokens += row.reasoning_tokens ?? 0;
  const cost = estimateUsageCost({
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
  }).costUsd;
  if (cost != null) bucket.costUsd += cost;
}

function finalizeSummary(b: Bucket, latencyCount: number): UsageSummary {
  return {
    requests: b.requests,
    ok: b.ok,
    fail: b.fail,
    avgLatencyMs: latencyCount > 0 ? b.latencySum / latencyCount : 0,
    avgFirstTokenMs: b.firstTokenCount > 0 ? b.firstTokenSum / b.firstTokenCount : null,
    avgTps: b.tpsSampleCount > 0 && b.genLatencySum > 0 ? b.genTokensForTps / (b.genLatencySum / 1000) : 0,
    tpsSampleCount: b.tpsSampleCount,
    promptTokens: b.promptTokens,
    completionTokens: b.completionTokens,
    totalTokens: b.totalTokens,
    cachedTokens: b.cachedTokens,
    reasoningTokens: b.reasoningTokens,
    costUsd: b.costUsd,
  };
}

export function GET(request: Request): Response {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const hours = clampInt(url.searchParams.get("hours"), 1, 720, 24);
  const requestedGran = url.searchParams.get("granularity") ?? "auto";
  const gran = clampGranularity(hours, requestedGran === "auto" ? autoGranularity(hours) : requestedGran);
  const model = url.searchParams.get("model");
  const accountId = url.searchParams.get("accountId");
 const apiKeyId = url.searchParams.get("apiKeyId");
  const poolType = url.searchParams.get("poolType");
  const cacheKey = `${user.id}|${hours}|${gran}|${model ?? ""}|${accountId ?? ""}|${apiKeyId ?? ""}|${poolType ?? ""}`;
  const db = getDatabase();
  const poolTypes = listPoolTypeOptions(user.id, db);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return Response.json({ ...cached.data, poolTypes });

  const now = Date.now();
  const fromIso = new Date(now - hours * 3600 * 1000).toISOString();
  const toIso = new Date(now).toISOString();
  const conditions = ["owner_user_id = ?", "started_at >= ?", "started_at <= ?"];
  const params: (string | number)[] = [user.id, fromIso, toIso];
  if (model) { conditions.push("model = ?"); params.push(model) }
  if (accountId) { conditions.push("account_id = ?"); params.push(accountId) }
 if (apiKeyId) { conditions.push("api_key_id = ?"); params.push(apiKeyId) }
  if (poolType) { conditions.push("account_id IN (SELECT id FROM accounts WHERE owner_user_id = ? AND pool_type = ?)"); params.push(user.id, poolType) }
  const rows = db.prepare(`SELECT started_at,status,ok,latency_ms,local_prep_ms,first_token_ms,model,account_id,account_name,api_key_id,api_key_prefix,prompt_tokens,completion_tokens,total_tokens,cached_tokens,reasoning_tokens,stream FROM gateway_requests WHERE ${conditions.join(" AND ")}`).all(...params) as BucketRow[];
  const apiKeyNames = new Map(
    (db.prepare("SELECT id,name FROM api_keys WHERE owner_user_id=?").all(user.id) as Array<{ id: string; name: string }>)
      .map((key) => [key.id, key.name] as const),
  );
  const accountPoolTypes = new Map(
    (db.prepare("SELECT id,pool_type FROM accounts WHERE owner_user_id=?").all(user.id) as Array<{ id: string; pool_type: string }>)
      .map((row) => [row.id, row.pool_type] as const),
  );

  const bucketSeconds = granularitySeconds(gran);
  const bucketMs = bucketSeconds * 1000;
  const byTimeMap = new Map<number, Bucket>();
  const byModel = new Map<string, Bucket>();
  const byAccount = new Map<string, Bucket>();
  const byKey = new Map<string, Bucket>();
  const summary = createBucket("summary", "汇总");
  let latencyCount = 0;

  for (const row of rows) {
    const ts = Date.parse(row.started_at);
    if (Number.isNaN(ts)) continue;
    addRow(summary, row);
    if (row.latency_ms != null) latencyCount += 1;
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
    let timeBucket = byTimeMap.get(bucketStart);
    if (!timeBucket) { timeBucket = createBucket(String(bucketStart), bucketLabel(bucketStart, gran)); byTimeMap.set(bucketStart, timeBucket) }
    addRow(timeBucket, row);
    const modelKey = row.model ?? "(unknown)";
    let modelBucket = byModel.get(modelKey);
    if (!modelBucket) { modelBucket = createBucket(modelKey, row.model ?? "未知"); byModel.set(modelKey, modelBucket) }
    addRow(modelBucket, row);
    if (row.account_id) {
      let accBucket = byAccount.get(row.account_id);
     if (!accBucket) { accBucket = createBucket(row.account_id, row.account_name ?? row.account_id); byAccount.set(row.account_id, accBucket) }
      accBucket.poolType = accountPoolTypes.get(row.account_id);
      addRow(accBucket, row);
    }
    if (row.api_key_id) {
      let keyBucket = byKey.get(row.api_key_id);
      if (!keyBucket) { keyBucket = createBucket(row.api_key_id, apiKeyNames.get(row.api_key_id) ?? row.api_key_prefix ?? row.api_key_id); byKey.set(row.api_key_id, keyBucket) }
      addRow(keyBucket, row);
    }
  }

  const firstBucketStart = Math.floor((now - hours * 3600 * 1000) / bucketMs) * bucketMs;
  const lastBucketStart = Math.floor(now / bucketMs) * bucketMs;
  for (let t = firstBucketStart; t <= lastBucketStart; t += bucketMs) {
    if (!byTimeMap.has(t)) byTimeMap.set(t, createBucket(String(t), bucketLabel(t, gran)));
  }
  const byTime = [...byTimeMap.entries()].sort((a, b) => a[0] - b[0]).map(([, bucket]) => bucket);

  const data: UsageStats = {
    summary: finalizeSummary(summary, latencyCount),
    byTime,
    byModel: [...byModel.values()],
    byAccount: [...byAccount.values()],
    byKey: [...byKey.values()],
  };
  cache.set(cacheKey, { ts: Date.now(), data });
  return Response.json({ ...data, poolTypes });
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
