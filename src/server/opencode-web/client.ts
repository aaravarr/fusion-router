import { isLoginPage, parseGoDashboard, parseGoKeys, type ParsedGoDashboard, type ParsedGoKey } from "./parser"

const BASE = "https://opencode.ai"
export const MANAGED_GO_KEY_NAME = "OpenCode to API"

export class OpenCodeWebError extends Error {
  constructor(message: string, readonly code: "AUTH" | "PROTOCOL" | "UPSTREAM" = "UPSTREAM") {
    super(message)
    this.name = "OpenCodeWebError"
  }
}

export interface OpenCodeWebClientOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

let cachedCreateAction: string | undefined
let cachedProviderRoutingAction: string | undefined

export class OpenCodeWebClient {
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: OpenCodeWebClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async dashboard(authCookie: string, workspaceId: string): Promise<ParsedGoDashboard> {
    const html = await this.page(authCookie, workspaceId, "go")
    return parseGoDashboard(html)
  }

  async keys(authCookie: string, workspaceId: string): Promise<ParsedGoKey[]> {
    return parseGoKeys(await this.page(authCookie, workspaceId, "keys"))
  }

  async ensureManagedKey(authCookie: string, workspaceId: string): Promise<ParsedGoKey> {
    const current = await this.keys(authCookie, workspaceId)
    const existing = current.find((key) => key.name === MANAGED_GO_KEY_NAME)
    if (existing) return existing
    const previousIds = new Set(current.map((key) => key.id))
    await this.createKey(authCookie, workspaceId, false)
    const refreshed = await this.keys(authCookie, workspaceId)
    const created = refreshed.find((key) => key.name === MANAGED_GO_KEY_NAME && !previousIds.has(key.id))
      ?? refreshed.find((key) => key.name === MANAGED_GO_KEY_NAME)
    if (!created) throw new OpenCodeWebError("Created Go API key was not returned by the Keys page", "PROTOCOL")
    return created
  }

