import { isLoginPage, parseGoDashboard, parseGoKeys, parseReferralSummary, type ParsedGoDashboard, type ParsedGoKey, type ParsedReferralSummary } from "./parser"

const BASE = "https://opencode.ai"
export const MANAGED_GO_KEY_NAME = "OpenCode to API"

/** 后台任务（无用户在场）访问 opencode.ai 控制面时使用的网关自标识 UA。 */
export const OPENCODE_WEB_DEFAULT_USER_AGENT = "Mozilla/5.0 OpenCode-to-API/1.0"

/**
 * 有用户在场的调用（管理台操作、扩展上报）可透传操作者的真实 UA；
 * 缺省或空值时回落到 OPENCODE_WEB_DEFAULT_USER_AGENT，后台路径行为不变。
 */
export interface OpenCodeWebCallOptions {
  userAgent?: string | null
}

/** 内部重试标记（action 发现缓存失效后重试一次）。 */
type RetryOption = { retried?: boolean }

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
let cachedAllowTrainingAction: string | undefined
let cachedApplyRewardAction: string | undefined

export class OpenCodeWebClient {
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: OpenCodeWebClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async dashboard(authCookie: string, workspaceId: string, options: OpenCodeWebCallOptions = {}): Promise<ParsedGoDashboard> {
    const html = await this.page(authCookie, workspaceId, "go", options)
    return parseGoDashboard(html)
  }

  async keys(authCookie: string, workspaceId: string, options: OpenCodeWebCallOptions = {}): Promise<ParsedGoKey[]> {
    return parseGoKeys(await this.page(authCookie, workspaceId, "keys", options))
  }

  async ensureManagedKey(authCookie: string, workspaceId: string, options: OpenCodeWebCallOptions = {}): Promise<ParsedGoKey> {
    const current = await this.keys(authCookie, workspaceId, options)
    const existing = current.find((key) => key.name === MANAGED_GO_KEY_NAME)
    if (existing) return existing
    const previousIds = new Set(current.map((key) => key.id))
    await this.createKey(authCookie, workspaceId, options)
    const refreshed = await this.keys(authCookie, workspaceId, options)
    const created = refreshed.find((key) => key.name === MANAGED_GO_KEY_NAME && !previousIds.has(key.id))
      ?? refreshed.find((key) => key.name === MANAGED_GO_KEY_NAME)
    if (!created) throw new OpenCodeWebError("Created Go API key was not returned by the Keys page", "PROTOCOL")
    return created
  }

