import { getDatabase } from "@/server/db";
import { getLogSettings } from "@/server/settings";
import { requireAdministrator } from "../../_auth";

export const runtime = "nodejs";

// 本接口必须保持 O(1)：better-sqlite3 是同步驱动，任何对大表（含 blob）的
// COUNT(*)/SUM() 全表扫描都会卡死整个 Node 事件循环（3.2GB 库实测 55s，
// 全站 API 连带堵死）。因此全部改用轻量近似口径：
// - 行数用 MAX(rowid) 估算（b-tree 最右键定位，常数时间；删除少时接近真实值）；
// - body 字节用量按最近 200 行采样均值 × 行数估算（ORDER BY rowid DESC 走索引下推）；
// - 库体积用 PRAGMA page_count * page_size；
// - 叠加 TTL 内存缓存防重复触发。所有数值均为近似值（payload.approximate = true）。
const STATS_CACHE_TTL_MS = 60_000;
const BODY_BYTES_SAMPLE_ROWS = 200;

let statsCache: { at: number; payload: Record<string, unknown> } | null = null;

/** 日志磁盘占用统计：给「是否保存请求体」的决策提供依据。 */
export function GET(request: Request): Response {
  const user = requireAdministrator(request);
  if (user instanceof Response) return user;
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_CACHE_TTL_MS) {
    return Response.json(statsCache.payload);
  }
  const db = getDatabase();
  const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count ?? 0);
  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size ?? 0);
  // MAX(rowid) 是常数时间；不要改成 COUNT(*) —— 全表扫描会同步阻塞事件循环。
  const requests = Number(
    (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS v FROM gateway_requests").get() as { v: number }).v ?? 0,
  );
  const bodiesCount = Number(
    (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS v FROM request_bodies").get() as { v: number }).v ?? 0,
  );
  // 只采样最近的行估算平均 body 大小，避免触碰历史大 blob。
  const sample = db
    .prepare(
      `SELECT AVG(body_bytes) AS avgBytes FROM (
         SELECT body_bytes FROM request_bodies ORDER BY rowid DESC LIMIT ?
       )`,
    )
    .get(BODY_BYTES_SAMPLE_ROWS) as { avgBytes: number | null };
  const bodiesBytes = Math.round((sample.avgBytes ?? 0) * bodiesCount);
  const settings = getLogSettings(db);
  const payload: Record<string, unknown> = {
    approximate: true,
    dbFileBytes: pageCount * pageSize,
    bodies: { count: bodiesCount, bytes: bodiesBytes },
    requests,
    retentionDays: settings.logRetentionDays,
    logBodies: settings.logBodies,
    logBodiesOnError: settings.logBodiesOnError,
  };
  statsCache = { at: now, payload };
  return Response.json(payload);
}
