import { randomBytes } from "node:crypto";
import { getDatabase, type AppDatabase } from "./db";
import { SecretVault } from "./crypto";

export const SYSTEM_SETTING_KEYS = {
  upstreamRequestTimeoutMs: "upstream_request_timeout_ms",
  maxFailoverAttempts: "max_failover_attempts",
  maintenanceIntervalMs: "maintenance_interval_ms",
  maintenanceEnabled: "maintenance_enabled",
  refreshBatchLimit: "refresh_batch_limit",
  refreshConcurrency: "refresh_concurrency",
  mediaTtlHours: "media_ttl_hours",
  mediaMaxBytes: "media_max_bytes",
  loggingEnabled: "logging_enabled",
  logBodies: "log_bodies",
  logBodiesOnError: "log_bodies_on_error",
  logRetentionDays: "log_retention_days",
  maxBodyCaptureBytes: "max_body_capture_bytes",
} as const;

export const LOG_SETTING_KEYS = [
  SYSTEM_SETTING_KEYS.loggingEnabled,
  SYSTEM_SETTING_KEYS.logBodies,
  SYSTEM_SETTING_KEYS.logBodiesOnError,
  SYSTEM_SETTING_KEYS.logRetentionDays,
  SYSTEM_SETTING_KEYS.maxBodyCaptureBytes,
] as const;

export const SYSTEM_SECRET_KEYS = {
  apiKeyPepper: "api_key_pepper",
  cronSecret: "cron_secret",
} as const;

export type SystemSecretKey =
  (typeof SYSTEM_SECRET_KEYS)[keyof typeof SYSTEM_SECRET_KEYS];

export interface DomainMirrorTarget {
  id: string;
  name: string;
  /** 镜像地址（支持 $host 占位符）。与 proxyUrl 至少填一个；为空时请求经代理直连原始上游，不做 URL 替换。 */
  url: string;
  /** 系统代理地址（http/https/socks5，如 http://127.0.0.1:7890）。可选；配置后该节点的上游请求经此代理发出。 */
  proxyUrl?: string;
  enabled: boolean;
}

export interface DomainMirrorRule {
  id: string;
  pattern: string;
  mirrorId: string;
  enabled: boolean;
}

export type RequestMirrorSource = "body" | "header";
export type RequestMirrorOperator = "equals" | "notEquals" | "contains" | "startsWith";

export interface RequestMirrorRule {
  id: string;
  enabled: boolean;
  /** body=请求体字段；header=请求头字段 */
  source: RequestMirrorSource;
  /** 字段名，如 model / authorization */
  field: string;
  operator: RequestMirrorOperator;
  value: string;
}

export interface RequestMirrorRuleGroup {
  id: string;
  enabled: boolean;
  /** 命中该组时使用的镜像节点 id（必须在 mirrors 内） */
  mirrorId: string;
  /** 组内规则连接符 */
  condition: "and" | "or";
  rules: RequestMirrorRule[];
}

export interface DomainMirrorConfig {
  mirrors: DomainMirrorTarget[];
  accountAssignments: Record<string, string>;
  rules: DomainMirrorRule[];
  requestRules?: RequestMirrorRuleGroup[];
}

export type DomainMirrorMap = Record<string, DomainMirrorConfig>;

export interface DomainMirrorGroup {
  id: string;
  name: string;
  enabled: boolean;
  domains: string[];
  accountIds: string[];
  mirrors: DomainMirrorTarget[];
  rules: DomainMirrorRule[];
  requestRules?: RequestMirrorRuleGroup[];
}

export interface SystemSettings {
  upstreamRequestTimeoutMs: number;
  maxFailoverAttempts: number;
  maintenanceEnabled: boolean;
  maintenanceIntervalMs: number;
  refreshBatchLimit: number;
  refreshConcurrency: number;
  mediaTtlHours: number;
  mediaMaxBytes: number;
}

export interface UpdateSystemSettingsInput {
  upstreamRequestTimeoutMs?: number;
  maxFailoverAttempts?: number;
  maintenanceEnabled?: boolean;
  maintenanceIntervalMs?: number;
  refreshBatchLimit?: number;
  refreshConcurrency?: number;
  mediaTtlHours?: number;
  mediaMaxBytes?: number;
  loggingEnabled?: boolean;
  logBodies?: boolean;
  logBodiesOnError?: boolean;
  logRetentionDays?: number;
  maxBodyCaptureBytes?: number;
}

export interface LogSettings {
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
}

