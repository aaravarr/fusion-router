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
  const bodies = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(LENGTH(request_body_json)), 0)
              + COALESCE(SUM(LENGTH(response_body_json)), 0)
              + COALESCE(SUM(LENGTH(request_headers_json)), 0) AS bytes
       FROM request_bodies`,
    )
    .get() as { count: number; bytes: number };
  const requests = Number((db.prepare("SELECT COUNT(*) AS value FROM gateway_requests").get() as { value: number }).value ?? 0);
  const settings = getLogSettings(db);
  return Response.json({
    dbFileBytes: pageCount * pageSize,
    bodies: { count: bodies.count, bytes: bodies.bytes },
    requests,
    retentionDays: settings.logRetentionDays,
    logBodies: settings.logBodies,
    logBodiesOnError: settings.logBodiesOnError,
  });
}
