import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase, getDatabase, type AppDatabase } from "../db"
import { AccountRepository, ProviderCredentialRepository } from "../repository"
import type { AccountRecord } from "../types"
import {
  exchangeOpenAIRefreshToken,
  extractCodexError,
  normalizeCodexResponsesBody,
  OpenAICPAProvider,
  OpenAITokenRevokedError,
  parseCodexModelsPayload,
} from "./openai-cpa"

// CLIProxyAPI 契约（2026-09-07 源码核实）指纹常量，与 provider 内部保持一致。
const EXPECTED_UA = "codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)"
const EXPECTED_ORIGINATOR = "codex-tui"

const ownerUserId = "openai-cpa-test-owner"
let db: AppDatabase

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function idTokenWithClaims(overrides: Record<string, unknown> = {}): string {
  return jwt({
    sub: "openai-user-1",
    email: "codex@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-acct-1",
      chatgpt_user_id: "chatgpt-user-1",
      chatgpt_plan_type: "plus",
    },
    ...overrides,
  })
}

function createOpenAIAccount(credentialData: Record<string, string>): AccountRecord {
  const accounts = new AccountRepository(ownerUserId, db)
  const account = accounts.createProviderAccount({ name: "openai acct", poolType: "openai" })
  new ProviderCredentialRepository(ownerUserId, db).upsert({ accountId: account.id, poolType: "openai", credentialData })
  return account
}

function readCredentialData(accountId: string): Record<string, string> {
  return new ProviderCredentialRepository(ownerUserId, db).get(accountId) ?? {}
}

function forwardInput(overrides: {
  method?: string
  endpoint?: string
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
} = {}) {
  const bodyText = overrides.rawBody ?? JSON.stringify(overrides.body ?? { model: "gpt-5.3-codex", input: [] })
  return {
    method: overrides.method ?? "POST",
    endpoint: overrides.endpoint ?? "responses",
    model: "gpt-5.3-codex",
    upstreamModel: "gpt-5.3-codex",
    body: new TextEncoder().encode(bodyText) as Uint8Array<ArrayBuffer>,
    headers: new Headers({ "user-agent": "codex-cli-client/9.9.9", ...overrides.headers }),
    signal: AbortSignal.timeout(1_000),
  }
}

beforeEach(() => {
  db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "openai-cpa-test", "openai-cpa-test", "OpenAI CPA Test", "USER", "hash", timestamp, timestamp)
  setGlobalDatabase(db)
  expect(getDatabase()).toBe(db)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setGlobalDatabase(undefined)
  db.close()
})

// ─── classifyError（CLIProxyAPI 契约表驱动） ─────────────────────────────

