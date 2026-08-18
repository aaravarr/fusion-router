import { getDatabase } from "@/server/db"
import { listPoolTypeOptions } from "@/server/pool-type-options"
import { RoutingService } from "@/server/routing"
import { requireSession } from "../_auth"

export const runtime = "nodejs"

interface OverviewRequestRow {
  id: string
  endpoint: string
  model: string | null
  status: number | null
  outcome: string | null
  ok: number | null
  stream: number | null
  api_key_prefix: string | null
  api_key_name: string | null
  account_id: string | null
  account_name: string | null
  attempt_count: number
  started_at: string
  completed_at: string | null
  latency_ms: number | null
  first_token_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  cached_tokens: number | null
  reasoning_tokens: number | null
  client: string | null
  error: string | null
  has_request: number | null
  has_response: number | null
}

interface OverviewAttemptRow {
  request_id: string
  id: string
  account_id: string | null
  account_name: string | null
  attempt_number: number
  status: number | null
  decision: string | null
  error_type: string | null
  error_message: string | null
  latency_ms: number | null
  started_at: string
  completed_at: string | null
}

interface OverviewAccount {
  id: string
  name: string
  email: string | null
}

/** 解析可选 ISO 时间参数：空值返回 null，非空但非法时抛出 400 响应。 */
function parseIsoParam(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) {
    throw new Response(JSON.stringify({ error: "时间参数格式无效" }), { status: 400, headers: { "content-type": "application/json" } })
  }
  return date.toISOString()
}

/** 解析逗号分隔的账号 ID 列表：trim 后过滤空串，上限 100 个。 */
function parseAccountIds(value: string | null): string[] {
  if (value === null) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 100)
}

