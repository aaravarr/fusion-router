import { getDatabase } from "@/server/db";
import { requireSession } from "../_auth";
import { listPoolTypeOptions } from "@/server/pool-type-options";
import { addRow, createBucket, finalizeBucketCost, finalizeSummary, type UsageBucket, type UsageBucketRow, type UsageSummary } from "@/server/usage-stats";

export const runtime = "nodejs";

interface UsageStats {
  summary: UsageSummary;
  byTime: UsageBucket[];
  byModel: UsageBucket[];
  byAccount: UsageBucket[];
  byKey: UsageBucket[];
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
  const rows = db.prepare(`SELECT started_at,status,ok,latency_ms,local_prep_ms,first_token_ms,model,account_id,account_name,api_key_id,api_key_prefix,prompt_tokens,completion_tokens,total_tokens,cached_tokens,reasoning_tokens,stream FROM gateway_requests WHERE ${conditions.join(" AND ")}`).all(...params) as UsageBucketRow[];
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
  const byTimeMap = new Map<number, UsageBucket>();
  const byModel = new Map<string, UsageBucket>();
  const byAccount = new Map<string, UsageBucket>();
  const byKey = new Map<string, UsageBucket>();
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

  const allBuckets = [summary, ...byTime, ...byModel.values(), ...byAccount.values(), ...byKey.values()]
  for (const bucket of allBuckets) finalizeBucketCost(bucket, db)

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
