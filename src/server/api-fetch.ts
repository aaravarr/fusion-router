// Unified HTTP fetch with domain-level mirror interception.
//
// Callers use `apiFetch(url, init)` exactly like `fetch()`. The interceptor
// looks up the request URL's hostname in the global domain-mirror map
// (system_settings → domain_mirror_map) and, if a mirror is configured for
// that hostname, transparently swaps the host+protocol before calling the
// real `fetch`. Path, query string, and all headers are preserved.
//
// This means provider/gateway code never needs to know about mirrors —
// they just fetch the original upstream URL and the interceptor handles
// routing through whatever proxy/mirror the operator has configured.

import type { DomainMirrorConfig, DomainMirrorGroup, DomainMirrorRule, DomainMirrorTarget, RequestMirrorRule, RequestMirrorRuleGroup, RequestMirrorSource } from "./settings"
import { getDatabase } from "./db"
import { createHash } from "node:crypto"
import { ProxyAgent } from "undici"

// undici dispatcher 不在标准 RequestInit 类型里；Node 全局 fetch 即 undici，运行时接受该字段。
type FetchInit = RequestInit & { dispatcher?: import("undici").Dispatcher }

// ProxyAgent 连接池按代理地址复用：同一 proxyUrl 全进程共享一个实例，避免每请求新建连接池。
// 实例不主动 close——代理配置长期有效，进程退出时随全局 agent 一起回收。
const proxyAgents = new Map<string, ProxyAgent>()

/** 取某代理地址的共享 ProxyAgent（支持 http/https/socks5/socks，undici 原生）。 */
export function getProxyDispatcher(proxyUrl: string): ProxyAgent {
  let agent = proxyAgents.get(proxyUrl)
  if (!agent) {
    // bodyTimeout: 0 关闭 undici 默认 300s 响应体超时：SSE 长流（如 reasoning 模型长时间思考）
    // 可能数分钟无字节，网关做流式转发必须容忍；headersTimeout 保持默认即可。
    // connections/pipelining 不压小——基准实测 undici 7.28 默认（无上限）并发流性能最优。
    agent = new ProxyAgent({ uri: proxyUrl, bodyTimeout: 0 })
    proxyAgents.set(proxyUrl, agent)
  }
  return agent
}

type Row = Record<string, unknown>

const CACHE_TTL_MS = 10_000
const cachedGroupsByOwner = new Map<string, { groups: DomainMirrorGroup[]; expiry: number }>()
const mirrorCacheGlobal = globalThis as typeof globalThis & { __invalidateDomainMirrorCache?: () => void }

function rowsToGroups(rows: Row[]): DomainMirrorGroup[] {
  const groups: DomainMirrorGroup[] = []
  for (const row of rows) {
    try {
      groups.push({
        id: String(row.id),
        name: String(row.name),
        enabled: Boolean(row.enabled),
        domains: JSON.parse(String(row.domains_json)) as string[],
        accountIds: JSON.parse(String(row.account_ids_json)) as string[],
        mirrors: JSON.parse(String(row.mirrors_json)) as DomainMirrorTarget[],
        rules: JSON.parse(String(row.rules_json)) as DomainMirrorRule[],
        requestRules: row.request_rules_json ? (JSON.parse(String(row.request_rules_json)) as RequestMirrorRuleGroup[]) : undefined,
      })
    } catch { /* 跳过损坏行 */ }
  }
  return groups
}

/** 读取某用户自己的镜像组（按 owner_user_id 隔离，TTL 缓存）。 */
export function getMirrorGroupsForOwner(ownerUserId: string): DomainMirrorGroup[] {
  if (!ownerUserId) return []
  const now = Date.now()
  const cached = cachedGroupsByOwner.get(ownerUserId)
  if (cached && now < cached.expiry) return cached.groups
  let groups: DomainMirrorGroup[] = []
  try {
    const rows = getDatabase().prepare(
      "SELECT id, name, enabled, domains_json, account_ids_json, mirrors_json, rules_json, request_rules_json FROM user_mirror_groups WHERE owner_user_id = ? AND enabled = 1 ORDER BY created_at",
    ).all(ownerUserId) as Row[]
    groups = rowsToGroups(rows)
  } catch { groups = [] }
  cachedGroupsByOwner.set(ownerUserId, { groups, expiry: now + CACHE_TTL_MS })
  return groups
}

/** 无主上下文回退：首个 ADMIN 的镜像组（即历史系统级出口策略）。 */
export function getSystemFallbackGroups(): DomainMirrorGroup[] {
  try {
    const admin = getDatabase().prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined
    return admin ? getMirrorGroupsForOwner(admin.id) : []
  } catch { return [] }
}

