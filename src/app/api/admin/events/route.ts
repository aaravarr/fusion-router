 import { getDatabase } from "@/server/db";
 import { listPoolTypeOptions } from "@/server/pool-type-options";
 import { requireSession } from "../_auth";
 
 export const runtime = "nodejs";
 
 interface EventRow {
   id: string;
   type: string;
   severity: string;
   account_id: string | null;
   account_name: string | null;
   request_id: string | null;
   metadata_json: string;
   created_at: string;
 }
 
 const MESSAGE_BY_TYPE: Record<string, string> = {
   ACCOUNT_QUOTA_BLOCKED: "额度耗尽，已切换服务账号",
   GO_QUOTA_BLOCKED: "额度耗尽，已切换服务账号",
   ROUTING_PREFERENCE_CHANGED: "优先账号已变更",
   ROUTING_ACCOUNT_SELECTED: "已选择服务账号",
   ACCOUNT_CONNECTED: "账号已连接",
   ACCOUNT_REAUTH_REQUIRED: "账号需要重新登录",
   ACCOUNT_USAGE_SYNCED: "额度已同步",
   ACCOUNT_DISABLED: "账号已停用",
   ACCOUNT_ENABLED: "账号已启用",
 };
 
 function humanize(type: string, metadata: Record<string, unknown>): { message: string; detail: string | null } {
   const message = MESSAGE_BY_TYPE[type] ?? type.replace(/_/g, " ").toLowerCase();
   const parts: string[] = [];
   if (metadata.apiKeyName) parts.push(`密钥 ${String(metadata.apiKeyName)}`);
   if (metadata.accountEmail) parts.push(`邮箱 ${String(metadata.accountEmail)}`);
   if (metadata.accountName) parts.push(`账号 ${String(metadata.accountName)}`);
   if (metadata.workspaceId) parts.push(`workspace ${String(metadata.workspaceId)}`);
   if (metadata.kind) parts.push(`窗口 ${String(metadata.kind)}`);
   if (metadata.resetAt) parts.push(`预计恢复 ${String(metadata.resetAt)}`);
   if (metadata.retryAfterSeconds != null) parts.push(`${metadata.retryAfterSeconds} 秒后重试`);
   if (metadata.preferredAccountId) parts.push(`优先账号 ${String(metadata.preferredAccountId)}`);
   if (metadata.reason) parts.push(String(metadata.reason));
   if (metadata.error) parts.push(String(metadata.error));
   if (metadata.message) parts.push(String(metadata.message));
   return { message, detail: parts.length ? parts.join(" · ") : null };
 }
 
 export function GET(request: Request): Response {
   const user = requireSession(request);
   if (user instanceof Response) return user;
   const url = new URL(request.url);
   const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
   const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? "50") || 50));
   const db = getDatabase();
   const total = Number((db.prepare("SELECT COUNT(*) AS value FROM events WHERE owner_user_id=?").get(user.id) as { value: number }).value);
   const rows = db.prepare("SELECT e.id,e.type,e.severity,e.account_id,a.name AS account_name,e.request_id,e.metadata_json,e.created_at FROM events e LEFT JOIN accounts a ON a.id=e.account_id WHERE e.owner_user_id=? ORDER BY e.created_at DESC LIMIT ? OFFSET ?").all(user.id, pageSize, (page - 1) * pageSize) as EventRow[];
   const items = rows.map((row) => {
     let metadata: Record<string, unknown> = {};
     try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown> } catch { metadata = {} }
     const { message, detail } = humanize(row.type, metadata);
     return {
       id: row.id,
       createdAt: row.created_at,
       type: row.type,
       level: row.severity,
       accountId: row.account_id,
       accountName: row.account_name,
       requestId: row.request_id,
       message,
       detail,
       metadata,
     };
   });
   return Response.json({ items, total, page, pageSize, poolTypes: listPoolTypeOptions(user.id, db) });
 }
