/**
 * xAI SSO -> OAuth Device Flow Conversion
 *
 * Mirrors internal/pkg/xai/sso_device.go from the sub2api reference
 * implementation. Accepts an SSO JWT token, drives the xAI OAuth2 device
 * authorization flow on the server side (no browser needed), and returns
 * access_token + refresh_token.
 *
 * All HTTP requests use the global fetch API with manual redirect handling:
 * Node.js fetch does not expose a CheckRedirect hook, so we set
 * `redirect: "manual"` and loop over 3xx responses ourselves.
 */

// Resolve hostnames through the domain mirror map so operators behind mirrors
// can reach accounts.x.ai / auth.x.ai without a proxy.
import { resolveMirrorUrl } from "./api-fetch"
import { getSystemSettings } from "./settings"
import { EnvHttpProxyAgent } from "undici"

// ─── Constants ───────────────────────────────────────────────────────────

const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SSO_BUILD_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
const SSO_ACCOUNTS_URL = "https://accounts.x.ai/"
const SSO_DEVICE_URL = "https://auth.x.ai/oauth2/device/code"
const SSO_VERIFY_URL = "https://auth.x.ai/oauth2/device/verify"
const SSO_APPROVE_URL = "https://auth.x.ai/oauth2/device/approve"
const SSO_TOKEN_URL = "https://auth.x.ai/oauth2/token"
const SSO_CONVERSION_TIMEOUT_MS = 90_000
const SSO_DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const MAX_REDIRECTS = 8
const MAX_AUTH_BODY = 2 << 20 // 2 MiB
const DEFAULT_TOKEN_TTL_S = 6 * 60 * 60 // 6 hours

// ─── Types ───────────────────────────────────────────────────────────────

export interface SsoConversionResult {
  accessToken: string
  refreshToken: string
  idToken?: string
  tokenType: string
  expiresIn: number
  scope?: string
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri_complete: string
  interval: number
  expires_in: number
}

interface TokenPollResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

// ─── Token Normalization ──────────────────────────────────────────────────

/**
 * Extract the SSO JWT from a raw input string. Supports:
 *  - "email|password|eyJ..."  -> returns eyJ...
 *  - "sso=eyJ...; sso-rw=eyJ..." (cookie format) -> returns sso value
 *  - "eyJ..." (plain JWT) -> returns as-is
 *  - "cookie:eyJ..." -> strips prefix
 */
export function normalizeSsoToken(raw: string): string {
  let value = raw.trim()
  const lower = value.toLowerCase()
  if (lower.startsWith("cookie:")) {
    value = value.slice("cookie:".length).trim()
  }

  // Try cookie-format: "sso=eyJ...; sso-rw=eyJ..."
  for (const part of value.split(";")) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) continue
    const name = trimmed.slice(0, eqIdx).trim().toLowerCase()
    const tokenValue = trimmed.slice(eqIdx + 1)
    if (name === "sso" || name === "sso-rw") {
      return sanitizeSsoToken(tokenValue)
    }
  }

  // Try pipe-delimited: "email|password|eyJ..."
  if (value.includes("|")) {
    const parts = value.split("|")
    const last = parts[parts.length - 1].trim()
    if (last.startsWith("eyJ")) return sanitizeSsoToken(last)
  }

  // Remove any trailing "; ..." suffix
  const semiIdx = value.indexOf(";")
  if (semiIdx !== -1) {
    value = value.slice(0, semiIdx).trim()
  }

  return sanitizeSsoToken(value)
}

function sanitizeSsoToken(value: string): string {
  return value.trim().replace(/[\r\n\0]/g, "")
}

// ─── JWT Decoding ─────────────────────────────────────────────────────────

/** Decode JWT payload (without verifying signature) and return claims. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length < 2) return null
  try {
    // JWT uses base64url encoding (no padding)
    const payload = Buffer.from(parts[1], "base64url")
    return JSON.parse(payload.toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract a string claim from decoded JWT claims. */
export function jwtClaimString(claims: Record<string, unknown>, key: string): string {
  const value = claims[key]
  return typeof value === "string" ? value.trim() : ""
}

// ─── URL Safety ───────────────────────────────────────────────────────────

function safeXaiAuthUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.username) return false // no userinfo
  if (!parsed.hostname) return false
  if (parsed.protocol !== "https:") return false
  const host = parsed.hostname.toLowerCase()
  if (host === "x.ai" || host.endsWith(".x.ai")) return true
  // Path-prefix mirrors rewrite 3xx Location headers to their own domain, so
  // allow any host that is configured as a mirror target in system_settings.
  try {
    const mirrorMap = getSystemSettings().domainMirrorMap ?? {}
    for (const config of Object.values(mirrorMap)) {
      for (const mirror of config.mirrors) {
        try {
          const target = new URL(mirror.url)
          if (target.hostname.toLowerCase() === host) return true
        } catch { /* skip invalid mirror entry */ }
      }
    }
    for (const group of getSystemSettings().domainMirrorGroups ?? []) {
      for (const mirror of group.mirrors) {
        try {
          const target = new URL(mirror.url.replaceAll("$host", "origin.example.com"))
          if (target.hostname.toLowerCase() === host) return true
        } catch { /* skip invalid mirror entry */ }
      }
    }
  } catch { /* settings unavailable — strict mode */ }
  return false
}

// ─── HTTP Client ──────────────────────────────────────────────────────────

interface HttpResponse {
  status: number
  url: string
  body: Buffer
}

class SsoDeviceFlow {
  private cookies = new Map<string, string>()
  private readonly userAgent: string
  private readonly dispatcher?: object

  constructor(ssoToken: string, userAgent?: string) {
    this.userAgent = userAgent?.trim() || SSO_DEFAULT_UA
    this.cookies.set("sso", ssoToken)
    this.cookies.set("sso-rw", ssoToken)
    // Use EnvHttpProxyAgent so HTTP_PROXY/HTTPS_PROXY env vars are respected
    this.dispatcher = new EnvHttpProxyAgent() as object
  }

  private cookieHeader(): string {
    const keys = [...this.cookies.keys()].sort()
    return keys.map((k) => `${k}=${this.cookies.get(k)}`).join("; ")
  }

  private captureCookies(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? []
    for (const raw of setCookies) {
      // Parse "name=value; ..." - only the first pair is the cookie
      const semiIdx = raw.indexOf(";")
      const pair = semiIdx === -1 ? raw : raw.slice(0, semiIdx)
      const eqIdx = pair.indexOf("=")
      if (eqIdx === -1) continue
      const name = pair.slice(0, eqIdx).trim()
      const value = pair.slice(eqIdx + 1).trim()
      if (!name || name.length > 128 || value.length > 16384) continue
      if (/[\r\n\0]/.test(name + value)) continue
      this.cookies.set(name, value)
    }
  }