/** 失效某用户的镜像组缓存（写成功后调用，即时生效）。 */
export function invalidateMirrorCacheForOwner(ownerUserId: string): void {
  cachedGroupsByOwner.delete(ownerUserId)
}

// 全量失效（保留给旧 settings 调用点做兼容）。
export function invalidateMirrorCache(): void {
  cachedGroupsByOwner.clear()
}
mirrorCacheGlobal.__invalidateDomainMirrorCache = invalidateMirrorCache

// Resolve a URL through the domain mirror map. If the URL's hostname
// matches a configured mirror entry, returns the rewritten URL; otherwise
// returns the original URL unchanged.
export function resolveMirrorUrl(originalUrl: string): string {
  return resolveMirrorUrlForContext(originalUrl)
}

export interface MirrorSelectionAccount {
  id: string
  ownerUserId?: string | null
  name?: string | null
  email?: string | null
  workspaceId?: string | null
  externalId?: string | null
  poolType?: string | null
}

export interface MirrorSelectionContext {
  account?: MirrorSelectionAccount | null
  /** 显式指定镜像组归属用户（第 1 级优先级）。 */
  ownerUserId?: string | null
  shardKey?: string | null
  /** 已解析的请求体 JSON（可选，用于请求规则匹配） */
  body?: unknown
  /** 请求头（可选，用于请求规则匹配） */
  headers?: Headers | null
}

function enabledMirrors(config: DomainMirrorConfig): DomainMirrorTarget[] {
  return config.mirrors.filter((mirror) => mirror.enabled !== false)
}

export function selectDomainMirror(config: DomainMirrorConfig, context: MirrorSelectionContext = {}): DomainMirrorTarget | null {
  const enabled = enabledMirrors(config)
  if (!enabled.length) return null
  const byId = new Map(enabled.map((mirror) => [mirror.id, mirror]))

  // 请求规则优先：按请求体/请求头规则选择镜像，未命中再回退账号规则/hash 分片。
  const requestMirrorId = evaluateRequestRuleGroups(context, config.requestRules ?? [], new Set(enabled.map((mirror) => mirror.id)))
  if (requestMirrorId) {
    const assigned = byId.get(requestMirrorId)
    if (assigned) return assigned
  }

  const account = context.account
  if (account) {
    const assigned = byId.get(config.accountAssignments[account.id])
    if (assigned) return assigned
    const subject = [account.id, account.name, account.email, account.workspaceId, account.externalId, account.poolType].filter(Boolean).join("\n").slice(0, 2048)
    for (const rule of config.rules) {
      if (!rule.enabled) continue
      const mirror = byId.get(rule.mirrorId)
      if (!mirror) continue
      try { if (new RegExp(rule.pattern).test(subject)) return mirror } catch { /* validated on write */ }
    }
  }

  const shardKey = context.shardKey || account?.id || "default"
  const value = Number.parseInt(createHash("sha256").update(shardKey).digest("hex").slice(0, 8), 16)
  return enabled[value % enabled.length]
}

export function selectMirrorGroupTarget(group: DomainMirrorGroup, context: MirrorSelectionContext = {}): DomainMirrorTarget | null {
  return selectDomainMirror({ mirrors: group.mirrors, rules: group.rules, accountAssignments: {}, requestRules: group.requestRules }, context)
}

export function selectDomainMirrorGroup(groups: DomainMirrorGroup[], hostname: string, accountId?: string): DomainMirrorGroup | null {
  const eligible = groups.filter((group) => group.enabled !== false && group.domains.includes(hostname))
  return (accountId ? eligible.find((group) => group.accountIds.includes(accountId)) : undefined)
    ?? eligible.find((group) => group.accountIds.length === 0)
    ?? null
}

export function applyMirrorTarget(originalUrl: string, target: DomainMirrorTarget): string {
  // 只配代理、不配镜像地址的节点：不做 URL 替换，请求经代理直达原始上游 host。
  if (!target.url) return originalUrl
  const parsed = new URL(originalUrl)
  const mirror = new URL(target.url.replaceAll("$host", parsed.host))
  parsed.protocol = mirror.protocol
  parsed.host = mirror.host
  if (mirror.pathname && mirror.pathname !== "/") parsed.pathname = mirror.pathname.replace(/\/$/, "") + parsed.pathname
  return parsed.toString()
}

/** 镜像解析结果：重写后的 URL + 可选的上游代理地址（选中节点配置了 proxyUrl 时携带）。 */
export interface MirrorFetchPlan {
  url: string
  proxyUrl?: string
}

