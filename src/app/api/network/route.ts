import { getDatabase } from "@/server/db";
import { AccountRepository } from "@/server/repository";
import { getMirrorGroupsForOwner, invalidateMirrorCacheForOwner } from "@/server/api-fetch";
import { validateDomainMirrorGroups, type DomainMirrorGroup } from "@/server/settings";
import { listPoolTypeLabelMap } from "@/server/pool-type-options";
import { requireSession } from "../admin/_auth";

export const runtime = "nodejs";

export function GET(request: Request) {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const db = getDatabase();
  const labels = listPoolTypeLabelMap(user.id, db);
  const accounts = new AccountRepository(user.id, db).list().map((account) => ({
    id: account.id,
    name: account.name,
    email: account.email,
    poolType: account.poolType,
    poolLabel: labels.get(account.poolType) ?? null,
    workspaceId: account.workspaceId,
  }));
  return Response.json({ groups: getMirrorGroupsForOwner(user.id), accounts });
}

export async function PUT(request: Request) {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const db = getDatabase();

  const body = await request.json().catch(() => null) as { groups?: unknown } | null;
  if (!body || !Array.isArray(body.groups)) {
    return Response.json({ error: { type: "validation_error", message: "请求体必须包含 groups 数组" } }, { status: 400 });
  }

  let groups: DomainMirrorGroup[];
  try {
    groups = validateDomainMirrorGroups(body.groups as DomainMirrorGroup[]);
  } catch (cause) {
    return Response.json({ error: { type: "validation_error", message: cause instanceof Error ? cause.message : "镜像组配置非法" } }, { status: 400 });
  }

  // accountIds 越权校验：只能引用本人账号（共享的管理员账号不进入他人镜像组绑定）。
  const ownIds = new Set(new AccountRepository(user.id, db).list().map((account) => account.id));
  for (const group of groups) {
    for (const accountId of group.accountIds) {
      if (!ownIds.has(accountId)) {
        return Response.json({ error: { type: "validation_error", message: `镜像组 ${group.name || group.id} 引用了非本人账号` } }, { status: 422 });
      }
    }
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM user_mirror_groups WHERE owner_user_id = ?").run(user.id);
    const insert = db.prepare(`INSERT INTO user_mirror_groups(id, owner_user_id, name, enabled, domains_json, account_ids_json, mirrors_json, rules_json, request_rules_json, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const group of groups) {
      insert.run(group.id, user.id, group.name, group.enabled ? 1 : 0,
        JSON.stringify(group.domains), JSON.stringify(group.accountIds),
        JSON.stringify(group.mirrors), JSON.stringify(group.rules),
        group.requestRules ? JSON.stringify(group.requestRules) : null, now, now);
    }
  })();
  invalidateMirrorCacheForOwner(user.id);

  return Response.json({ groups: getMirrorGroupsForOwner(user.id) });
}
