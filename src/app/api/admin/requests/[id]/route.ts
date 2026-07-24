import { getDatabase } from "@/server/db";
import { requireSession } from "../../_auth";
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
  user_agent: string | null;
  origin: string | null;
  error: string | null;
  request_size_bytes: number | null;
  response_size_bytes: number | null;
  inbound_endpoint: string | null;
  upstream_endpoint: string | null;
  process_mode: string | null;
  route_mode: string | null;
  route_reason: string | null;
  converted: number | null;
  transform_summary: string | null;
}

interface BodyRow {
  request_body_json: string | null;
  response_body_json: string | null;
  request_headers_json: string | null;
  request_truncated: number | null;
  response_truncated: number | null;
  has_request: number | null;
  has_response: number | null;
}

interface AttemptRow {
  id: string;
  account_id: string | null;
  account_name: string | null;
  attempt_number: number;
  status: number | null;
  decision: string | null;
  error_type: string | null;
  error_message: string | null;
  latency_ms: number | null;
  started_at: string;
  completed_at: string | null;
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T } catch { return undefined }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDatabase();
  const row = db.prepare("SELECT g.id,g.endpoint,g.model,g.status,g.outcome,g.ok,g.stream,g.api_key_prefix,k.name AS api_key_name,g.account_id,g.account_name,g.attempt_count,g.started_at,g.completed_at,g.latency_ms,g.local_prep_ms,g.first_token_ms,g.prompt_tokens,g.completion_tokens,g.total_tokens,g.cached_tokens,g.reasoning_tokens,g.text_tokens,g.image_tokens,g.audio_tokens,g.client,g.user_agent,g.origin,g.error,g.request_size_bytes,g.response_size_bytes,g.inbound_endpoint,g.upstream_endpoint,g.process_mode,g.route_mode,g.route_reason,g.converted,g.transform_summary FROM gateway_requests g LEFT JOIN api_keys k ON k.id=g.api_key_id WHERE g.id=? AND g.owner_user_id=?").get(id, user.id) as RequestRow | undefined;
  if (!row) return Response.json({ error: { type: "not_found", message: "请求不存在" } }, { status: 404 });
  const body = db.prepare("SELECT request_body_json,response_body_json,request_headers_json,request_truncated,response_truncated,has_request,has_response FROM request_bodies WHERE request_id=?").get(id) as BodyRow | undefined;
  const attempts = db.prepare("SELECT id,account_id,account_name,attempt_number,status,decision,error_type,error_message,latency_ms,started_at,completed_at FROM gateway_attempts WHERE request_id=? ORDER BY attempt_number").all(id) as AttemptRow[];
  const headers = parseJson<Record<string, string>>(body?.request_headers_json ?? null);
  const genLatency = row.latency_ms != null ? Math.max(0, row.latency_ms - (row.local_prep_ms ?? 0) - (row.first_token_ms ?? 0)) : null;
  const tpsTokens = (row.completion_tokens ?? 0) + (row.reasoning_tokens ?? 0);
  const tps = genLatency != null && genLatency >= 50 && tpsTokens > 0 ? Number((tpsTokens / (genLatency / 1000)).toFixed(1)) : null;
  const cost = estimateUsageCost({
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
  });
  return Response.json({
    request: {
      id: row.id,
      tps,
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
      hasRequest: body?.has_request === 1,
      hasResponse: body?.has_response === 1,
      client: row.client,
      userAgent: row.user_agent,
      error: row.error,
      localPrepMs: row.local_prep_ms,
      requestSizeBytes: row.request_size_bytes,
      responseSizeBytes: row.response_size_bytes,
      inboundEndpoint: row.inbound_endpoint,
      upstreamEndpoint: row.upstream_endpoint,
      processMode: row.process_mode,
      routeMode: row.route_mode,
      routeReason: row.route_reason,
      converted: row.converted === 1,
      transformSummary: row.transform_summary,
      costUsd: cost.costUsd,
      costLabel: formatUsd(cost.costUsd),
      pricingModelId: cost.matchedModelId,
      request: parseJson(body?.request_body_json ?? null),
      requestTruncated: body?.request_truncated === 1,
      response: parseJson(body?.response_body_json ?? null),
      responseTruncated: body?.response_truncated === 1,
      headers,
    },
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      accountId: attempt.account_id,
      accountName: attempt.account_name,
      status: attempt.status,
      decision: attempt.decision ?? undefined,
      errorType: attempt.error_type,
      errorMessage: attempt.error_message,
      latencyMs: attempt.latency_ms,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    })),
  });
}
