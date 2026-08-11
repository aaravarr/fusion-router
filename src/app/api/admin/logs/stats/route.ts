import { getDatabase } from "@/server/db";
import { getLogSettings } from "@/server/settings";
import { requireAdministrator } from "../../_auth";

export const runtime = "nodejs";

/** 日志磁盘占用统计：给「是否保存请求体」的决策提供依据。 */
export function GET(request: Request): Response {
  const user = requireAdministrator(request);
  if (user instanceof Response) return user;
  const db = getDatabase();
  const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count ?? 0);
  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size ?? 0);
  // 直接聚合写入时算好的 body_bytes 整数列（毫秒级）；
  // 不要改成 SUM(LENGTH(...)) —— 对超大 JSON 全表扫描会阻塞事件循环几十秒（3.2GB 库实测 55s）。
  const bodies = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(body_bytes), 0) AS bytes
       FROM request_bodies`,
    )
    .get() as { count: number; bytes: number };
  const unmeasured = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM request_bodies WHERE body_bytes = 0").get() as { n: number }).n ?? 0,
  );
  const requests = Number((db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get() as { value: number }).value ?? 0);
  const settings = getLogSettings(db);
  return Response.json({
    dbFileBytes: pageCount * pageSize,
    bodies: { count: bodies.count, bytes: bodies.bytes },
    unmeasuredRows: unmeasured,
    requests,
    retentionDays: settings.logRetentionDays,
    logBodies: settings.logBodies,
    logBodiesOnError: settings.logBodiesOnError,
  });
}
