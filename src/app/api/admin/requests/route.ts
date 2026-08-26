import { getDatabase } from "@/server/db";
import { requireSession } from "../_auth";
import { cachedCount, cappedCount } from "@/server/lightweight-count";
import { estimateUsageCost, formatUsd } from "@/server/model-pricing";

export const runtime = "nodejs";

interface RequestRow {
  id: string;
  endpoint: string;
  model: string | null;
  status: number | null;
  outcome: string | null;
  ok: number | null;
  stream: number | null;
  api_key_prefix: string | null;
  api_key_name: string | null;
  account_id: string | null;
  account_name: string | null;
  attempt_count: number;
  started_at: string;
  completed_at: string | null;
  latency_ms: number | null;
  local_prep_ms: number | null;
  first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  text_tokens: number | null;
  image_tokens: number | null;
  audio_tokens: number | null;
  client: string | null;
  error: string | null;
  has_request: number | null;
  has_response: number | null;
  inbound_endpoint: string | null;
  upstream_endpoint: string | null;
  process_mode: string | null;
  route_mode: string | null;
  route_reason: string | null;
  converted: number | null;
  transform_summary: string | null;
}

function mapRequest(row: RequestRow) {
  const genLatency = row.latency_ms != null
    ? Math.max(0, row.latency_ms - (row.local_prep_ms ?? 0) - (row.first_token_ms ?? 0))
    : null;
  // TPS：分子 completion_tokens，窗口 = 首 chunk → 完成；<200ms（末尾 burst）或 token 缺失记 null。
  const tps = genLatency != null && row.completion_tokens != null && row.completion_tokens > 0 && genLatency >= 200
    ? Number((row.completion_tokens / (genLatency / 1000)).toFixed(1))
    : null;
  return {
    id: row.id,
    endpoint: row.endpoint,
    createdAt: row.started_at,
    model: row.model,
    stream: Boolean(row.stream),
    status: row.status,
    outcome: row.outcome,
    ok: row.ok === 1,
    apiKeyPrefix: row.api_key_prefix,
    apiKeyName: row.api_key_name,
    accountId: row.account_id,
    accountName: row.account_name,
    attemptCount: row.attempt_count,
    latencyMs: row.latency_ms,
    firstTokenMs: row.first_token_ms,
    localPrepMs: row.local_prep_ms,
    promptTokens: row.prompt_tokens,
    inputTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    outputTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cachedTokens: row.cached_tokens,
    reasoningTokens: row.reasoning_tokens,
    textTokens: row.text_tokens,
    imageTokens: row.image_tokens,
    audioTokens: row.audio_tokens,
    hasRequest: row.has_request === 1,
    hasResponse: row.has_response === 1,
    client: row.client,
    error: row.error,
    inboundEndpoint: row.inbound_endpoint,
    upstreamEndpoint: row.upstream_endpoint,
    processMode: row.process_mode,
    routeMode: row.route_mode,
    routeReason: row.route_reason,
    converted: row.converted === 1,
    transformSummary: row.transform_summary,
    tps,
    ...(() => {
      const cost = estimateUsageCost({
        model: row.model,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        cachedTokens: row.cached_tokens,
      })
      return {
        costUsd: cost.costUsd,
        costLabel: formatUsd(cost.costUsd),
        pricingModelId: cost.matchedModelId,
      }
    })(),
  };
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.round(parsed));
}

export function GET(request: Request): Response {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 10_000);
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20, 100);
  const okParam = url.searchParams.get("ok");
  const statusParam = url.searchParams.get("status");
  const model = url.searchParams.get("model");
  const q = url.searchParams.get("q");

  const conditions = ["g.owner_user_id = ?"];
  const params: (string | number)[] = [user.id];
  if (okParam === "true" || okParam === "1") { conditions.push("g.ok = 1") }
  else if (okParam === "false" || okParam === "0") { conditions.push("g.ok = 0") }
  if (statusParam) {
    const statusNum = Number(statusParam);
    if (Number.isFinite(statusNum)) { conditions.push("g.status = ?"); params.push(statusNum) }
  }
  if (model) { conditions.push("g.model LIKE ?"); params.push(`%${model}%`) }
  if (q) { conditions.push("(g.endpoint LIKE ? OR g.inbound_endpoint LIKE ? OR g.upstream_endpoint LIKE ? OR g.route_mode LIKE ? OR g.route_reason LIKE ? OR g.transform_summary LIKE ? OR g.error LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) }

  const db = getDatabase();
  const where = conditions.join(" AND ");
  // 分页 total 不做无界 COUNT(*) 全扫（同步驱动会卡死事件循环且随库增长变慢）：
  // 封顶计数（LIMIT 截断，触顶即「约」）+ 60s TTL 缓存，翻页耗时恒定。
  const totalInfo = cachedCount(`gateway-requests:${user.id}:${JSON.stringify(params)}`, () => cappedCount(db, `FROM gateway_requests g WHERE ${where}`, params));
  const total = totalInfo.value;
  const rows = db.prepare(`SELECT g.id,g.endpoint,g.model,g.status,g.outcome,g.ok,g.stream,g.api_key_prefix,k.name AS api_key_name,g.account_id,g.account_name,g.attempt_count,g.started_at,g.completed_at,g.latency_ms,g.local_prep_ms,g.first_token_ms,g.prompt_tokens,g.completion_tokens,g.total_tokens,g.cached_tokens,g.reasoning_tokens,g.text_tokens,g.image_tokens,g.audio_tokens,g.client,g.error,g.inbound_endpoint,g.upstream_endpoint,g.process_mode,g.route_mode,g.route_reason,g.converted,g.transform_summary,rb.has_request,rb.has_response FROM gateway_requests g LEFT JOIN request_bodies rb ON rb.request_id = g.id LEFT JOIN api_keys k ON k.id = g.api_key_id WHERE ${where} ORDER BY g.started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as RequestRow[];
  return Response.json({ items: rows.map(mapRequest), total, totalApproximate: totalInfo.approximate, page, pageSize });
}