  private async createKey(authCookie: string, workspaceId: string, retried: boolean): Promise<void> {
    const actionId = await this.discoverCreateAction(retried)
    const body = new URLSearchParams({ workspaceID: workspaceId, name: MANAGED_GO_KEY_NAME })
    const response = await this.fetcher(`${BASE}/_server?id=${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: this.headers(authCookie, `${BASE}/workspace/${workspaceId}/keys`, "application/x-www-form-urlencoded"),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const flash = parseFlash(response.headers.get("set-cookie"))
    const failed = response.status !== 302 || !flash || flash.error === true
      || Boolean(flash.result && typeof flash.result === "object" && "error" in flash.result)
    if (failed && !retried) {
      cachedCreateAction = undefined
      return this.createKey(authCookie, workspaceId, true)
    }
    if (failed) throw new OpenCodeWebError(`OpenCode key creation failed (${response.status})`, response.status === 401 || response.status === 403 ? "AUTH" : "UPSTREAM")
  }

  private async page(authCookie: string, workspaceId: string, page: "go" | "keys"): Promise<string> {
    assertWorkspaceId(workspaceId)
    const response = await this.fetcher(`${BASE}/workspace/${workspaceId}/${page}`, {
      headers: this.headers(authCookie),
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (response.status >= 300 && response.status < 400) throw new OpenCodeWebError("OpenCode auth cookie has expired", "AUTH")
    if (!response.ok) throw new OpenCodeWebError(`OpenCode ${page} page returned ${response.status}`)
    const html = await response.text()
    if (isLoginPage(html)) throw new OpenCodeWebError("OpenCode auth cookie has expired", "AUTH")
    return html
  }

  private headers(authCookie: string, referer = `${BASE}/`, contentType?: string): Headers {
    if (!authCookie.trim()) throw new OpenCodeWebError("OpenCode auth cookie is required", "AUTH")
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: `auth=${authCookie}`,
      Origin: BASE,
      Referer: referer,
      "User-Agent": "Mozilla/5.0 OpenCode-to-API/1.0",
    })
    if (contentType) headers.set("Content-Type", contentType)
    return headers
  }

  async setChinaProviders(authCookie: string, workspaceId: string, enabled: boolean): Promise<void> {
    const actionId = await this.discoverProviderRoutingAction()
    const body = new URLSearchParams({ workspaceID: workspaceId, useChinaProviders: String(enabled) })
    const response = await this.fetcher(`${BASE}/_server?id=${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: this.headers(authCookie, `${BASE}/workspace/${workspaceId}/go`, "application/x-www-form-urlencoded"),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const flash = parseFlash(response.headers.get("set-cookie"))
    const failed = response.status !== 302 || !flash || flash.error === true
      || Boolean(flash.result && typeof flash.result === "object" && "error" in flash.result)
    if (failed) throw new OpenCodeWebError(`OpenCode provider routing update failed (${response.status})`, response.status === 401 || response.status === 403 ? "AUTH" : "UPSTREAM")
  }

  private async discoverProviderRoutingAction(force = false): Promise<string> {
    if (!force && cachedProviderRoutingAction) return cachedProviderRoutingAction
    const home = await this.fetchText(`${BASE}/`)
    const entry = /(?:src|href)="(\/_build\/assets\/entry-client-[^"]+\.js)"/.exec(home)?.[1]
    if (!entry) throw new OpenCodeWebError("OpenCode client entry asset was not found", "PROTOCOL")
    const manifest = await this.fetchText(`${BASE}${entry}`)
    const route = /src\/routes\/workspace\/\[id\]\/go\/index\.tsx[\s\S]{0,700}?import\([\s\S]*?"(\.\/index-[^"]+\.js)"/.exec(manifest)?.[1]
    if (!route) throw new OpenCodeWebError("OpenCode Go route asset was not found", "PROTOCOL")
    const chunk = await this.fetchText(new URL(route, `${BASE}${entry}`).toString())
    const action = /createServerReference\("([a-f0-9]{64})"\);\s*const\s+\w+\s*=\s*action\(\w+,\s*"go\.providerRouting\.set"\)/.exec(chunk)?.[1]
    if (!action) throw new OpenCodeWebError("OpenCode go.providerRouting.set action was not found", "PROTOCOL")
    cachedProviderRoutingAction = action
    return action
  }

  private async discoverCreateAction(force: boolean): Promise<string> {
    if (!force && cachedCreateAction) return cachedCreateAction
    const home = await this.fetchText(`${BASE}/`)
    const entry = /(?:src|href)="(\/_build\/assets\/entry-client-[^"]+\.js)"/.exec(home)?.[1]
    if (!entry) throw new OpenCodeWebError("OpenCode client entry asset was not found", "PROTOCOL")
    const manifest = await this.fetchText(`${BASE}${entry}`)
    const route = /src\/routes\/workspace\/\[id\]\/keys\/index\.tsx[\s\S]{0,700}?import\([\s\S]*?"(\.\/index-[^"]+\.js)"/.exec(manifest)?.[1]
    if (!route) throw new OpenCodeWebError("OpenCode Keys route asset was not found", "PROTOCOL")
    const chunk = await this.fetchText(new URL(route, `${BASE}${entry}`).toString())
    const action = /const\s+(\w+)\s*=\s*createServerReference\("([a-f0-9]{64})"\);\s*const\s+\w+\s*=\s*action\(\1,\s*"key\.create"\)/.exec(chunk)?.[2]
    if (!action) throw new OpenCodeWebError("OpenCode key.create action was not found", "PROTOCOL")
    cachedCreateAction = action
    return action
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetcher(url, { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) throw new OpenCodeWebError(`OpenCode asset returned ${response.status}`)
    return response.text()
  }
}

function assertWorkspaceId(value: string): void {
  if (!/^wrk_[A-Za-z0-9]+$/.test(value)) throw new OpenCodeWebError("Invalid OpenCode workspace ID", "PROTOCOL")
}

function parseFlash(value: string | null): { error?: boolean; result?: unknown } | null {
  const match = /(?:^|,\s*)flash=([^;]+)/.exec(value ?? "")
  if (!match) return null
  try { return JSON.parse(decodeURIComponent(match[1])) as { error?: boolean; result?: unknown } } catch { return null }
}

export function clearActionDiscoveryCacheForTests(): void {
  cachedCreateAction = undefined
}