const defaults: SystemSettings & LogSettings = {
  upstreamRequestTimeoutMs: 120_000,
  maxFailoverAttempts: 12,
  maintenanceEnabled: true,
  maintenanceIntervalMs: 60_000,
  refreshBatchLimit: 25,
  refreshConcurrency: 3,
  mediaTtlHours: 12,
  mediaMaxBytes: 200 * 1024 * 1024,
  loggingEnabled: true,
  logBodies: false,
  logBodiesOnError: true,
  logRetentionDays: 7,
  maxBodyCaptureBytes: 1_048_576,
};

type SettingRow = { value_json: string; is_secret: number };

export function initializeSystemSettings(db: AppDatabase): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO system_settings(key, value_json, is_secret, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
 const vault = new SecretVault();
 db.transaction(() => {
    insert.run(
      SYSTEM_SETTING_KEYS.upstreamRequestTimeoutMs,
      JSON.stringify(defaults.upstreamRequestTimeoutMs),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.maxFailoverAttempts,
      JSON.stringify(defaults.maxFailoverAttempts),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.maintenanceIntervalMs,
      JSON.stringify(defaults.maintenanceIntervalMs),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.maintenanceEnabled,
      JSON.stringify(defaults.maintenanceEnabled),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.refreshBatchLimit,
      JSON.stringify(defaults.refreshBatchLimit),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.refreshConcurrency,
      JSON.stringify(defaults.refreshConcurrency),
      0,
      now,
    );
    insert.run(
      SYSTEM_SECRET_KEYS.apiKeyPepper,
      JSON.stringify(vault.encrypt(randomBytes(32).toString("base64url"))),
      1,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.mediaTtlHours,
      JSON.stringify(defaults.mediaTtlHours),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.mediaMaxBytes,
      JSON.stringify(defaults.mediaMaxBytes),
      0,
      now,
    );
    insert.run(
      SYSTEM_SECRET_KEYS.cronSecret,
      JSON.stringify(vault.encrypt(randomBytes(32).toString("base64url"))),
      1,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.loggingEnabled,
      JSON.stringify(defaults.loggingEnabled),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.logBodies,
      JSON.stringify(defaults.logBodies),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.logBodiesOnError,
      JSON.stringify(defaults.logBodiesOnError),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.logRetentionDays,
      JSON.stringify(defaults.logRetentionDays),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.maxBodyCaptureBytes,
      JSON.stringify(defaults.maxBodyCaptureBytes),
      0,
      now,
    );
  })();
}

export function getLogSettings(db: AppDatabase = getDatabase()): LogSettings {
  return {
    loggingEnabled: readPublic(db, SYSTEM_SETTING_KEYS.loggingEnabled, defaults.loggingEnabled),
    logBodies: readPublic(db, SYSTEM_SETTING_KEYS.logBodies, defaults.logBodies),
    logBodiesOnError: readPublic(db, SYSTEM_SETTING_KEYS.logBodiesOnError, defaults.logBodiesOnError),
    logRetentionDays: readPublic(db, SYSTEM_SETTING_KEYS.logRetentionDays, defaults.logRetentionDays),
    maxBodyCaptureBytes: readPublic(db, SYSTEM_SETTING_KEYS.maxBodyCaptureBytes, defaults.maxBodyCaptureBytes),
  };
}

export function getSystemSettings(
  db: AppDatabase = getDatabase(),
): SystemSettings {
  return {
    upstreamRequestTimeoutMs: readPublic(
      db,
      SYSTEM_SETTING_KEYS.upstreamRequestTimeoutMs,
      defaults.upstreamRequestTimeoutMs,
    ),
    maxFailoverAttempts: readPublic(
      db,
      SYSTEM_SETTING_KEYS.maxFailoverAttempts,
      defaults.maxFailoverAttempts,
    ),
    maintenanceEnabled: readPublic(
      db,
      SYSTEM_SETTING_KEYS.maintenanceEnabled,
      defaults.maintenanceEnabled,
    ),
    maintenanceIntervalMs: readPublic(
      db,
      SYSTEM_SETTING_KEYS.maintenanceIntervalMs,
      defaults.maintenanceIntervalMs,
    ),
    refreshBatchLimit: readPublic(
      db,
      SYSTEM_SETTING_KEYS.refreshBatchLimit,
      defaults.refreshBatchLimit,
    ),
    refreshConcurrency: readPublic(
      db,
      SYSTEM_SETTING_KEYS.refreshConcurrency,
      defaults.refreshConcurrency,
    ),
    mediaTtlHours: readPublic(db, SYSTEM_SETTING_KEYS.mediaTtlHours, defaults.mediaTtlHours),
    mediaMaxBytes: readPublic(db, SYSTEM_SETTING_KEYS.mediaMaxBytes, defaults.mediaMaxBytes),
  };
}

