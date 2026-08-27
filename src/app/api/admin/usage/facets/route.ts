import { getDatabase } from "@/server/db";
import { requireSession } from "../../_auth";
import { cachedCount } from "@/server/lightweight-count";
import { listPoolTypeOptions } from "@/server/pool-type-options";

export const runtime = "nodejs";

/** 采样窗口：只统计最近 30 天的请求（对齐看板最长预设区间），绝不回扫全表。 */
export const USAGE_FACET_WINDOW_MS = 30 * 24 * 3600 * 1000;
/** 「近期仍活跃」判定窗口：模型在最近 24 天内出现过才进入下拉主列表。 */
export const USAGE_FACET_RECENT_MS = 24 * 24 * 3600 * 1000;
/** 采样行数上限：只扫窗口内最近 N 行（owner+started_at 索引前缀），绝不全表扫描。 */
export const USAGE_FACET_SAMPLE_ROWS = 5_000;
/** 单维度选项数上限：超过后不再收录（高频值在前，低频尾部截断）。 */
export const USAGE_FACET_MAX_OPTIONS = 200;

/**
 * 用量看板的固定选项源：候选集只取决于配置表与请求采样，
 * 不接受任何筛选参数，因此不随看板当前筛选结果缩水。
 * 账号 / 密钥选项不在此接口：前端已有 /api/admin/accounts、/api/admin/keys 全量小表来源。
 */
export interface UsageFacets {
  /** 实际采样的行数；approximate=true 表示样本可能不含更早记录的长尾值。 */
  sampledRows: number;
  approximate: boolean;
  /** 采样窗口内出现过的全部模型（升序，超 200 截断）。 */
  models: string[];
  /** 其中仍在近 24 天出现的模型子集，作为下拉首选列表。 */
  recentModels: string[];
  /** 号池类型全集（含展示标签）。 */
  poolTypes: Array<{ type: string; label: string }>;
}

function collectCapped(set: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  if (set.size >= USAGE_FACET_MAX_OPTIONS && !set.has(value)) return;
  set.add(value);
}

function buildFacets(db: ReturnType<typeof getDatabase>, ownerId: string): UsageFacets {
  const now = Date.now();
  const windowStartIso = new Date(now - USAGE_FACET_WINDOW_MS).toISOString();
  const recentStartIso = new Date(now - USAGE_FACET_RECENT_MS).toISOString();
  // 请求维度走「近 N 行采样」：DISTINCT 全扫大表会卡死同步驱动，这里按 owner+started_at 索引取窗口内样本。
  const rows = db
    .prepare("SELECT model,started_at FROM gateway_requests WHERE owner_user_id=? AND started_at >= ? ORDER BY started_at DESC LIMIT ?")
    .all(ownerId, windowStartIso, USAGE_FACET_SAMPLE_ROWS) as Array<{ model: string | null; started_at: string }>;
  const models = new Set<string>();
  const recentModels = new Set<string>();
  for (const row of rows) {
    collectCapped(models, row.model);
    if (row.started_at >= recentStartIso) collectCapped(recentModels, row.model);
  }
  return {
    sampledRows: rows.length,
    approximate: rows.length >= USAGE_FACET_SAMPLE_ROWS,
    models: [...models].sort((a, b) => a.localeCompare(b)),
    recentModels: [...recentModels].sort((a, b) => a.localeCompare(b)),
    poolTypes: listPoolTypeOptions(ownerId, db).map((option) => ({ type: option.type, label: option.label })),
  };
}

export function GET(request: Request): Response {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const db = getDatabase();
  // 复用 lightweight-count 的 60s TTL 内存缓存：固定选项只需近实时，重复请求零开销。
  const data = cachedCount(`admin-usage-facets:${user.id}`, () => buildFacets(db, user.id));
  return Response.json(data);
}