describe("OpenAICPAProvider.classifyError（CLIProxyAPI 契约，2026-09-07）", () => {
  const provider = new OpenAICPAProvider()

  const cases: Array<{
    name: string
    status: number
    body: string
    headers?: Headers
    expected: Record<string, unknown> | null
  }> = [
    {
      name: "429 usage_limit_reached（resets_in_seconds）→ credentialScoped 冷却切号",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 3600 } }),
      expected: { shouldSwitchAccount: true, quotaKind: "FIVE_HOUR", retryAfterSeconds: 3600, errorType: "OPENAI_USAGE_LIMIT_REACHED" },
    },
    {
      name: "429 usage_limit_reached（周级冷却 → WEEKLY 窗）",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 3 * 86400 } }),
      expected: { shouldSwitchAccount: true, quotaKind: "WEEKLY", retryAfterSeconds: 3 * 86400, errorType: "OPENAI_USAGE_LIMIT_REACHED" },
    },
    {
      name: "429 usage_limit_reached 无 resets → retry-after 头兜底",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      headers: new Headers({ "retry-after": "42" }),
      expected: { shouldSwitchAccount: true, retryAfterSeconds: 42, errorType: "OPENAI_USAGE_LIMIT_REACHED" },
    },
    {
      name: "429 usage_limit_reached 无任何时间 → 兜底 300s",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      expected: { shouldSwitchAccount: true, retryAfterSeconds: 300, errorType: "OPENAI_USAGE_LIMIT_REACHED" },
    },
    {
      name: "流内 error 事件（usage_limit_reached 嵌套）同样映射",
      status: 429,
      body: JSON.stringify({ type: "error", error: { type: "usage_limit_reached", resets_in_seconds: 600 } }),
      expected: { shouldSwitchAccount: true, retryAfterSeconds: 600, errorType: "OPENAI_USAGE_LIMIT_REACHED" },
    },
    {
      name: "流内 response.failed 事件（response.error 嵌套）同样映射",
      status: 429,
      body: JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "usage_limit_reached", message: "usage limit reached", resets_in_seconds: 900 } } }),
      expected: { shouldSwitchAccount: true, retryAfterSeconds: 900, errorType: "OPENAI_USAGE_LIMIT_REACHED" },
    },
    {
      name: "429 model is at capacity → 换号重试（瞬态 PROVIDER_RATE_LIMIT）",
      status: 429,
      body: JSON.stringify({ error: { message: "model is at capacity, try again later" } }),
      expected: { shouldSwitchAccount: true, quotaKind: "PROVIDER_RATE_LIMIT", errorType: "OPENAI_MODEL_AT_CAPACITY" },
    },
    {
      name: "429 旧版 wham envelope（rate_limit_reached + 双窗）保持既有识别",
      status: 429,
      body: JSON.stringify({
        rate_limit_reached: true,
        rate_limit: {
          primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 1200, reset_at: 0 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: 0 },
        },
      }),
      expected: { shouldSwitchAccount: true, quotaKind: "FIVE_HOUR", retryAfterSeconds: 1200, errorType: "RateLimitError" },
    },
    {
      name: "429 非 JSON 瞬时 throttle → OPENAI_RATE_LIMITED 透传 retry-after",
      status: 429,
      body: "too many requests",
      headers: new Headers({ "retry-after": "7" }),
      expected: { shouldSwitchAccount: true, quotaKind: "PROVIDER_RATE_LIMIT", retryAfterSeconds: 7, errorType: "OPENAI_RATE_LIMITED" },
    },
    {
      name: "429 JSON 无特征 → OPENAI_RATE_LIMITED",
      status: 429,
      body: JSON.stringify({ rate_limit_reached: false }),
      expected: { shouldSwitchAccount: true, quotaKind: "PROVIDER_RATE_LIMIT", errorType: "OPENAI_RATE_LIMITED" },
    },
    {
      name: "401 → 凭据判死切号（CREDENTIAL_INVALID 墓碑）",
      status: 401,
      body: "unauthorized",
      expected: { shouldSwitchAccount: true, permanentlyDisableAccount: true, errorType: "CREDENTIAL_INVALID" },
    },
    {
      name: "403 + authentication_error 类型 → 判死切号",
      status: 403,
      body: JSON.stringify({ error: { type: "authentication_error", message: "Invalid authentication credentials" } }),
      expected: { shouldSwitchAccount: true, permanentlyDisableAccount: true, errorType: "CREDENTIAL_INVALID" },
    },
    {
      name: "400 + invalid or expired token 措辞 → 判死切号",
      status: 400,
      body: JSON.stringify({ error: { message: "Your token is invalid or expired token. Please sign in again." } }),
      expected: { shouldSwitchAccount: true, permanentlyDisableAccount: true, errorType: "CREDENTIAL_INVALID" },
    },
    {
      name: "流内 authentication_error 事件 → 判死切号",
      status: 401,
      body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid token" } }),
      expected: { shouldSwitchAccount: true, permanentlyDisableAccount: true, errorType: "CREDENTIAL_INVALID" },
    },
    {
      name: "403 普通禁止（无 auth 措辞）→ null 透传",
      status: 403,
      body: "forbidden by cloudflare",
      expected: null,
    },
    { name: "500 → null", status: 500, body: "oops", expected: null },
    { name: "200 → null", status: 200, body: "ok", expected: null },
  ]

  for (const { name, status, body, headers, expected } of cases) {
    it(name, () => {
      const result = provider.classifyError(status, body, headers ?? new Headers())
      if (expected === null) expect(result).toBeNull()
      else expect(result).toMatchObject(expected)
    })
  }

  it("usage_limit_reached 按 resets_at（unix 秒）算冷却", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200
    const result = provider.classifyError(429, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetsAt } }), new Headers())
    expect(result?.errorType).toBe("OPENAI_USAGE_LIMIT_REACHED")
    expect(result?.retryAfterSeconds).toBeGreaterThan(7100)
    expect(result?.retryAfterSeconds).toBeLessThanOrEqual(7200)
  })

  it("usage_limit_reached 按 resets_at（毫秒时间戳 / ISO 字符串）算冷却", () => {
    const atMs = Date.now() + 3600_000
    const byMs = provider.classifyError(429, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: atMs } }), new Headers())
    expect(byMs?.retryAfterSeconds).toBeGreaterThan(3500)
    expect(byMs?.retryAfterSeconds).toBeLessThanOrEqual(3600)
    const byIso = provider.classifyError(429, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: new Date(atMs).toISOString() } }), new Headers())
    expect(byIso?.retryAfterSeconds).toBeGreaterThan(3500)
  })

  it("capacity 429 透传 retry-after 头", () => {
    const result = provider.classifyError(429, "model is at capacity", new Headers({ "retry-after": "15" }))
    expect(result).toMatchObject({ errorType: "OPENAI_MODEL_AT_CAPACITY", retryAfterSeconds: 15 })
  })
})