export function updateSystemSettings(
  input: UpdateSystemSettingsInput,
  updatedByUserId?: string | null,
  db: AppDatabase = getDatabase(),
): SystemSettings {
  const entries: [string, string][] = [];
  if (input.upstreamRequestTimeoutMs !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.upstreamRequestTimeoutMs,
      JSON.stringify(
        integerInRange(
          input.upstreamRequestTimeoutMs,
          1_000,
          600_000,
          "Request timeout",
        ),
      ),
    ]);
  }
  if (input.maxFailoverAttempts !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.maxFailoverAttempts,
      JSON.stringify(integerInRange(input.maxFailoverAttempts, 1, 32, "Max failover attempts")),
    ]);
  }
  if (input.maintenanceEnabled !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.maintenanceEnabled,
      JSON.stringify(input.maintenanceEnabled),
    ]);
  }
  if (input.maintenanceIntervalMs !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.maintenanceIntervalMs,
      JSON.stringify(
        integerInRange(
          input.maintenanceIntervalMs,
          10_000,
          86_400_000,
          "Maintenance interval",
        ),
      ),
    ]);
  }
  if (input.refreshBatchLimit !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.refreshBatchLimit,
      JSON.stringify(
        integerInRange(input.refreshBatchLimit, 1, 500, "Refresh batch limit"),
      ),
    ]);
  }
  if (input.refreshConcurrency !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.refreshConcurrency,
      JSON.stringify(
        integerInRange(input.refreshConcurrency, 1, 32, "Refresh concurrency"),
      ),
    ]);
  }
  if (input.loggingEnabled !== undefined) {
    entries.push([SYSTEM_SETTING_KEYS.loggingEnabled, JSON.stringify(input.loggingEnabled)]);
  }
  if (input.logBodies !== undefined) {
    entries.push([SYSTEM_SETTING_KEYS.logBodies, JSON.stringify(input.logBodies)]);
  }
  if (input.logBodiesOnError !== undefined) {
    entries.push([SYSTEM_SETTING_KEYS.logBodiesOnError, JSON.stringify(input.logBodiesOnError)]);
  }
  if (input.logRetentionDays !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.logRetentionDays,
      JSON.stringify(integerInRange(input.logRetentionDays, 1, 365, "Log retention days")),
    ]);
  }
  if (input.maxBodyCaptureBytes !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.maxBodyCaptureBytes,
      JSON.stringify(
        integerInRange(input.maxBodyCaptureBytes, 1024, 16_777_216, "Max body capture bytes"),
      ),
    ]);
  }
  const statement = db.prepare(
    `UPDATE system_settings SET value_json = ?, updated_by_user_id = ?, updated_at = ?
     WHERE key = ? AND is_secret = 0`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const [key, value] of entries)
      statement.run(value, updatedByUserId ?? null, now, key);
  })();
  // Avoid a settings <-> fetch module cycle while still applying mirror
  // changes immediately when the fetch layer has already initialized.
  const mirrorCacheGlobal = globalThis as typeof globalThis & { __invalidateDomainMirrorCache?: () => void };
  mirrorCacheGlobal.__invalidateDomainMirrorCache?.();
  return getSystemSettings(db);
}

export function validateMirrorUrl(value: string, label: string): void {
  try {
    const url = new URL(value.replaceAll("$host", "origin.example.com"))
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol")
    if (url.username || url.password) throw new Error("credentials")
  } catch {
    throw new Error(`${label} 的目标地址不是有效 URL`)
  }
}

/** 系统代理地址校验：协议限定 undici ProxyAgent 原生支持的 http/https/socks5/socks；允许内嵌凭据。 */
export function validateProxyUrl(value: string, label: string): void {
  try {
    const url = new URL(value)
    if (!["http:", "https:", "socks5:", "socks:"].includes(url.protocol)) throw new Error("protocol")
    if (!url.hostname) throw new Error("hostname")
  } catch {
    throw new Error(`${label} 的代理地址不是有效 URL（支持 http/https/socks5，如 http://127.0.0.1:7890）`)
  }
}

