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

import { getSystemSettings } from "./settings"
import type { DomainMirrorConfig, DomainMirrorGroup, DomainMirrorMap, DomainMirrorTarget, RequestMirrorRule, RequestMirrorRuleGroup, RequestMirrorSource } from "./settings"
import { getDatabase } from "./db"
import { createHash } from "node:crypto"

let cachedMirrorMap: DomainMirrorMap | null = null
let cachedMirrorGroups: DomainMirrorGroup[] = []
let cacheExpiry = 0
const CACHE_TTL_MS = 10_000
const mirrorCacheGlobal = globalThis as typeof globalThis & { __invalidateDomainMirrorCache?: () => void }

function getMirrorMap(): DomainMirrorMap {
  const now = Date.now()
  if (cachedMirrorMap !== null && now < cacheExpiry) return cachedMirrorMap
  try {
    const settings = getSystemSettings(getDatabase())
    cachedMirrorMap = settings.domainMirrorMap ?? {}
    cachedMirrorGroups = settings.domainMirrorGroups ?? []
  } catch {
    cachedMirrorMap = {}
    cachedMirrorGroups = []
  }
  cacheExpiry = now + CACHE_TTL_MS
  return cachedMirrorMap
}

// Invalidate the mirror map cache — call after settings are updated.
export function invalidateMirrorCache(): void {
  cachedMirrorMap = null
  cachedMirrorGroups = []
  cacheExpiry = 0
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
  name?: string | null
  email?: string | null
  workspaceId?: string | null
  externalId?: string | null
  poolType?: string | null
}

export interface MirrorSelectionContext {
  account?: MirrorSelectionAccount | null
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
  const parsed = new URL(originalUrl)
  const mirror = new URL(target.url.replaceAll("$host", parsed.host))
  parsed.protocol = mirror.protocol
  parsed.host = mirror.host
  if (mirror.pathname && mirror.pathname !== "/") parsed.pathname = mirror.pathname.replace(/\/$/, "") + parsed.pathname
  return parsed.toString()
}

export function resolveMirrorUrlForContext(originalUrl: string, context: MirrorSelectionContext = {}): string {
  const mirrorMap = getMirrorMap()
  if ((!mirrorMap || Object.keys(mirrorMap).length === 0) && cachedMirrorGroups.length === 0) return originalUrl
  try {
    const parsed = new URL(originalUrl)
    const hostname = parsed.hostname.toLowerCase()
    const accountId = context.account?.id
    const group = selectDomainMirrorGroup(cachedMirrorGroups, hostname, accountId)
    if (group) {
      const selected = selectMirrorGroupTarget(group, { ...context, shardKey: context.shardKey || accountId || hostname })
      if (selected) return applyMirrorTarget(parsed.toString(), selected)
    }
    const config = mirrorMap[hostname]
    if (!config) return originalUrl
    const selected = selectDomainMirror(config, { ...context, shardKey: context.shardKey || context.account?.id || hostname })
    if (!selected) return originalUrl
    return applyMirrorTarget(parsed.toString(), selected)
  } catch {
    return originalUrl
  }
}

// Drop-in replacement for global fetch — resolves mirrors then delegates.
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return apiFetchWithMirrorContext(input, init)
}

export function apiFetchWithMirrorContext(input: string | URL | Request, init?: RequestInit, context: MirrorSelectionContext = {}): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const resolved = resolveMirrorUrlForContext(url, context)
  if (typeof input === "string" || input instanceof URL) {
    return fetch(resolved, init as RequestInit)
  }
  // Request object — need to reconstruct with resolved URL
  return fetch(new Request(resolved, input), init as RequestInit)
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