  private async createKey(authCookie: string, workspaceId: string, options: OpenCodeWebCallOptions & RetryOption = {}): Promise<void> {
    const actionId = await this.discoverCreateAction(Boolean(options.retried))
    const body = new URLSearchParams({ workspaceID: workspaceId, name: MANAGED_GO_KEY_NAME })
    const response = await this.fetcher(`${BASE}/_server?id=${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: this.headers(authCookie, { referer: `${BASE}/workspace/${workspaceId}/keys`, contentType: "application/x-www-form-urlencoded", userAgent: options.userAgent }),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const flash = parseFlash(response.headers.get("set-cookie"))
    const failed = response.status !== 302 || !flash || flash.error === true
      || Boolean(flash.result && typeof flash.result === "object" && "error" in flash.result)
    if (failed && !options.retried) {
      cachedCreateAction = undefined
      return this.createKey(authCookie, workspaceId, { ...options, retried: true })
    }
    if (failed) throw new OpenCodeWebError(`OpenCode key creation failed (${response.status})`, response.status === 401 || response.status === 403 ? "AUTH" : "UPSTREAM")
  }

  private async page(authCookie: string, workspaceId: string, page: "go" | "keys", options: OpenCodeWebCallOptions = {}): Promise<string> {
    assertWorkspaceId(workspaceId)
    const response = await this.fetcher(`${BASE}/workspace/${workspaceId}/${page}`, {
      headers: this.headers(authCookie, { userAgent: options.userAgent }),
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (response.status >= 300 && response.status < 400) throw new OpenCodeWebError("OpenCode auth cookie has expired", "AUTH")
    if (!response.ok) throw new OpenCodeWebError(`OpenCode ${page} page returned ${response.status}`)
    const html = await response.text()
    if (isLoginPage(html)) throw new OpenCodeWebError("OpenCode auth cookie has expired", "AUTH")
    return html
  }

  private headers(authCookie: string, options: { referer?: string; contentType?: string; userAgent?: string | null } = {}): Headers {
    if (!authCookie.trim()) throw new OpenCodeWebError("OpenCode auth cookie is required", "AUTH")
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: `auth=${authCookie}`,
      Origin: BASE,
      Referer: options.referer ?? `${BASE}/`,
      // 有用户在场时透传操作者真实 UA；空值回落到网关自标识默认值（后台任务）。
      "User-Agent": options.userAgent?.trim() || OPENCODE_WEB_DEFAULT_USER_AGENT,
    })
    if (options.contentType) headers.set("Content-Type", options.contentType)
    return headers
  }

  async setChinaProviders(authCookie: string, workspaceId: string, enabled: boolean, options: OpenCodeWebCallOptions = {}): Promise<void> {
    const actionId = await this.discoverProviderRoutingAction()
    const body = new URLSearchParams({ workspaceID: workspaceId, useChinaProviders: enabled ? "on" : "" })
    const response = await this.fetcher(`${BASE}/_server?id=${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: this.headers(authCookie, { referer: `${BASE}/workspace/${workspaceId}/go`, contentType: "application/x-www-form-urlencoded", userAgent: options.userAgent }),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const flash = parseFlash(response.headers.get("set-cookie"))
    const failed = response.status !== 302 || !flash || flash.error === true
      || Boolean(flash.result && typeof flash.result === "object" && "error" in flash.result)
    if (failed) throw new OpenCodeWebError(`OpenCode provider routing update failed (${response.status})`, response.status === 401 || response.status === 403 ? "AUTH" : "UPSTREAM")
  }

  // 「允许使用请求数据进行训练的模型」开关（上游 providers 区独立表单，action 名 go.allowTraining.set）。
  // 上游服务端按 form.get("allowTraining") === "true" 做显式布尔解析（sst/opencode console 源码实证），
  // 因此提交值必须是 "true"/"false"，而不是 chinaProviders 链路沿用的原生 checkbox 值 "on"/"".
  async setAllowTraining(authCookie: string, workspaceId: string, enabled: boolean, options: OpenCodeWebCallOptions = {}): Promise<void> {
    const actionId = await this.discoverAllowTrainingAction()
    const body = new URLSearchParams({ workspaceID: workspaceId, allowTraining: enabled ? "true" : "false" })
    const response = await this.fetcher(`${BASE}/_server?id=${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: this.headers(authCookie, { referer: `${BASE}/workspace/${workspaceId}/go`, contentType: "application/x-www-form-urlencoded", userAgent: options.userAgent }),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const flash = parseFlash(response.headers.get("set-cookie"))
    const failed = response.status !== 302 || !flash || flash.error === true
      || Boolean(flash.result && typeof flash.result === "object" && "error" in flash.result)
    if (failed) throw new OpenCodeWebError(`OpenCode allow training update failed (${response.status})`, response.status === 401 || response.status === 403 ? "AUTH" : "UPSTREAM")
  }

  async referrals(authCookie: string, workspaceId: string, options: OpenCodeWebCallOptions = {}): Promise<ParsedReferralSummary | null> {
    const html = await this.page(authCookie, workspaceId, "go", options)
    return parseReferralSummary(html)
  }

  // 兑换邀请奖励。上游当前版本只接受 GET /_server?id=<actionId>&args=<JSON 数组> 通道
  // （POST + URLSearchParams 会 302 到 /auth/authorize，见实测）。成功通道为 302 + Set-Cookie flash（flash 无 error），
  // 失败判定兼容 flash.error / flash.result.error（302 通道）与 x-error 响应头（200 通道）。
  async applyReferralReward(authCookie: string, workspaceId: string, referralId: string, options: OpenCodeWebCallOptions & RetryOption = {}): Promise<void> {
    const actionId = await this.discoverApplyRewardAction(Boolean(options.retried))
    const args = JSON.stringify([workspaceId, referralId])
    const response = await this.fetcher(`${BASE}/_server?id=${encodeURIComponent(actionId)}&args=${encodeURIComponent(args)}`, {
      method: "GET",
      headers: this.serverActionHeaders(authCookie, actionId, `${BASE}/workspace/${workspaceId}/go`, options),
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const redirecting = response.status === 302
    const xError = response.headers.get("x-error")
    if ((redirecting || xError !== null || !response.ok) && !options.retried) {
      cachedApplyRewardAction = undefined
      return this.applyReferralReward(authCookie, workspaceId, referralId, { ...options, retried: true })
    }
    if (redirecting) {
      const location = response.headers.get("location") ?? ""
      if (location.includes("/auth/")) throw new OpenCodeWebError("OpenCode auth cookie has expired", "AUTH")
      const flash = parseFlash(response.headers.get("set-cookie"))
      if (flash) {
        const flashFailed = flash.error === true || Boolean(flash.result && typeof flash.result === "object" && "error" in flash.result)
        if (flashFailed) throw new OpenCodeWebError(extractFlashMessage(flash.result), "UPSTREAM")
        return
      }
      throw new OpenCodeWebError(`OpenCode referral reward apply failed (${response.status})`, "UPSTREAM")
    }
    if (!response.ok) throw new OpenCodeWebError(`OpenCode referral reward apply failed (${response.status})`, response.status === 401 || response.status === 403 ? "AUTH" : "UPSTREAM")
    if (xError) {
      const body = await response.text()
      throw new OpenCodeWebError(extractServerErrorText(body) ?? xError, "UPSTREAM")
    }
  }

  private async discoverApplyRewardAction(force: boolean): Promise<string> {
    if (!force && cachedApplyRewardAction) return cachedApplyRewardAction
    const chunk = await this.fetchGoRouteChunk()
    const action = /createServerReference\("([a-f0-9]{64})"\);[\s\S]{0,200}?action\(\w+,\s*"go\.referral\.reward\.apply"\)/.exec(chunk)?.[1]
    if (!action) throw new OpenCodeWebError("OpenCode go.referral.reward.apply action was not found", "PROTOCOL")
    cachedApplyRewardAction = action
    return action
  }

  private serverActionHeaders(authCookie: string, actionId: string, referer: string, options: OpenCodeWebCallOptions = {}): Headers {
    const headers = this.headers(authCookie, { referer, userAgent: options.userAgent })
    headers.set("X-Server-Id", actionId)
    headers.set("X-Server-Instance", `server-fn:${Date.now().toString(36)}`)
    return headers
  }

  private async discoverProviderRoutingAction(force = false): Promise<string> {
    if (!force && cachedProviderRoutingAction) return cachedProviderRoutingAction
    const chunk = await this.fetchGoRouteChunk()
    const action = /createServerReference\("([a-f0-9]{64})"\);\s*const\s+\w+\s*=\s*action\(\w+,\s*"go\.providerRouting\.set"\)/.exec(chunk)?.[1]
    if (!action) throw new OpenCodeWebError("OpenCode go.providerRouting.set action was not found", "PROTOCOL")
    cachedProviderRoutingAction = action
    return action
  }

  private async discoverAllowTrainingAction(force = false): Promise<string> {
    if (!force && cachedAllowTrainingAction) return cachedAllowTrainingAction
    const chunk = await this.fetchGoRouteChunk()
    const action = /createServerReference\("([a-f0-9]{64})"\);\s*const\s+\w+\s*=\s*action\(\w+,\s*"go\.allowTraining\.set"\)/.exec(chunk)?.[1]
    if (!action) throw new OpenCodeWebError("OpenCode go.allowTraining.set action was not found", "PROTOCOL")
    cachedAllowTrainingAction = action
    return action
  }

  /** 抓取 workspace go 路由的客户端 chunk（providers 区所有表单 action 都在其中）。 */
  private async fetchGoRouteChunk(): Promise<string> {
    const home = await this.fetchText(`${BASE}/`)
    const entry = /(?:src|href)="(\/_build\/assets\/entry-client-[^"]+\.js)"/.exec(home)?.[1]
    if (!entry) throw new OpenCodeWebError("OpenCode client entry asset was not found", "PROTOCOL")
    const manifest = await this.fetchText(`${BASE}${entry}`)
    const route = /src\/routes\/workspace\/\[id\]\/go\/index\.tsx[\s\S]{0,700}?import\([\s\S]*?"(\.\/index-[^"]+\.js)"/.exec(manifest)?.[1]
    if (!route) throw new OpenCodeWebError("OpenCode Go route asset was not found", "PROTOCOL")
    return this.fetchText(new URL(route, `${BASE}${entry}`).toString())
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
  cachedProviderRoutingAction = undefined
  cachedAllowTrainingAction = undefined
  cachedApplyRewardAction = undefined
}

function extractServerErrorText(body: string): string | null {
  const match = /new Error\("((?:[^"\\]|\\.)*)"\)/.exec(body)
  return match ? match[1] : null
}

function extractFlashMessage(result: unknown): string {
  if (result && typeof result === "object" && "error" in result) {
    const error = (result as { error?: unknown }).error
    if (typeof error === "string") return error
  }
  if (result && typeof result === "object" && "message" in result) {
    const message = (result as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return "OpenCode referral reward apply failed"
}