export function validateMirrorPattern(pattern: string, label: string): void {
  try { new RegExp(pattern) } catch { throw new Error(`${label} 包含无效正则: ${pattern}`) }
  if (pattern.length > 500 || /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new Error(`${label} 包含可能导致性能问题的正则: ${pattern}`)
}

/** 保存校验：完整校验一组镜像组（供 /api/network PUT 复用）。 */
export function validateDomainMirrorGroups(input: DomainMirrorGroup[]): DomainMirrorGroup[] {
  const groupIds = new Set<string>()
  return input.map((group) => {
    const id = group.id.trim()
    if (!id || groupIds.has(id)) throw new Error("镜像组 ID 为空或重复")
    groupIds.add(id)
    const mirrorIds = new Set<string>()
    const mirrors = group.mirrors.map((mirror) => {
      const mirrorId = mirror.id.trim()
      const urlValue = (mirror.url ?? "").trim().replace(/\/$/, "")
      const proxyUrl = (mirror.proxyUrl ?? "").trim().replace(/\/$/, "")
      if (!mirrorId || mirrorIds.has(mirrorId)) throw new Error(`镜像组 ${group.name || id} 的节点 ID 为空或重复`)
      mirrorIds.add(mirrorId)
      const label = `镜像组 ${group.name || id}/${mirror.name || mirrorId}`
      if (!urlValue && !proxyUrl) throw new Error(`${label} 的镜像地址与代理地址至少填一个`)
      if (urlValue) validateMirrorUrl(urlValue, label)
      if (proxyUrl) validateProxyUrl(proxyUrl, label)
      return { id: mirrorId, name: mirror.name.trim() || mirrorId, url: urlValue, ...(proxyUrl ? { proxyUrl } : {}), enabled: mirror.enabled !== false }
    })
    if (!mirrors.length) throw new Error(`镜像组 ${group.name || id} 至少需要一个镜像节点`)
    const domains = [...new Set(group.domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))]
    if (!domains.length) throw new Error(`镜像组 ${group.name || id} 至少需要一个原始域名`)
    const rules = group.rules.map((rule) => {
      if (!mirrorIds.has(rule.mirrorId)) throw new Error(`镜像组 ${group.name || id} 的规则引用了不存在的镜像`)
      validateMirrorPattern(rule.pattern, `镜像组 ${group.name || id}`)
      return { id: rule.id.trim(), pattern: rule.pattern, mirrorId: rule.mirrorId, enabled: rule.enabled !== false }
    })
    if (rules.some((rule) => !rule.id) || new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error(`镜像组 ${group.name || id} 的规则 ID 为空或重复`)
    const requestRules = validateRequestMirrorRuleGroups(group.requestRules ?? [], mirrorIds, `镜像组 ${group.name || id}`)
    return { id, name: group.name.trim() || id, enabled: group.enabled !== false, domains, accountIds: [...new Set(group.accountIds.filter(Boolean))], mirrors, rules, requestRules }
  })
}

export function normalizeDomainMirrorMap(value: unknown): DomainMirrorMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: DomainMirrorMap = {}
  for (const [domain, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim()) {
      result[domain.toLowerCase()] = { mirrors: [{ id: "legacy", name: "默认镜像", url: raw.trim().replace(/\/$/, ""), enabled: true }], accountAssignments: {}, rules: [], requestRules: [] }
      continue
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const config = raw as Partial<DomainMirrorConfig>
    const mirrors = Array.isArray(config.mirrors) ? config.mirrors.filter((item): item is DomainMirrorTarget => Boolean(item && typeof item.id === "string" && (typeof item.url === "string" || typeof item.proxyUrl === "string"))) : []
    if (!mirrors.length) continue
        const configMirrorIds = new Set(mirrors.map((item) => item.id))
    result[domain.toLowerCase()] = {
      mirrors: mirrors.map((item) => ({ id: item.id, name: typeof item.name === "string" ? item.name : item.id, url: typeof item.url === "string" ? item.url : "", ...(typeof item.proxyUrl === "string" && item.proxyUrl ? { proxyUrl: item.proxyUrl } : {}), enabled: item.enabled !== false })),
      accountAssignments: config.accountAssignments && typeof config.accountAssignments === "object" ? config.accountAssignments : {},
      rules: Array.isArray(config.rules) ? config.rules.filter((item): item is DomainMirrorRule => Boolean(item && typeof item.id === "string" && typeof item.pattern === "string" && typeof item.mirrorId === "string")) : [],
      requestRules: normalizeRequestMirrorRuleGroups(config.requestRules, configMirrorIds),
    }
  }
  return result
}

export function normalizeDomainMirrorGroups(value: unknown): DomainMirrorGroup[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
    const group = raw as Partial<DomainMirrorGroup>
    if (typeof group.id !== "string" || !group.id || !Array.isArray(group.domains) || !Array.isArray(group.mirrors)) return []
    const mirrors = group.mirrors.filter((item): item is DomainMirrorTarget => Boolean(item && typeof item.id === "string" && (typeof item.url === "string" || typeof item.proxyUrl === "string")))
    if (!mirrors.length) return []
        const groupMirrorIds = new Set(mirrors.map((item) => item.id))
    return [{
      id: group.id,
      name: typeof group.name === "string" ? group.name : group.id,
      enabled: group.enabled !== false,
      domains: group.domains.filter((domain): domain is string => typeof domain === "string").map((domain) => domain.toLowerCase()),
      accountIds: Array.isArray(group.accountIds) ? group.accountIds.filter((id): id is string => typeof id === "string") : [],
      mirrors: mirrors.map((item) => ({ id: item.id, name: typeof item.name === "string" ? item.name : item.id, url: typeof item.url === "string" ? item.url : "", ...(typeof item.proxyUrl === "string" && item.proxyUrl ? { proxyUrl: item.proxyUrl } : {}), enabled: item.enabled !== false })),
      rules: Array.isArray(group.rules) ? group.rules.filter((item): item is DomainMirrorRule => Boolean(item && typeof item.id === "string" && typeof item.pattern === "string" && typeof item.mirrorId === "string")) : [],
      requestRules: normalizeRequestMirrorRuleGroups(group.requestRules, groupMirrorIds),
    }]
  })
}

