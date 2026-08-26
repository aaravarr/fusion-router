import { getDatabase } from "@/server/db";
import { requireSession } from "../../_auth";
import { cachedCount } from "@/server/lightweight-count";

export const runtime = "nodejs";

/** 采样行数上限：只扫最近 N 行（owner+started_at 索引前缀），绝不全表扫描。 */
export const FACET_SAMPLE_ROWS = 5_000;
/** 单维度选项数上限：超过后不再收录（高频值在前，低频尾部截断）。 */
export const FACET_MAX_OPTIONS = 200;

export interface RequestFacets {
  /** 实际采样的行数；approximate=true 表示样本可能不含更早记录的长尾值。 */
  sampledRows: number;
  approximate: boolean;
  accounts: Array<{ id: string; name: string }>;
  apiKeys: Array<{ id: string; name: string; prefix: string }>;
  providers: string[];
  models: string[];
  inboundEndpoints: string[];
  upstreamEndpoints: string[];
  clients: string[];
}

function collectCapped(set: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  if (set.size >= FACET_MAX_OPTIONS && !set.has(value)) return;
  set.add(value);
}

function buildFacets(db: ReturnType<typeof getDatabase>, ownerId: string): RequestFacets {
  // 配置类小表直接全量（accounts / api_keys 随用户规模有界）。
  const accounts = db.prepare("SELECT id,name FROM accounts WHERE owner_user_id=? ORDER BY name").all(ownerId) as Array<{ id: string; name: string }>;
  const apiKeys = db.prepare("SELECT id,name,key_prefix FROM api_keys WHERE owner_user_id=? ORDER BY created_at DESC").all(ownerId) as Array<{ id: string; name: string; key_prefix: string }>;
  const providerRows = db.prepare("SELECT DISTINCT pool_type AS poolType FROM accounts WHERE owner_user_id=? AND pool_type IS NOT NULL").all(ownerId) as Array<{ poolType: string }>;
  // 请求维度走「近 N 行采样」：DISTINCT 全扫大表会卡死同步驱动，这里按 owner+started_at DESC 索引取最近样本。
  const rows = db.prepare("SELECT model,inbound_endpoint,upstream_endpoint,client FROM gateway_requests WHERE owner_user_id=? ORDER BY started_at DESC LIMIT ?").all(ownerId, FACET_SAMPLE_ROWS) as Array<{
    model: string | null;
    inbound_endpoint: string | null;
    upstream_endpoint: string | null;
    client: string | null;
  }>;
  const models = new Set<string>();
  const inboundEndpoints = new Set<string>();
  const upstreamEndpoints = new Set<string>();
  const clients = new Set<string>();
  for (const row of rows) {
    collectCapped(models, row.model);
    collectCapped(inboundEndpoints, row.inbound_endpoint);
    collectCapped(upstreamEndpoints, row.upstream_endpoint);
    collectCapped(clients, row.client);
  }
  const sortValues = (set: Set<string>): string[] => [...set].sort((a, b) => a.localeCompare(b));
  return {
    sampledRows: rows.length,
    approximate: rows.length >= FACET_SAMPLE_ROWS,
    accounts: accounts.map((row) => ({ id: row.id, name: row.name })),
    apiKeys: apiKeys.map((row) => ({ id: row.id, name: row.name, prefix: row.key_prefix })),
    providers: sortValues(new Set(providerRows.map((row) => row.poolType))),
    models: sortValues(models),
    inboundEndpoints: sortValues(inboundEndpoints),
    upstreamEndpoints: sortValues(upstreamEndpoints),
    clients: sortValues(clients),
  };
}

export function GET(request: Request): Response {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const db = getDatabase();
  // 复用 lightweight-count 的 60s TTL 内存缓存：facets 只需近实时，重复请求零开销。
  const data = cachedCount(`admin-request-facets:${user.id}`, () => buildFacets(db, user.id));
  return Response.json(data);
}