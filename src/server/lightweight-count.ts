import type { AppDatabase } from "./db";

/**
 * 轻量计数工具：better-sqlite3 是同步驱动，任何无界的 COUNT(*)/JOIN 计数全表
 * 扫描都会卡死整个 Node 事件循环（大库实测数十秒，全站 API 连带堵死）。
 * 统一两种安全口径（数值允许近似，调用方应通过 approximate 标注告知前端）：
 * - cappedCount：子查询 LIMIT 封顶的计数，扫描行数有硬上限，不随表增长变慢；
 * - estimateTableCount：MAX(rowid) 常数时间估算（删除少时接近真实值）。
 * 叠加 60s TTL 内存缓存防重复触发（对齐 22d5d95 的做法）。
 */

export const COUNT_CACHE_TTL_MS = 60_000;
export const DEFAULT_COUNT_CAP = 20_000;

const countCache = new Map<string, { at: number; value: unknown }>();

/** 60s TTL 缓存包装：同一 key 在 TTL 内直接复用上次计算结果。 */
export function cachedCount<T>(key: string, compute: () => T): T {
  const now = Date.now();
  const hit = countCache.get(key);
  if (hit && now - hit.at < COUNT_CACHE_TTL_MS) return hit.value as T;
  const value = compute();
  countCache.set(key, { at: now, value });
  return value;
}

export interface CappedCountResult {
  /** 计数值；超过 cap 时为「≥ cap 的下界」。 */
  value: number;
  /** true 表示触达封顶，只是近似值。 */
  approximate: boolean;
}

/**
 * 封顶计数：外层 COUNT 包住带 LIMIT 的子查询，扫描在 LIMIT 处提前终止，
 * 最坏只扫 cap+1 行；fromWhereSql 形如 "FROM t x WHERE x.col=?"（条件必须能走索引）。
 */
export function cappedCount(
  db: AppDatabase,
  fromWhereSql: string,
  params: readonly (string | number)[] = [],
  cap: number = DEFAULT_COUNT_CAP,
): CappedCountResult {
  const row = db.prepare(`SELECT COUNT(*) AS v FROM (SELECT 1 ${fromWhereSql} LIMIT ?)`).get(...params, cap + 1) as { v: number | bigint };
  const value = Number(row?.v ?? 0);
  return { value, approximate: value > cap };
}

/** MAX(rowid) 表行数估算：b-tree 最右键定位，常数时间。 */
export function estimateTableCount(db: AppDatabase, table: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS v FROM "${table}"`).get() as { v: number | bigint };
  return Number(row?.v ?? 0);
}