const REQUEST_MIRROR_SOURCES = new Set(["body", "header"])
const REQUEST_MIRROR_OPERATORS = new Set(["equals", "notEquals", "contains"])

function isRequestMirrorRule(value: unknown): value is RequestMirrorRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const rule = value as Partial<RequestMirrorRule>
  return typeof rule.id === "string" && rule.id.trim() !== ""
    && typeof rule.source === "string" && REQUEST_MIRROR_SOURCES.has(rule.source)
    && typeof rule.field === "string" && rule.field.trim() !== ""
    && typeof rule.operator === "string" && REQUEST_MIRROR_OPERATORS.has(rule.operator)
    && typeof rule.value === "string" && rule.value.trim() !== ""
}

/** 归一化请求规则组：只保留合法项，非法组/规则直接丢弃（不抛错）。 */
export function normalizeRequestMirrorRuleGroups(
  value: unknown,
  mirrorIds: ReadonlySet<string>,
): RequestMirrorRuleGroup[] {
  if (!Array.isArray(value)) return []
  const out: RequestMirrorRuleGroup[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const group = raw as Partial<RequestMirrorRuleGroup>
    if (typeof group.id !== "string" || !group.id.trim() || seen.has(group.id)) continue
    if (typeof group.mirrorId !== "string" || !mirrorIds.has(group.mirrorId)) continue
    if (group.condition !== "and" && group.condition !== "or") continue
    const ruleIds = new Set<string>()
    const validRules: RequestMirrorRule[] = []
    for (const item of Array.isArray(group.rules) ? group.rules : []) {
      if (!isRequestMirrorRule(item)) continue
      const id = item.id.trim()
      if (!id || ruleIds.has(id)) continue
      ruleIds.add(id)
      validRules.push({ ...item, id, field: item.field.trim(), value: item.value.trim(), enabled: item.enabled !== false })
    }
    if (!validRules.length) continue
    seen.add(group.id.trim())
    out.push({
      id: group.id.trim(),
      enabled: group.enabled !== false,
      mirrorId: group.mirrorId,
      condition: group.condition,
      rules: validRules,
    })
  }
  return out
}