export function resolveMirrorPlanForContext(originalUrl: string, context: MirrorSelectionContext = {}): MirrorFetchPlan {
  try {
    const parsed = new URL(originalUrl)
    const owner = context.ownerUserId ?? context.account?.ownerUserId ?? null
    const groups = owner ? getMirrorGroupsForOwner(owner) : getSystemFallbackGroups()
    if (groups.length === 0) return { url: originalUrl }
    const hostname = parsed.hostname.toLowerCase()
    const accountId = context.account?.id
    const group = selectDomainMirrorGroup(groups, hostname, accountId)
    if (group) {
      const selected = selectMirrorGroupTarget(group, { ...context, shardKey: context.shardKey || accountId || hostname })
      if (selected) {
        const url = applyMirrorTarget(parsed.toString(), selected)
        return selected.proxyUrl ? { url, proxyUrl: selected.proxyUrl } : { url }
      }
    }
    return { url: originalUrl }
  } catch {
    return { url: originalUrl }
  }
}

export function resolveMirrorUrlForContext(originalUrl: string, context: MirrorSelectionContext = {}): string {
  return resolveMirrorPlanForContext(originalUrl, context).url
}

// Drop-in replacement for global fetch — resolves mirrors then delegates.
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return apiFetchWithMirrorContext(input, init)
}

export function apiFetchWithMirrorContext(input: string | URL | Request, init?: RequestInit, context: MirrorSelectionContext = {}): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const plan = resolveMirrorPlanForContext(url, context)
  const finalInit: FetchInit = { ...init }
  if (plan.proxyUrl) finalInit.dispatcher = getProxyDispatcher(plan.proxyUrl)
  if (typeof input === "string" || input instanceof URL) {
    return fetch(plan.url, finalInit as RequestInit)
  }
  // Request object — need to reconstruct with resolved URL
  return fetch(new Request(plan.url, input), finalInit as RequestInit)
}
/** 归一化请求字段路径：支持点路径 a.b；body['model'] / body.model 归一化为 model。 */
function normalizeRequestFieldPath(path: string): string {
  let value = path.trim()
  if (!value) return ""
  const bracket = /^body\s*\[(['"])(.*?)\1\]$/.exec(value)
  if (bracket) return bracket[2]
  if (value.startsWith("body.")) value = value.slice("body.".length)
  if (value === "body") return ""
  return value
}

/**
 * 从请求上下文取字段值：
 * - body：context.body 为对象时按点路径取值，取到转字符串；
 * - header：context.headers 存在时 headers.get(field)。
 * 找不到返回 null。
 */
export function resolveMirrorField(context: MirrorSelectionContext, source: RequestMirrorSource, field: string): string | null {
  if (source === "header") {
    if (!context.headers) return null
    const value = context.headers.get(field)
    return value == null ? null : value
  }
  if (context.body === null || context.body === undefined || typeof context.body !== "object") return null
  const path = normalizeRequestFieldPath(field)
  if (!path) return null
  let current: unknown = context.body
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return null
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === null || current === undefined) return null
  return typeof current === "string" ? current : JSON.stringify(current)
}

/** 单条请求规则匹配（equals/notEquals/contains 均大小写不敏感）。 */
export function matchRequestMirrorRule(context: MirrorSelectionContext, rule: RequestMirrorRule): boolean {
  const value = resolveMirrorField(context, rule.source, rule.field)
  if (value === null) return false
  const v = value.toLowerCase()
  const target = rule.value.toLowerCase()
  switch (rule.operator) {
    case "equals": return v === target
    case "notEquals": return v !== target
    case "contains": return v.includes(target)
    case "startsWith": return v.startsWith(target)
    default: return false
  }
}

/** 评估请求规则组：返回命中的镜像 id 或 null（顺序即优先级，第一个命中的生效）。 */
export function evaluateRequestRuleGroups(
  context: MirrorSelectionContext,
  requestRules: RequestMirrorRuleGroup[],
  mirrorIds: Set<string>,
): string | null {
  for (const group of requestRules) {
    if (group.enabled === false) continue
    const enabledRules = group.rules.filter((rule) => rule.enabled !== false)
    if (!enabledRules.length) continue
    const hit = group.condition === "and"
      ? enabledRules.every((rule) => matchRequestMirrorRule(context, rule))
      : enabledRules.some((rule) => matchRequestMirrorRule(context, rule))
    if (hit && mirrorIds.has(group.mirrorId)) return group.mirrorId
  }
  return null
}