  /** Execute HTTP request, manually following up to 8 redirects. */
  async do(
    signal: AbortSignal | undefined,
    method: string,
    endpoint: string,
    form?: URLSearchParams,
  ): Promise<HttpResponse> {
    if (!safeXaiAuthUrl(endpoint)) throw new Error("xAI OAuth URL is not trusted")

    let currentUrl = endpoint
    let currentMethod = method
    let currentForm = form

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const headers: Record<string, string> = {
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent": this.userAgent,
      }
      const cookie = this.cookieHeader()
      if (cookie) headers["Cookie"] = cookie

      let body: string | undefined
      if (currentForm) {
        body = currentForm.toString()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
      }

      const fetchedUrl = resolveMirrorUrl(currentUrl)
      const response = await fetch(fetchedUrl, {
        method: currentMethod,
        headers,
        body,
        redirect: "manual",
        signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      })

      this.captureCookies(response)
      const arrayBuffer = await response.arrayBuffer()
      const respBody = Buffer.from(arrayBuffer)
      if (respBody.length > MAX_AUTH_BODY) throw new Error("xAI OAuth response exceeds 2 MiB")

      const status = response.status
      const url = response.url || currentUrl

      // Not a 3xx -> return result
      if (status < 300 || status > 399) {
        return { status, url, body: respBody }
      }

      // Follow redirect
      const location = response.headers.get("location")?.trim()
      if (!location) throw new Error("xAI OAuth redirect missing Location")

      const nextUrl = new URL(location, currentUrl).href
      if (!safeXaiAuthUrl(nextUrl)) throw new Error("xAI OAuth redirected to untrusted host")
      currentUrl = nextUrl

      // 303 -> always GET; 301/302 with non-GET/HEAD -> GET
      if (status === 303 || ((status === 301 || status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")) {
        currentMethod = "GET"
        currentForm = undefined
      }
      // 307/308 preserve method and body
    }

    throw new Error("xAI OAuth redirected too many times")
  }

  /** Full conversion flow. */
  async convert(signal: AbortSignal | undefined): Promise<SsoConversionResult> {
    // Step 1: Validate SSO login by visiting accounts.x.ai
    const step1 = await this.do(signal, "GET", SSO_ACCOUNTS_URL)
    if (step1.status === 401 || step1.url.includes("sign-in") || step1.url.includes("sign-up")) {
      throw new Error("xAI SSO unauthorized")
    }
    if (step1.status < 200 || step1.status >= 400) {
      throw new Error(`xAI SSO validation failed (HTTP ${step1.status})`)
    }

    // Step 2: Start device flow -> get device_code + user_code
    const step2 = await this.do(signal, "POST", SSO_DEVICE_URL, new URLSearchParams({
      client_id: XAI_DEFAULT_CLIENT_ID,
      scope: SSO_BUILD_SCOPE,
    }))
    if (step2.status < 200 || step2.status >= 300) {
      throw new Error(`xAI device flow start failed (HTTP ${step2.status})`)
    }
    const device = JSON.parse(step2.body.toString("utf8")) as DeviceCodeResponse
    if (!device.device_code || !device.user_code || !safeXaiAuthUrl(device.verification_uri_complete)) {
      throw new Error("xAI device flow response is incomplete")
    }
    if (device.interval <= 0) device.interval = 5
    if (device.expires_in <= 0) device.expires_in = 1800

    // Step 3: Open verification page
    const step3 = await this.do(signal, "GET", device.verification_uri_complete)
    if (step3.status < 200 || step3.status >= 400) {
      throw new Error(`xAI device verification page failed (HTTP ${step3.status})`)
    }

    // Step 4: Verify device code
    const step4 = await this.do(signal, "POST", SSO_VERIFY_URL, new URLSearchParams({
      user_code: device.user_code,
    }))
    if (step4.status < 200 || step4.status >= 400) {
      throw new Error(`xAI device code verify failed (HTTP ${step4.status})`)
    }
    if (!step4.url.includes("consent")) {
      throw new Error("xAI device verification did not reach consent page")
    }

    // Step 5: Approve
    const step5 = await this.do(signal, "POST", SSO_APPROVE_URL, new URLSearchParams({
      user_code: device.user_code,
      action: "allow",
      principal_type: "User",
      principal_id: "",
    }))
    if (step5.status < 200 || step5.status >= 400) {
      throw new Error(`xAI device approval failed (HTTP ${step5.status})`)
    }
    if (!step5.url.includes("done")) {
      throw new Error("xAI device approval did not reach done page")
    }

    // Step 6: Poll for token
    return this.pollToken(signal, device.device_code, device.interval, device.expires_in)
  }

  private async pollToken(
    signal: AbortSignal | undefined,
    deviceCode: string,
    intervalS: number,
    expiresInS: number,
  ): Promise<SsoConversionResult> {
    const intervalMs = Math.max(intervalS, 1) * 1000
    const deadline = Date.now() + Math.min(expiresInS, 75) * 1000

    let currentInterval = intervalMs
    while (Date.now() < deadline) {
      await sleep(signal, currentInterval)

      const resp = await this.do(signal, "POST", SSO_TOKEN_URL, new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_DEFAULT_CLIENT_ID,
        device_code: deviceCode,
      }))

      const payload = JSON.parse(resp.body.toString("utf8")) as TokenPollResponse

      if (resp.status >= 200 && resp.status < 300 && payload.access_token) {
        return {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token ?? "",
          idToken: payload.id_token,
          tokenType: payload.token_type || "Bearer",
          expiresIn: payload.expires_in ?? DEFAULT_TOKEN_TTL_S,
          scope: payload.scope,
        }
      }

      switch (payload.error) {
        case "authorization_pending":
          continue
        case "slow_down":
          currentInterval += 5000
          continue
        case "access_denied":
        case "expired_token":
          throw new Error("xAI device authorization denied")
        default:
          if (resp.status >= 400) {
            throw new Error(
              `xAI token polling failed (HTTP ${resp.status}): ${payload.error_description || payload.error || ""}`,
            )
          }
          throw new Error(
            `xAI token polling failed: ${payload.error_description || payload.error || resp.status}`,
          )
      }
    }

    throw new Error("xAI device flow token polling timed out")
  }
}

function sleep(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(signal!.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Convert an SSO JWT token to OAuth access_token + refresh_token via the xAI
 * device flow. The entire flow runs server-side; no browser interaction
 * needed. Throws on any failure.
 */
export async function convertSsoToBuild(
  ssoToken: string,
  options?: { signal?: AbortSignal },
): Promise<SsoConversionResult> {
  const token = normalizeSsoToken(ssoToken)
  if (!token) throw new Error("xAI SSO unauthorized: empty token")

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), SSO_CONVERSION_TIMEOUT_MS)
  const signal = options?.signal
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  try {
    const flow = new SsoDeviceFlow(token)
    return await flow.convert(controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}