export function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const url = new URL(request.url)
  let fromIso: string | null = null
  let toIso: string | null = null
  try {
    fromIso = parseIsoParam(url.searchParams.get("from"))
    toIso = parseIsoParam(url.searchParams.get("to"))
  } catch (cause) {
    if (cause instanceof Response) return cause
    throw cause
  }
  if (fromIso && toIso && fromIso > toIso) {
    return Response.json({ error: "开始时间不能晚于结束时间" }, { status: 400 })
  }
  const accountIds = parseAccountIds(url.searchParams.get("accountId"))
  const db = getDatabase()
  const scalar = (sql: string) => Number((db.prepare(sql).get(user.id) as { value: number }).value)
  // 最近请求：按 from/to 时间范围与账号列表动态追加 WHERE 条件
  const requestConditions = ["g.owner_user_id=?"]
  const requestParams: (string | number)[] = [user.id]
  if (fromIso) { requestConditions.push("g.started_at >= ?"); requestParams.push(fromIso) }
  if (toIso) { requestConditions.push("g.started_at <= ?"); requestParams.push(toIso) }
  if (accountIds.length) {
    const placeholders = accountIds.map(() => "?").join(",")
    requestConditions.push(`g.account_id IN (${placeholders})`)
    requestParams.push(...accountIds)
  }
  const requestRows = db.prepare(`SELECT g.id,g.endpoint,g.model,g.status,g.outcome,g.ok,g.stream,g.api_key_prefix,k.name AS api_key_name,g.account_id,g.account_name,g.attempt_count,g.started_at,g.completed_at,g.latency_ms,g.first_token_ms,g.prompt_tokens,g.completion_tokens,g.total_tokens,g.cached_tokens,g.reasoning_tokens,g.client,g.error,rb.has_request,rb.has_response FROM gateway_requests g LEFT JOIN request_bodies rb ON rb.request_id = g.id LEFT JOIN api_keys k ON k.id = g.api_key_id WHERE ${requestConditions.join(" AND ")} ORDER BY g.started_at DESC LIMIT 50`).all(...requestParams) as OverviewRequestRow[]
  const recentRequests = requestRows.map((row) => ({
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
    promptTokens: row.prompt_tokens,
    inputTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    outputTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cachedTokens: row.cached_tokens,
    reasoningTokens: row.reasoning_tokens,
    hasRequest: row.has_request === 1,
    hasResponse: row.has_response === 1,
    client: row.client,
    error: row.error,
  }))
  const requestIds = requestRows.map((row) => row.id)
  const recentAttempts: Record<string, OverviewAttemptRow[]> = {}
  if (requestIds.length) {
    const placeholders = requestIds.map(() => "?").join(",")
    const attemptRows = db.prepare(`SELECT request_id,id,account_id,account_name,attempt_number,status,decision,error_type,error_message,latency_ms,started_at,completed_at FROM gateway_attempts WHERE request_id IN (${placeholders}) ORDER BY attempt_number`).all(...requestIds) as OverviewAttemptRow[]
    for (const attempt of attemptRows) {
      const list = recentAttempts[attempt.request_id] ?? []
      list.push(attempt)
      recentAttempts[attempt.request_id] = list
    }
  }
  // 最近事件：同样按 created_at 与 account_id 过滤
  const eventConditions = ["owner_user_id=?"]
  const eventParams: (string | number)[] = [user.id]
  if (fromIso) { eventConditions.push("created_at >= ?"); eventParams.push(fromIso) }
  if (toIso) { eventConditions.push("created_at <= ?"); eventParams.push(toIso) }
  if (accountIds.length) {
    const placeholders = accountIds.map(() => "?").join(",")
    eventConditions.push(`account_id IN (${placeholders})`)
    eventParams.push(...accountIds)
  }
  const recentEvents = (db.prepare(`SELECT id, type, severity AS level, severity, account_id AS accountId, request_id AS requestId, metadata_json AS metadata, created_at AS createdAt FROM events WHERE ${eventConditions.join(" AND ")} ORDER BY created_at DESC LIMIT 50`).all(...eventParams) as Array<Record<string, unknown>>).map((event) => ({ ...event, message: String(event.type), metadata: JSON.parse(String(event.metadata)) }))
  const routing = new RoutingService(user.id, db).getState()
  // 账号下拉数据源：供前端筛选账号使用
  const accounts = db.prepare("SELECT id, name, email FROM accounts WHERE owner_user_id=? ORDER BY name").all(user.id) as OverviewAccount[]
  // Pool type statistics
  const poolTypeStats = new RoutingService(user.id, db).getPoolTypeStats()
  const aggregatePoolStat = (key: "ready" | "blocked" | "inactive") => Object.values(poolTypeStats).reduce((sum, value) => sum + value[key], 0)
  const readyRows = db.prepare("SELECT q.account_id,MIN(q.reset_at) AS ready_at FROM quota_windows q JOIN accounts a ON a.id=q.account_id WHERE a.owner_user_id=? AND q.usage_percent>=100 AND julianday(q.reset_at)>julianday('now') GROUP BY q.account_id").all(user.id) as { account_id: string; ready_at: string }[]
  const recentAttemptsPayload: Record<string, unknown> = {}
  for (const [requestId, attempts] of Object.entries(recentAttempts)) {
    recentAttemptsPayload[requestId] = attempts.map((attempt) => ({
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
    }))
  }
  return Response.json({
    counts: {
      totalAccounts: scalar("SELECT COUNT(*) AS value FROM accounts WHERE owner_user_id=?"),
      readyAccounts: aggregatePoolStat("ready"),
      quotaBlocked: aggregatePoolStat("blocked"),
      inactiveAccounts: aggregatePoolStat("inactive"),
      apiKeys: scalar("SELECT COUNT(*) AS value FROM api_keys WHERE owner_user_id=? AND enabled=1"),
      byPoolType: poolTypeStats,
    },
    routing: { ...routing, currentAccountName: accounts.find((account) => account.id === routing.currentAccountId)?.name ?? null, preferredAccountName: accounts.find((account) => account.id === routing.preferredAccountId)?.name ?? null, nextRecoveryAt: readyRows.map((row) => row.ready_at).sort()[0] ?? null },
    recentRequests,
    recentEvents,
    recentAttempts: recentAttemptsPayload,
    poolTypes: listPoolTypeOptions(user.id, db),
    accounts,
  })
}
