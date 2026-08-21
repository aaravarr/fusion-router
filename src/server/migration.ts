import type { AppDatabase } from "./db"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getDataDirectory } from "./bootstrap"
import { normalizeDomainMirrorGroups, normalizeDomainMirrorMap, type DomainMirrorGroup } from "./settings"

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g

function escapeRegex(value: string): string {
  return value.replace(REGEX_ESCAPE, "\\$&")
}

export function ensureSharedPoolColumns(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("share_admin_pool_enabled")) db.exec("ALTER TABLE users ADD COLUMN share_admin_pool_enabled INTEGER NOT NULL DEFAULT 0")
}

function domainMirrorMapToGroups(value: unknown): DomainMirrorGroup[] {
  const map = normalizeDomainMirrorMap(value)
  return Object.entries(map).map(([domain, config]) => ({
    id: "legacy_group_" + domain.replace(/[^a-z0-9]+/g, "_"),
    name: domain,
    enabled: true,
    domains: [domain],
    accountIds: Object.keys(config.accountAssignments),
    mirrors: config.mirrors,
    rules: [
      ...Object.entries(config.accountAssignments).map(([accountId, mirrorId], index) => ({
        id: "legacy_assignment_" + index,
        pattern: "^" + escapeRegex(accountId) + "$",
        mirrorId,
        enabled: true,
      })),
      ...config.rules,
    ],
    requestRules: config.requestRules,
  }))
}

export function migrateLegacyMirrorAndUpstream(db: AppDatabase): void {
  const firstAdmin = db.prepare("SELECT id FROM users WHERE role='ADMIN' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined
  if (!firstAdmin) return
  const existing = db.prepare("SELECT 1 FROM user_mirror_groups WHERE owner_user_id = ? LIMIT 1").get(firstAdmin.id)
  if (existing) return

  const readSetting = (key: string): string | null => {
    const row = db.prepare("SELECT value_json FROM system_settings WHERE key = ?").get(key) as { value_json: string } | undefined
    return row ? row.value_json : null
  }
  const groupsRaw = readSetting("domain_mirror_groups")
  const mapRaw = readSetting("domain_mirror_map")
  const upstreamRaw = readSetting("opencode_upstream_base_url")

  if (db.name && db.name !== ":memory:") {
    try {
      const snapshot = {
        migratedAt: new Date().toISOString(),
        ownerUserId: firstAdmin.id,
        domain_mirror_groups: groupsRaw ? JSON.parse(groupsRaw) : null,
        domain_mirror_map: mapRaw ? JSON.parse(mapRaw) : null,
        opencode_upstream_base_url: upstreamRaw ? JSON.parse(upstreamRaw) : null,
      }
      const dir = getDataDirectory()
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "migration-backup-" + Date.now() + ".json"), JSON.stringify(snapshot, null, 2), { encoding: "utf8" })
    } catch { /* snapshot failure must not block migration */ }
  }

  const groups: DomainMirrorGroup[] = []
  if (groupsRaw) { try { groups.push(...normalizeDomainMirrorGroups(JSON.parse(groupsRaw))) } catch { /* ignore */ } }
  if (mapRaw) { try { groups.push(...domainMirrorMapToGroups(JSON.parse(mapRaw))) } catch { /* ignore */ } }
  if (upstreamRaw) {
    try {
      const upstream = JSON.parse(upstreamRaw) as string
      if (upstream && upstream !== "https://opencode.ai/zen/go/v1") {
        const origin = new URL(upstream).origin
        if (origin !== "https://opencode.ai") {
          groups.push({
            id: "legacy_upstream_group",
            name: "原上游地址（自动迁移）",
            enabled: true,
            domains: ["opencode.ai"],
            accountIds: [],
            mirrors: [{ id: "legacy_upstream", name: "原上游地址", url: origin, enabled: true }],
            rules: [],
          })
        }
      }
    } catch { /* ignore */ }
  }

  const seen = new Set<string>()
  const now = new Date().toISOString()
  const insert = db.prepare("INSERT INTO user_mirror_groups(id, owner_user_id, name, enabled, domains_json, account_ids_json, mirrors_json, rules_json, request_rules_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
  db.transaction(() => {
    for (const group of groups) {
      if (!group.id || seen.has(group.id)) continue
      seen.add(group.id)
      insert.run(group.id, firstAdmin.id, group.name, group.enabled !== false ? 1 : 0,
        JSON.stringify(group.domains ?? []), JSON.stringify(group.accountIds ?? []),
        JSON.stringify(group.mirrors ?? []), JSON.stringify(group.rules ?? []),
        group.requestRules ? JSON.stringify(group.requestRules) : null, now, now)
    }
    db.prepare("DELETE FROM system_settings WHERE key IN ('domain_mirror_groups','domain_mirror_map','opencode_upstream_base_url')").run()
  })()
}
