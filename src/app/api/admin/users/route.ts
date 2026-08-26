import { z } from "zod";
import { getAuthService } from "@/server/auth";
import { getDatabase } from "@/server/db";
import { requireAdministrator } from "../_auth";
import { cachedCount } from "@/server/lightweight-count";
export const runtime = "nodejs";
const schema = z.object({ username: z.string().trim().min(3).max(64), displayName: z.string().trim().max(100).optional(), password: z.string().min(6).max(256), role: z.enum(["ADMIN", "USER"]).default("USER") });
export function GET(request: Request) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const db = getDatabase(); const users = getAuthService().listUsers(actor.id);
  // 双 LEFT JOIN 的 COUNT(DISTINCT) 会先做笛卡尔积再聚合，随账号/请求量增长失控；
  // 改相关封顶子查询（每用户各扫 ≤1000 行，走 owner 索引）+ 60s TTL 缓存。
  const stats = cachedCount("admin-user-stats", () => db.prepare(`SELECT u.id,(SELECT COUNT(*) FROM (SELECT 1 FROM accounts a WHERE a.owner_user_id=u.id LIMIT 1001)) AS accountCount,(SELECT COUNT(*) FROM (SELECT 1 FROM api_keys k WHERE k.owner_user_id=u.id LIMIT 1001)) AS apiKeyCount FROM users u`).all() as Array<{id:string;accountCount:number;apiKeyCount:number}>);
  const sharingRows = db.prepare(`SELECT u.id, u.share_admin_pool_enabled, s.pool_type FROM users u LEFT JOIN user_shared_pools s ON s.user_id = u.id`).all() as Array<{id:string;share_admin_pool_enabled:number;pool_type:string|null}>;
  const sharingByUser = new Map<string, { enabled: boolean; poolTypes: string[] }>();
  for (const row of sharingRows) {
    let entry = sharingByUser.get(row.id);
    if (!entry) { entry = { enabled: Number(row.share_admin_pool_enabled) === 1, poolTypes: [] }; sharingByUser.set(row.id, entry); }
    if (row.pool_type) entry.poolTypes.push(row.pool_type);
  }
  return Response.json({ users: users.map((user) => ({ ...user, ...stats.find((item) => item.id === user.id), sharing: sharingByUser.get(user.id) ?? { enabled: false, poolTypes: [] } })) });
}
export async function POST(request: Request) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const input = schema.safeParse(await request.json().catch(() => null)); if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查用户信息", details: input.error.flatten() } }, { status: 400 });
  try { return Response.json({ user: getAuthService().createUser(actor.id, input.data) }, { status: 201 }); } catch (cause) { return Response.json({ error: { type: "create_failed", message: cause instanceof Error ? cause.message : "创建失败" } }, { status: 409 }); }
}