describe("extractCodexError 嵌套形态", () => {
  it("顶层 error / response.error / 纯字符串 error", () => {
    expect(extractCodexError(JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 5 } })))
      .toMatchObject({ type: "usage_limit_reached", resetsInSeconds: 5 })
    expect(extractCodexError(JSON.stringify({ type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "x" } } })))
      .toMatchObject({ code: "rate_limit_exceeded" })
    expect(extractCodexError(JSON.stringify({ error: "invalid or expired token" })))
      .toMatchObject({ message: "invalid or expired token" })
  })

  it("事件帧裸 type（response.completed）与 wham envelope 不误判为错误", () => {
    expect(extractCodexError(JSON.stringify({ type: "response.completed", response: { status: "completed" } }))).toBeNull()
    expect(extractCodexError(JSON.stringify({ rate_limit_reached: true, rate_limit: {} }))).toBeNull()
    expect(extractCodexError("not json")).toBeNull()
    expect(extractCodexError("")).toBeNull()
  })
})

// ─── buildForwardTarget 头一致性 + body 规范化 ───────────────────────────

describe("OpenAICPAProvider.buildForwardTarget（CLIProxyAPI cloaking 契约）", () => {
  const provider = new OpenAICPAProvider()
  const stubAccount = { id: "acct-test" } as AccountRecord

  it("URL 拼到 chatgpt.com/backend-api/codex 下", () => {
    const target = provider.buildForwardTarget(forwardInput(), { token: "at-x", credentialVersion: 1 }, stubAccount)
    expect(target.url).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  it("指纹头一致：codex-tui UA + Originator + SSE Accept + Bearer", () => {
    const target = provider.buildForwardTarget(forwardInput(), { token: "at-x", credentialVersion: 1 }, stubAccount)
    expect(target.headers.get("authorization")).toBe("Bearer at-x")
    expect(target.headers.get("user-agent")).toBe(EXPECTED_UA)
    expect(target.headers.get("originator")).toBe(EXPECTED_ORIGINATOR)
    expect(target.headers.get("accept")).toBe("text/event-stream")
    expect(target.headers.get("content-type")).toBe("application/json")
  })

  it("OAuth 凭据必带 Chatgpt-Account-Id；PAT（无 account id）不带", () => {
    const oauth = provider.buildForwardTarget(
      forwardInput(),
      { token: "at-x", credentialVersion: 1, extraHeaders: { "chatgpt-account-id": "acct-123" } },
      stubAccount,
    )
    expect(oauth.headers.get("chatgpt-account-id")).toBe("acct-123")
    const pat = provider.buildForwardTarget(forwardInput(), { token: "at-pat", credentialVersion: 1 }, stubAccount)
    expect(pat.headers.get("chatgpt-account-id")).toBeNull()
  })

  it("客户端 UA/originator/accept 不透传（cloaking 强制伪装）；白名单头透传", () => {
    const target = provider.buildForwardTarget(
      forwardInput({
        headers: {
          "user-agent": "evil-client/1.0",
          originator: "evil-originator",
          accept: "application/json",
          session_id: "sess-1",
          conversation_id: "conv-1",
          "openai-beta": "responses=v1",
          "accept-language": "zh-CN",
        },
      }),
      { token: "at-x", credentialVersion: 1 },
      stubAccount,
    )
    expect(target.headers.get("user-agent")).toBe(EXPECTED_UA)
    expect(target.headers.get("originator")).toBe(EXPECTED_ORIGINATOR)
    expect(target.headers.get("accept")).toBe("text/event-stream")
    expect(target.headers.get("session_id")).toBe("sess-1")
    expect(target.headers.get("conversation_id")).toBe("conv-1")
    expect(target.headers.get("openai-beta")).toBe("responses=v1")
    expect(target.headers.get("accept-language")).toBe("zh-CN")
    expect(target.headers.get("codex-beta")).toBeNull()
  })

  it("GET 不带 content-type、body 原样", () => {
    const target = provider.buildForwardTarget(
      forwardInput({ method: "GET", endpoint: "responses/resp_1" }),
      { token: "at-x", credentialVersion: 1 },
      stubAccount,
    )
    expect(target.url).toBe("https://chatgpt.com/backend-api/codex/responses/resp_1")
    expect(target.headers.get("content-type")).toBeNull()
  })
})

describe("normalizeCodexResponsesBody（CLIProxyAPI body 契约）", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>
  const decode = (body: Uint8Array<ArrayBuffer> | null) => JSON.parse(new TextDecoder().decode(body!)) as Record<string, unknown>

  it("强制 stream:true；instructions 为 null/缺失时置 空串", () => {
    expect(decode(normalizeCodexResponsesBody(encode({ model: "gpt-5.3-codex", stream: false })))).toMatchObject({ stream: true, instructions: "" })
    expect(decode(normalizeCodexResponsesBody(encode({ model: "gpt-5.3-codex", instructions: null })))).toMatchObject({ stream: true, instructions: "" })
    expect(decode(normalizeCodexResponsesBody(encode({ instructions: "keep me" })))).toMatchObject({ instructions: "keep me" })
  })

  it("删除 previous_response_id/generate/prompt_cache_retention/safety_identifier/stream_options", () => {
    const out = decode(normalizeCodexResponsesBody(encode({
      model: "gpt-5.3-codex",
      input: [{ type: "message", role: "user", content: "hi" }],
      previous_response_id: "resp_1",
      generate: true,
      prompt_cache_retention: "24h",
      safety_identifier: "sid",
      stream_options: { include_usage: true },
      instructions: "inst",
    })))
    expect(out).toEqual({
      model: "gpt-5.3-codex",
      input: [{ type: "message", role: "user", content: "hi" }],
      instructions: "inst",
      stream: true,
    })
  })

  it("非 JSON / 数组 / 空 body 原样透传", () => {
    const raw = new TextEncoder().encode("not-json") as Uint8Array<ArrayBuffer>
    expect(normalizeCodexResponsesBody(raw)).toBe(raw)
    const arr = encode([1, 2])
    expect(normalizeCodexResponsesBody(arr)).toBe(arr)
    expect(normalizeCodexResponsesBody(null)).toBeNull()
  })
})

// ─── Token 刷新：24h 提前量 / 墓碑 / 退避 / 并发去重 ─────────────────────

describe("OpenAICPAProvider token 刷新（CLIProxyAPI RefreshLead=24h 契约）", () => {
  const okRefreshResponse = () => Response.json({
    access_token: "at-new",
    refresh_token: "rt-new",
    id_token: idTokenWithClaims(),
    token_type: "Bearer",
    expires_in: 7 * 86400,
  })

  it("距过期超过 24h：不刷新，直接返回现有 token", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-current",
      refreshToken: "rt-1",
      expiresAt: String(Math.floor(Date.now() / 1000) + 48 * 3600),
      chatgptAccountId: "acct-1",
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const credential = await provider.getCredential(account)
    expect(credential.token).toBe("at-current")
    expect(credential.extraHeaders?.["chatgpt-account-id"]).toBe("acct-1")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("PAT（无 refreshToken）：不刷新", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({ token: "at-pat" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect((await provider.getCredential(account)).token).toBe("at-pat")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("距过期不足 24h：提前刷新并持久化新 token/refreshToken/expiresAt/expiresIn/AccountID", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-old",
      refreshToken: "rt-old",
      expiresAt: String(Math.floor(Date.now() / 1000) + 3600), // 1h < 24h lead
      chatgptAccountId: "acct-1",
    })
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal("fetch", fetchMock)

    const credential = await provider.getCredential(account)
    expect(credential.token).toBe("at-new")
    expect(credential.extraHeaders?.["chatgpt-account-id"]).toBe("chatgpt-acct-1")

    const stored = readCredentialData(account.id)
    expect(stored.token).toBe("at-new")
    expect(stored.refreshToken).toBe("rt-new")
    expect(stored.expiresIn).toBe(String(7 * 86400))
    expect(Number(stored.expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 6 * 86400)
    expect(stored.chatgptAccountId).toBe("chatgpt-acct-1")
    expect(stored.revokedAt).toBeUndefined()

    // 刷新请求契约：refresh grant + scope + Accept: application/json
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://auth.openai.com/oauth/token")
    const params = new URLSearchParams(String(init.body))
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("refresh_token")).toBe("rt-old")
    expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(params.get("scope")).toBe("openid profile email")
    expect(new Headers(init.headers).get("accept")).toBe("application/json")
  })

  it("expiresAt 缺失（旧数据）：按需要刷新处理", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({ token: "at-old", refreshToken: "rt-old" })
    vi.stubGlobal("fetch", vi.fn(async () => okRefreshResponse()))
    expect((await provider.getCredential(account)).token).toBe("at-new")
  })

  it("并发去重：5 个并发 getCredential 共享一次刷新（refresh_token 轮换保护）", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-old",
      refreshToken: "rt-old",
      expiresAt: String(Math.floor(Date.now() / 1000) + 60), // 立即过期窗口内
    })
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = vi.fn(() => gate)
    vi.stubGlobal("fetch", fetchMock)

    const pending = Array.from({ length: 5 }, () => provider.getCredential(account))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    release(okRefreshResponse())
    const credentials = await Promise.all(pending)
    expect(credentials.map((item) => item.token)).toEqual(Array(5).fill("at-new"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readCredentialData(account.id).refreshToken).toBe("rt-new")
  })

  it("刷新 401 → revoked 墓碑：清空 token、停止刷新调度、后续直接报需重新登录", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-old",
      refreshToken: "rt-dead",
      expiresAt: String(Math.floor(Date.now() / 1000) + 60),
    })
    const fetchMock = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(provider.getCredential(account)).rejects.toBeInstanceOf(OpenAITokenRevokedError)
    const stored = readCredentialData(account.id)
    expect(stored.token).toBe("")
    expect(stored.revokedAt).toBeTruthy()

    // 墓碑生效：不再请求 token 端点，直接抛「需重新登录」
    await expect(provider.getCredential(account)).rejects.toThrow(/需重新登录|失效/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("refresh_token_reused（400）→ 同样判死（CLIProxyAPI：refresh_token_reused 或 401）", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-old",
      refreshToken: "rt-reused",
      expiresAt: String(Math.floor(Date.now() / 1000) + 60),
    })
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "refresh_token_reused" }, { status: 400 })))
    await expect(provider.getCredential(account)).rejects.toBeInstanceOf(OpenAITokenRevokedError)
    expect(readCredentialData(account.id).revokedAt).toBeTruthy()
  })

  it("网络/5xx 抖动：保留旧 token 静默降级 + 指数退避（退避窗内不再请求，过后重试）", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-07T00:00:00Z") })
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-old",
      refreshToken: "rt-flaky",
      expiresAt: String(Math.floor(Date.now() / 1000) + 60),
    })
    const fetchMock = vi.fn(async () => new Response("upstream boom", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)

    // 第一次：刷新失败，返回旧 token，不写墓碑
    expect((await provider.getCredential(account)).token).toBe("at-old")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readCredentialData(account.id).revokedAt).toBeUndefined()

    // 退避窗内（10s 基础退避）：不再请求，直接返回旧 token
    vi.setSystemTime(new Date("2026-09-07T00:00:05Z"))
    expect((await provider.getCredential(account)).token).toBe("at-old")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 退避窗过后：重试刷新（第二次失败后退避 20s）
    vi.setSystemTime(new Date("2026-09-07T00:00:11Z"))
    expect((await provider.getCredential(account)).token).toBe("at-old")
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 恢复后成功刷新
    fetchMock.mockImplementation(async () => okRefreshResponse())
    vi.setSystemTime(new Date("2026-09-07T00:00:32Z"))
    expect((await provider.getCredential(account)).token).toBe("at-new")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

