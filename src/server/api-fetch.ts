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
import type { DomainMirrorConfig, DomainMirrorMap, DomainMirrorTarget } from "./settings"
import { getDatabase } from "./db"
import { createHash } from "node:crypto"

let cachedMirrorMap: DomainMirrorMap | null = null
let cacheExpiry = 0
const CACHE_TTL_MS = 10_000
const mirrorCacheGlobal = globalThis as typeof globalThis & { __invalidateDomainMirrorCache?: () => void }

function getMirrorMap(): DomainMirrorMap {
  const now = Date.now()
  if (cachedMirrorMap !== null && now < cacheExpiry) return cachedMirrorMap
  try {
    const settings = getSystemSettings(getDatabase())
    cachedMirrorMap = settings.domainMirrorMap ?? {}
  } catch {
    cachedMirrorMap = {}
  }
  cacheExpiry = now + CACHE_TTL_MS
  return cachedMirrorMap
}

// Invalidate the mirror map cache — call after settings are updated.
export function invalidateMirrorCache(): void {
  cachedMirrorMap = null
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
}

function enabledMirrors(config: DomainMirrorConfig): DomainMirrorTarget[] {
  return config.mirrors.filter((mirror) => mirror.enabled !== false)
}

export function selectDomainMirror(config: DomainMirrorConfig, context: MirrorSelectionContext = {}): DomainMirrorTarget | null {
  const enabled = enabledMirrors(config)
  if (!enabled.length) return null
  const byId = new Map(enabled.map((mirror) => [mirror.id, mirror]))

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

export function applyMirrorTarget(originalUrl: string, target: DomainMirrorTarget): string {
  const parsed = new URL(originalUrl)
  const mirror = new URL(target.url)
  parsed.protocol = mirror.protocol
  parsed.host = mirror.host
  if (mirror.pathname && mirror.pathname !== "/") parsed.pathname = mirror.pathname.replace(/\/$/, "") + parsed.pathname
  return parsed.toString()
}

export function resolveMirrorUrlForContext(originalUrl: string, context: MirrorSelectionContext = {}): string {
  const mirrorMap = getMirrorMap()
  if (!mirrorMap || Object.keys(mirrorMap).length === 0) return originalUrl
  try {
    const parsed = new URL(originalUrl)
    const hostname = parsed.hostname.toLowerCase()
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
