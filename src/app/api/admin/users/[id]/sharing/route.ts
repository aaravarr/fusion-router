import { z } from "zod";
import { getDatabase } from "@/server/db";
import { requireAdministrator } from "../../../_auth";

export const runtime = "nodejs";

const SHARABLE_POOL_TYPES = new Set(["opencode-go", "openai", "xai-grok", "kimi-code", "open-design-go", "custom:*"]);

const schema = z.object({
  enabled: z.boolean(),
  poolTypes: z.array(z.string()).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = requireAdministrator(request);
  if (actor instanceof Response) return actor;
  const { id } = await context.params;
  const db = getDatabase();

  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined;
  if (!user) return Response.json({ error: { type: "not_found", message: "用户不存在" } }, { status: 404 });

  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查共享配置", details: input.error.flatten() } }, { status: 400 });

  const enabled = input.data.enabled;
  const poolTypes = enabled ? [...new Set(input.data.poolTypes ?? [])] : [];
  for (const poolType of poolTypes) {
    if (!SHARABLE_POOL_TYPES.has(poolType)) {
      return Response.json({ error: { type: "validation_error", message: `非法的账号池类型: ${poolType}` } }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE users SET share_admin_pool_enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now, id);
    db.prepare("DELETE FROM user_shared_pools WHERE user_id = ?").run(id);
    const insert = db.prepare("INSERT INTO user_shared_pools(user_id, pool_type, created_at, updated_at) VALUES(?,?,?,?)");
    for (const poolType of poolTypes) insert.run(id, poolType, now, now);
  })();

  return Response.json({ sharing: { enabled, poolTypes } });
}