// ─── exchangeOpenAIRefreshToken（CPA 导入兑换链契约） ────────────────────

describe("exchangeOpenAIRefreshToken", () => {
  it("成功：解析 token 四件套 + id_token 身份（AccountID/email/planType）", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      access_token: jwt({ sub: "openai-user-1" }),
      refresh_token: "rt-new",
      id_token: idTokenWithClaims(),
      token_type: "Bearer",
      expires_in: 3600,
    }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await exchangeOpenAIRefreshToken("rt-1")
    expect(result.refreshToken).toBe("rt-new")
    expect(result.expiresIn).toBe(3600)
    expect(result.chatgptAccountId).toBe("chatgpt-acct-1")
    expect(result.email).toBe("codex@example.com")
    expect(result.planType).toBe("plus")
    expect(Number(result.expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const params = new URLSearchParams(String(init.body))
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("scope")).toBe("openid profile email")
  })

  it("refresh_token 被吊销（401）→ OpenAITokenRevokedError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 401 })))
    await expect(exchangeOpenAIRefreshToken("rt-dead")).rejects.toBeInstanceOf(OpenAITokenRevokedError)
  })

  it("refresh_token_reused（400）→ OpenAITokenRevokedError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "refresh_token_reused" }, { status: 400 })))
    await expect(exchangeOpenAIRefreshToken("rt-reused")).rejects.toBeInstanceOf(OpenAITokenRevokedError)
  })

  it("5xx/网络抖动 → 普通 Error（不判死）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    await expect(exchangeOpenAIRefreshToken("rt-1")).rejects.toThrow(/HTTP 500/)
    await expect(exchangeOpenAIRefreshToken("rt-1")).rejects.not.toBeInstanceOf(OpenAITokenRevokedError)
  })

  it("带镜像上下文：代理节点注入共享 dispatcher（地域封锁下直连 403）", async () => {
    const { getProxyDispatcher, invalidateMirrorCacheForOwner } = await import("../api-fetch")
    const { OPENAI_OAUTH_TOKEN_URL } = await import("../openai-oauth")
    const proxyOwner = "openai-cpa-proxy-owner"
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(proxyOwner, proxyOwner, proxyOwner, "Proxy", "USER", "hash", timestamp, timestamp)
    db.prepare("INSERT INTO user_mirror_groups(id,owner_user_id,name,enabled,domains_json,account_ids_json,mirrors_json,rules_json,request_rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("g-oai-proxy", proxyOwner, "g-oai-proxy", 1, JSON.stringify(["auth.openai.com"]), JSON.stringify([]),
        JSON.stringify([{ id: "m", name: "M", url: "", proxyUrl: "http://127.0.0.1:7890", enabled: true }]),
        JSON.stringify([]), null, timestamp, timestamp)
    invalidateMirrorCacheForOwner(proxyOwner)
    try {
      const fetchMock = vi.fn(async () => Response.json({
        access_token: jwt({ sub: "openai-user-1" }),
        refresh_token: "rt-new",
        id_token: idTokenWithClaims(),
        expires_in: 3600,
      }))
      vi.stubGlobal("fetch", fetchMock)
      await exchangeOpenAIRefreshToken("rt-1", undefined, { ownerUserId: proxyOwner })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }]
      expect(url).toBe(OPENAI_OAUTH_TOKEN_URL)
      expect(init.dispatcher).toBe(getProxyDispatcher("http://127.0.0.1:7890"))
    } finally {
      invalidateMirrorCacheForOwner(proxyOwner)
    }
  })

  it("provider 刷新透传账号上下文：命中账号归属镜像组时代理生效", async () => {
    const { getProxyDispatcher, invalidateMirrorCacheForOwner } = await import("../api-fetch")
    invalidateMirrorCacheForOwner(ownerUserId)
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO user_mirror_groups(id,owner_user_id,name,enabled,domains_json,account_ids_json,mirrors_json,rules_json,request_rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("g-oai-acct", ownerUserId, "g-oai-acct", 1, JSON.stringify(["auth.openai.com"]), JSON.stringify([]),
        JSON.stringify([{ id: "m", name: "M", url: "", proxyUrl: "http://127.0.0.1:7890", enabled: true }]),
        JSON.stringify([]), null, timestamp, timestamp)
    invalidateMirrorCacheForOwner(ownerUserId)
    try {
      const provider = new OpenAICPAProvider()
      const account = createOpenAIAccount({
        token: "at-old",
        refreshToken: "rt-old",
        expiresAt: String(Math.floor(Date.now() / 1000) + 60),
      })
      const fetchMock = vi.fn(async () => Response.json({
        access_token: "at-new",
        refresh_token: "rt-new",
        id_token: idTokenWithClaims(),
        expires_in: 7 * 86400,
      }))
      vi.stubGlobal("fetch", fetchMock)
      expect((await provider.getCredential(account)).token).toBe("at-new")
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }]
      expect(init.dispatcher).toBe(getProxyDispatcher("http://127.0.0.1:7890"))
    } finally {
      invalidateMirrorCacheForOwner(ownerUserId)
    }
  })
})

