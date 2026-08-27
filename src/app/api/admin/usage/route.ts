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
// 自定义时间范围（from/to 同时存在）的跨度上限：92 天。
// 对齐 hours 上限 720h=30d 与 MAX_BUCKETS 的平衡，并给趋势图留出余量。
const MAX_CUSTOM_RANGE_MS = 92 * 24 * 3600 * 1000;
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

/** 解析可选 ISO 时间参数：空值返回 null，非空但非法时抛出 400 响应。 */
function parseIsoParam(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Response(JSON.stringify({ error: "时间参数格式无效" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  return date.toISOString();
}

/** 解析逗号分隔的 ID 列表：单值兼容（无逗号即单值），trim 后过滤空串，上限 100 个。 */
function parseIdList(value: string | null): string[] {
  if (value === null) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 100);
}

export function GET(request: Request): Response {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  let fromIso: string | null = null;
  let toIso: string | null = null;
  try {
    fromIso = parseIsoParam(url.searchParams.get("from"));
    toIso = parseIsoParam(url.searchParams.get("to"));
  } catch (cause) {
    if (cause instanceof Response) return cause;
    throw cause;
  }
  if (fromIso && toIso) {
    if (fromIso > toIso) {
      return Response.json({ error: "开始时间不能晚于结束时间" }, { status: 400 });
    }
    if (Date.parse(toIso) - Date.parse(fromIso) > MAX_CUSTOM_RANGE_MS) {
      return Response.json({ error: "自定义时间范围最长 92 天" }, { status: 400 });
    }
  }
  const hours = clampInt(url.searchParams.get("hours"), 1, 720, 24);
  // 自定义范围时按真实跨度选择粒度，避免长范围仍按默认 24h 计算
  const windowHours = fromIso ? (Date.parse(toIso ?? new Date().toISOString()) - Date.parse(fromIso)) / 3600000 : hours;
  const requestedGran = url.searchParams.get("granularity") ?? "auto";
  const gran = clampGranularity(windowHours, requestedGran === "auto" ? autoGranularity(windowHours) : requestedGran);
  const accountId = url.searchParams.get("accountId");
  const accountIds = parseIdList(accountId);
  // 模型/号池筛选：逗号分隔多值（单值=一个元素的数组语义）
  const modelFilter = parseIdList(url.searchParams.get("model"));
  const poolTypeFilter = parseIdList(url.searchParams.get("poolType"));
  // 密钥筛选：apiKeyIds 多值为主，apiKeyId 为旧版单值参数（两者都给时并入去重，保持向后兼容）
  const apiKeyIds = parseIdList(url.searchParams.get("apiKeyIds"));
  const legacyApiKeyId = url.searchParams.get("apiKeyId");
  if (legacyApiKeyId && !apiKeyIds.includes(legacyApiKeyId)) {
    apiKeyIds.push(legacyApiKeyId);
    if (apiKeyIds.length > 100) apiKeyIds.length = 100;
  }
  const apiKeyIdFilter = apiKeyIds;
  // 缓存 key 必须并入 from/to 与模型/号池/账号/密钥原始参数，否则不同范围会串数据
  const cacheKey = `${user.id}|${hours}|${gran}|${url.searchParams.get("model") ?? ""}|${accountId ?? ""}|${url.searchParams.get("apiKeyIds") ?? ""}|${legacyApiKeyId ?? ""}|${url.searchParams.get("poolType") ?? ""}|${fromIso ?? ""}|${toIso ?? ""}`;
  const db = getDatabase();
  const poolTypes = listPoolTypeOptions(user.id, db);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return Response.json({ ...cached.data, poolTypes });

  const now = Date.now();
  const fromIso2 = fromIso ?? new Date(now - hours * 3600 * 1000).toISOString();
  const toIso2 = toIso ?? new Date(now).toISOString();
  const conditions = ["owner_user_id = ?", "started_at >= ?", "started_at <= ?"];
  const params: (string | number)[] = [user.id, fromIso2, toIso2];
  if (modelFilter.length) {
    const placeholders = modelFilter.map(() => "?").join(",");
    conditions.push(`model IN (${placeholders})`);
    params.push(...modelFilter);
  }
  if (accountIds.length) {
    const placeholders = accountIds.map(() => "?").join(",");
    conditions.push(`account_id IN (${placeholders})`);
    params.push(...accountIds);
  }
  if (apiKeyIdFilter.length) {
    const placeholders = apiKeyIdFilter.map(() => "?").join(",");
    conditions.push(`api_key_id IN (${placeholders})`);
    params.push(...apiKeyIdFilter);
  }
  if (poolTypeFilter.length) {
    const placeholders = poolTypeFilter.map(() => "?").join(",");
    conditions.push(`account_id IN (SELECT id FROM accounts WHERE owner_user_id = ? AND pool_type IN (${placeholders}))`);
    params.push(user.id, ...poolTypeFilter);
  }
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

  // 补空桶的窗口：自定义范围时用 from/to 边界，否则维持 now-hours ~ now
  const windowStartMs = fromIso ? Date.parse(fromIso2) : now - hours * 3600 * 1000;
  const windowEndMs = toIso ? Date.parse(toIso2) : now;
  const firstBucketStart = Math.floor(windowStartMs / bucketMs) * bucketMs;
  const lastBucketStart = Math.floor(windowEndMs / bucketMs) * bucketMs;
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