/** 保存校验：非法配置直接抛中文错误。 */
export function validateRequestMirrorRuleGroups(
  groups: RequestMirrorRuleGroup[],
  mirrorIds: ReadonlySet<string>,
  label: string,
): RequestMirrorRuleGroup[] {
  const seen = new Set<string>()
  return groups.map((group) => {
    const id = group.id.trim()
    if (!id || seen.has(id)) throw new Error(label + ' 的请求规则组 ID 为空或重复')
    seen.add(id)
    if (!mirrorIds.has(group.mirrorId)) throw new Error(label + ' 的请求规则引用了不存在的镜像')
    if (group.condition !== "and" && group.condition !== "or") throw new Error(label + ' 的请求规则 condition 必须为 and 或 or')
    if (!Array.isArray(group.rules) || group.rules.length === 0) throw new Error(label + ' 的请求规则组至少需要一条规则')
    const ruleIds = new Set<string>()
    const rules = group.rules.map((rule) => {
      const rid = rule.id.trim()
      if (!rid || ruleIds.has(rid)) throw new Error(label + ' 的请求规则 ID 为空或重复')
      ruleIds.add(rid)
      if (!REQUEST_MIRROR_SOURCES.has(rule.source)) throw new Error(label + ' 的请求规则数据源不合法: ' + rule.source)
      if (!REQUEST_MIRROR_OPERATORS.has(rule.operator)) throw new Error(label + ' 的请求规则操作符不合法: ' + rule.operator)
      if (!rule.field.trim()) throw new Error(label + ' 的请求规则字段不能为空')
      if (!rule.value.trim()) throw new Error(label + ' 的请求规则内容不能为空')
      return { ...rule, id: rid, field: rule.field.trim(), value: rule.value.trim(), enabled: rule.enabled !== false }
    })
    return { ...group, id, condition: group.condition, rules }
  })
}
export function getSystemSecret(db: AppDatabase, key: SystemSecretKey): string {
  const row = db
    .prepare("SELECT value_json, is_secret FROM system_settings WHERE key = ?")
    .get(key) as SettingRow | undefined;
  if (!row || row.is_secret !== 1)
    throw new Error(`System secret is not initialized: ${key}`);
  const encrypted = JSON.parse(row.value_json);
  if (typeof encrypted !== "string")
    throw new Error(`System secret has invalid storage: ${key}`);
  return new SecretVault().decrypt(encrypted);
}

export function rotateSystemSecret(
  db: AppDatabase,
  key: SystemSecretKey,
  updatedByUserId?: string | null,
): string {
  const secret = randomBytes(32).toString("base64url");
  const encrypted = new SecretVault().encrypt(secret);
  const result = db
    .prepare(
      `UPDATE system_settings SET value_json = ?, updated_by_user_id = ?, updated_at = ?
       WHERE key = ? AND is_secret = 1`,
    )
    .run(
      JSON.stringify(encrypted),
      updatedByUserId ?? null,
      new Date().toISOString(),
      key,
    );
  if (result.changes !== 1)
    throw new Error(`System secret is not initialized: ${key}`);
  return secret;
}

export function getPublicSecretStatus(db: AppDatabase = getDatabase()) {
  const rows = db
    .prepare("SELECT key, updated_at FROM system_settings WHERE is_secret = 1")
    .all() as { key: string; updated_at: string }[];
  const status = Object.fromEntries(
    rows.map((row) => [
      row.key,
      { configured: true, updatedAt: row.updated_at },
    ]),
  );
  return {
    apiKeyPepper: status[SYSTEM_SECRET_KEYS.apiKeyPepper] ?? {
      configured: false,
      updatedAt: null,
    },
    cronSecret: status[SYSTEM_SECRET_KEYS.cronSecret] ?? {
      configured: false,
      updatedAt: null,
    },
  };
}

export function rotateInternalSecret(
  key: SystemSecretKey,
  updatedByUserId?: string | null,
  db: AppDatabase = getDatabase(),
): string {
  return rotateSystemSecret(db, key, updatedByUserId);
}

/**
 * Pepper rotation is intentionally destructive: old API key hashes can no
 * longer be verified, so every key is disabled atomically with the rotation.
 * The new pepper never leaves this helper.
 */
export function rotateApiKeyPepper(
  updatedByUserId?: string | null,
  db: AppDatabase = getDatabase(),
): number {
  return db
    .transaction(() => {
      rotateSystemSecret(db, SYSTEM_SECRET_KEYS.apiKeyPepper, updatedByUserId);
      const result = db
        .prepare(
          "UPDATE api_keys SET enabled = 0, updated_at = ? WHERE enabled = 1",
        )
        .run(new Date().toISOString());
      return result.changes;
    })
    .immediate();
}

function readPublic<T>(db: AppDatabase, key: string, fallback: T): T {
  const row = db
    .prepare("SELECT value_json, is_secret FROM system_settings WHERE key = ?")
    .get(key) as SettingRow | undefined;
  if (!row || row.is_secret !== 0) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

function integerInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${label} must be an integer between ${min} and ${max} milliseconds`,
    );
  }
  return value;
}