// ─── validateCredential：whoami 回填 AccountID ───────────────────────────

describe("OpenAICPAProvider.validateCredential", () => {
  it("whoami 200：valid + best-effort 回填 chatgptAccountId/planType/email", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({ token: "at-pat" })
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      expect(String(input)).toBe("https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami")
      return Response.json({
        email: "pat@example.com",
        chatgpt_user_id: "user-1",
        chatgpt_account_id: "acct-whoami",
        chatgpt_plan_type: "team",
      })
    }))

    const result = await provider.validateCredential(account)
    expect(result).toMatchObject({ valid: true, email: "pat@example.com", planType: "team" })
    expect(readCredentialData(account.id)).toMatchObject({
      chatgptAccountId: "acct-whoami",
      planType: "team",
      email: "pat@example.com",
    })
  })

  it("whoami 401 → invalid；5xx 不误杀（valid）", async () => {
    const provider = new OpenAICPAProvider()
    const account401 = createOpenAIAccount({ token: "at-bad" })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })))
    expect((await provider.validateCredential(account401)).valid).toBe(false)

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    expect((await provider.validateCredential(account401)).valid).toBe(true)
  })

  it("revoked 墓碑凭据 → invalid（不请求上游）", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({ token: "", refreshToken: "rt", revokedAt: "2026-09-01T00:00:00Z" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect((await provider.validateCredential(account)).valid).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── 模型目录：默认清单 + /codex/models 真实同步 ──────────────────────────
// 默认清单 = 2026-09-08 生产实测上游返回全量（HTTP 200，8 个 slug）+
// CLIProxyAPI codex_client_models.json 快照双对齐。

describe("OpenAICPAProvider 模型目录（上游 /codex/models 同步）", () => {
  const EXPECTED_DEFAULTS = [
    "gpt-6-astra",
    "gpt-reserve",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4-mini",
    "codex-auto-review",
  ]

  it("getDefaultModels 返回实测 8 模型（含 gpt-5.6-luna/sol）", () => {
    const provider = new OpenAICPAProvider()
    expect(provider.getDefaultModels()).toEqual(EXPECTED_DEFAULTS)
    expect(provider.getAvailableModels([])).toEqual(EXPECTED_DEFAULTS)
  })

  it("parseCodexModelsPayload：{models:[{slug}]} 提取 slug（去重/去空/trim）", () => {
    expect(parseCodexModelsPayload(JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
        { slug: " gpt-5.6-luna " },
        { slug: "gpt-5.6-sol" },
        { slug: "" },
        { display_name: "no slug" },
        null,
      ],
    }))).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"])
  })

  it("parseCodexModelsPayload：非 JSON / 无 models 数组 → null", () => {
    expect(parseCodexModelsPayload("not json")).toBeNull()
    expect(parseCodexModelsPayload(JSON.stringify({ models: null }))).toBeNull()
    expect(parseCodexModelsPayload(JSON.stringify({}))).toBeNull()
    expect(parseCodexModelsPayload(JSON.stringify([]))).toBeNull()
  })

  it("fetchRemoteModels：GET /codex/models?client_version，cloaking 头 + Bearer + Account-Id", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({
      token: "at-pat",
      chatgptAccountId: "acct-123",
      expiresAt: String(Math.floor(Date.now() / 1000) + 48 * 3600),
    })
    const fetchMock = vi.fn(async (input: unknown) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.153.3")
      return Response.json({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
          { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" },
        ],
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    expect(await provider.fetchRemoteModels(account)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(init.method).toBe("GET")
    expect(headers.get("authorization")).toBe("Bearer at-pat")
    expect(headers.get("user-agent")).toBe(EXPECTED_UA)
    expect(headers.get("originator")).toBe(EXPECTED_ORIGINATOR)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("chatgpt-account-id")).toBe("acct-123")
  })

  it("fetchRemoteModels：上游非 200 → 抛错（syncProviderModels 回落默认列表）", async () => {
    const provider = new OpenAICPAProvider()
    const account = createOpenAIAccount({ token: "at-pat" })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })))
    await expect(provider.fetchRemoteModels(account)).rejects.toThrow(/HTTP 403/)
  })
})
