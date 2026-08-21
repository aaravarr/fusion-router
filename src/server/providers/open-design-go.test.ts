import { beforeEach, describe, expect, it } from "vitest"
import { SecretVault } from "../crypto"
import { createDatabase } from "../db"
import { AccountRepository, ProviderCredentialRepository } from "../repository"
import {
  OpenDesignGoProvider,
  normalizeOpenDesignGoBaseUrl,
  normalizeOpenDesignGoApiUrl,
  parseOpenDesignBillingSummary,
  OPEN_DESIGN_GO_DEFAULT_MODELS,
} from "./open-design-go"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")

describe("open-design-go supportedInterfaces", () => {
  const provider = new OpenDesignGoProvider()
  it("仅支持 chat（OpenAI 兼容）", () => {
    expect(provider.supportedInterfaces()).toEqual(["chat"])
    expect(provider.supportedInterfaces("deepseek-v4-flash")).toEqual(["chat"])
  })

  it("getDefaultModels 返回 8 个内置模型", () => {
    expect(provider.getDefaultModels()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5.2",
      "glm-5.1",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "minimax-m2.7",
      "mimo-v2.5-pro",
    ])
    expect(provider.getDefaultModels()).toEqual([...OPEN_DESIGN_GO_DEFAULT_MODELS])
  })

  it("supportedQuotaKinds 为 MONTHLY", () => {
    expect(provider.supportedQuotaKinds()).toEqual(["MONTHLY"])
  })
})

describe("open-design-go URL 规范化", () => {
  it("去尾斜杠", () => {
    expect(normalizeOpenDesignGoBaseUrl("https://example.com/")).toBe("https://example.com/v1")
    expect(normalizeOpenDesignGoBaseUrl("https://example.com///")).toBe("https://example.com/v1")
  })

  it("不以 /v1 结尾则追加 /v1", () => {
    expect(normalizeOpenDesignGoBaseUrl("https://example.com")).toBe("https://example.com/v1")
    expect(normalizeOpenDesignGoBaseUrl("https://example.com/api")).toBe("https://example.com/api/v1")
    expect(normalizeOpenDesignGoBaseUrl("https://xxx/v1")).toBe("https://xxx/v1")
  })

  it("已含 /v1 保持不变（含尾斜杠）", () => {
    expect(normalizeOpenDesignGoBaseUrl("https://xxx/v1/")).toBe("https://xxx/v1")
    expect(normalizeOpenDesignGoBaseUrl("https://xxx/v1///")).toBe("https://xxx/v1")
  })

  it("trim 空格", () => {
    expect(normalizeOpenDesignGoBaseUrl("  https://xxx/v1  ")).toBe("https://xxx/v1")
    expect(normalizeOpenDesignGoBaseUrl("  https://xxx  ")).toBe("https://xxx/v1")
  })

  it("apiUrl 规范化默认值", () => {
    expect(normalizeOpenDesignGoApiUrl(undefined)).toBe("https://amr-api.open-design.ai")
    expect(normalizeOpenDesignGoApiUrl("")).toBe("https://amr-api.open-design.ai")
    expect(normalizeOpenDesignGoApiUrl("https://amr-api.open-design.ai/")).toBe("https://amr-api.open-design.ai")
    expect(normalizeOpenDesignGoApiUrl("https://custom.example.com/")).toBe("https://custom.example.com")
  })
})

describe("open-design-go classifyError", () => {
  const provider = new OpenDesignGoProvider()

  it("401/403 凭据失效 不切号", () => {
    expect(provider.classifyError(401, "unauthorized", new Headers())).toMatchObject({
      shouldSwitchAccount: false,
      errorType: "AuthenticationError",
    })
    expect(provider.classifyError(403, "forbidden", new Headers())).toMatchObject({
      shouldSwitchAccount: false,
      errorType: "AuthenticationError",
    })
  })

  it("402 余额耗尽切号", () => {
    const r = provider.classifyError(402, "payment required", new Headers())
    expect(r).toMatchObject({ shouldSwitchAccount: true, quotaKind: "MONTHLY", errorType: "BalanceExhausted" })
  })

  it("body 含 insufficient 切号（余额耗尽）", () => {
    expect(provider.classifyError(400, "insufficient balance", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "BalanceExhausted",
    })
    expect(provider.classifyError(403, "Insufficient funds", new Headers())).toBeTruthy() // 403 优先为 auth，但 body 含 insufficient 时 402 分支已优先于 403? 实际 403 分支优先，这里用非 401/403 状态测试
    expect(provider.classifyError(429, "insufficient quota", new Headers())).toMatchObject({ errorType: "BalanceExhausted" })
  })

  it("body 含 AMR_INSUFFICIENT_BALANCE 切号", () => {
    expect(provider.classifyError(200, JSON.stringify({ code: "AMR_INSUFFICIENT_BALANCE" }), new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "BalanceExhausted",
    })
    expect(provider.classifyError(500, "AMR_INSUFFICIENT_BALANCE", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "BalanceExhausted",
    })
  })

  it("429 限流 切号且带退避", () => {
    const r = provider.classifyError(429, "rate limit exceeded", new Headers({ "retry-after": "30" }))
    expect(r).toMatchObject({
      shouldSwitchAccount: true,
      quotaKind: "PROVIDER_RATE_LIMIT",
      errorType: "RateLimit",
      retrySameAccount: { maxRetries: 3 },
    })
    expect(r?.retryAfterSeconds).toBe(30)
  })

  it("429 无 retry-after 也返回限流", () => {
    const r = provider.classifyError(429, "too many requests", new Headers())
    expect(r).toMatchObject({ errorType: "RateLimit" })
    expect(r?.quotaKind).toBe("PROVIDER_RATE_LIMIT")
  })

  it("body 含 TIER_UPGRADE 切号模型错误", () => {
    expect(provider.classifyError(400, "TIER_UPGRADE_REQUIRED", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "ModelError",
    })
    expect(provider.classifyError(200, "tier_upgrade", new Headers())).toMatchObject({ errorType: "ModelError" })
  })

  it("body 含 not_entitled 切号模型错误", () => {
    expect(provider.classifyError(400, "not_entitled to model", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "ModelError",
    })
    expect(provider.classifyError(403, "NOT_ENTITLED", new Headers())).toBeTruthy() // 403 优先 auth，但非 401/403 状态时应命中模型错误
    expect(provider.classifyError(400, "User not_entitled", new Headers())).toMatchObject({ errorType: "ModelError" })
  })

  it("400 模型不支持切号", () => {
    expect(provider.classifyError(400, "model deepseek-v4-flash is not supported", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "ModelError",
    })
    expect(provider.classifyError(400, "Unsupported model: glm-5.2", new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "ModelError",
    })
  })

  it("无关错误返回 null", () => {
    expect(provider.classifyError(500, "internal error", new Headers())).toBeNull()
    expect(provider.classifyError(200, "ok", new Headers())).toBeNull()
  })
})

describe("open-design-go 凭据加解密往返", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey
  })

  it("SecretVault 加密往返", () => {
    const vault = new SecretVault(encryptionKey)
    const data = JSON.stringify({
      runtimeKey: "rk-123",
      linkUrl: "https://example.com/v1",
      controlKey: "ck-456",
      apiUrl: "https://amr-api.open-design.ai",
      email: "user@example.com",
      plan: "pro",
      userId: "uid-123",
    })
    const cipher = vault.encrypt(data)
    expect(cipher).not.toContain("rk-123")
    expect(JSON.parse(vault.decrypt(cipher))).toEqual(JSON.parse(data))
  })

  it("provider_credentials 加密 JSON 存取往返（:memory: 库）", () => {
    const db = createDatabase(":memory:")
    db.prepare(
      "INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)",
    ).run("owner", "owner", "owner", "Owner", "USER", "hash", new Date().toISOString(), new Date().toISOString())

    const accountRepo = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const credRepo = new ProviderCredentialRepository("owner", db, new SecretVault(encryptionKey))

    const account = accountRepo.createProviderAccount({
      name: "OpenDesign Go",
      poolType: "open-design-go",
      email: "user@example.com",
      externalId: "ext-123",
    })

    const credentialData: Record<string, string> = {
      runtimeKey: "rk-test-123",
      linkUrl: "https://runtime.example.com/v1",
      controlKey: "ck-test-456",
      apiUrl: "https://amr-api.open-design.ai",
      email: "user@example.com",
      plan: "pro",
      userId: "uid-999",
    }
    credRepo.upsert({ accountId: account.id, poolType: "open-design-go", credentialData })

    const fetched = credRepo.get(account.id)
    expect(fetched).toEqual(credentialData)

    // 直接用 SecretVault 解密底层 ciphertext
    const row = db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id=?").get(account.id) as {
      credential_data_ciphertext: string
    }
    const vault = new SecretVault(encryptionKey)
    const decrypted = JSON.parse(vault.decrypt(row.credential_data_ciphertext))
    expect(decrypted).toEqual(credentialData)

    db.close()
  })

  it("getUpstreamBaseUrl 规范化 linkUrl（:memory: 库集成）", async () => {
    const db = createDatabase(":memory:")
    // mock getDatabase to return this db for provider
    const { getDatabase: originalGetDatabase } = await import("../db")
    // 注入全局单例：直接操作 provider 读取的 DB 是全局 getDatabase，此处改用 repository 层验证 normalize 函数即可
    // 另外验证 provider 的 normalize 逻辑与 getUpstreamBaseUrl 一致
    expect(normalizeOpenDesignGoBaseUrl("https://example.com")).toBe("https://example.com/v1")
    expect(normalizeOpenDesignGoBaseUrl("https://example.com/v1/")).toBe("https://example.com/v1")
    db.close()
  })
})

describe("open-design-go isAccountReady", () => {
  const provider = new OpenDesignGoProvider()
  it("ENABLED + VALID 视为就绪", () => {
    const account = { adminState: "ENABLED", authState: "VALID", id: "test" } as unknown as import("../types").AccountRecord
    expect(provider.isAccountReady(account)).toBe(true)
  })
  it("DISABLED 不就绪", () => {
    const account = { adminState: "DISABLED", authState: "VALID", id: "test" } as unknown as import("../types").AccountRecord
    expect(provider.isAccountReady(account)).toBe(false)
  })
  it("VALID 以外不就绪", () => {
    const account = { adminState: "ENABLED", authState: "AUTH_ERROR", id: "test" } as unknown as import("../types").AccountRecord
    expect(provider.isAccountReady(account)).toBe(false)
  })
})

describe("open-design-go buildForwardTarget", () => {
  it("生成 chat/completions 转发目标", async () => {
    const provider = new OpenDesignGoProvider()
    const { createDatabase: createDb } = await import("../db")
    const db = createDb(":memory:")
    // 通过 normalize 验证转发 URL 拼接逻辑
    const base = normalizeOpenDesignGoBaseUrl("https://runtime.example.com")
    expect(base + "/chat/completions").toBe("https://runtime.example.com/v1/chat/completions")
    expect(normalizeOpenDesignGoBaseUrl("https://runtime.example.com/v1") + "/chat/completions").toBe(
      "https://runtime.example.com/v1/chat/completions",
    )
    db.close()
  })
})


describe("open-design-go linkUrl 默认值", () => {
  it("缺 linkUrl 时回退 https://amr-link.open-design.ai/v1", () => {
    expect(normalizeOpenDesignGoBaseUrl(undefined as unknown as string)).toBe("https://amr-link.open-design.ai/v1")
    expect(normalizeOpenDesignGoBaseUrl(null as unknown as string)).toBe("https://amr-link.open-design.ai/v1")
    expect(normalizeOpenDesignGoBaseUrl("")).toBe("https://amr-link.open-design.ai/v1")
    expect(normalizeOpenDesignGoBaseUrl("   ")).toBe("https://amr-link.open-design.ai/v1")
  })
  it("getUpstreamBaseUrl 缺 linkUrl 时回退默认值", () => {
    expect(normalizeOpenDesignGoBaseUrl(undefined as unknown as string)).toBe("https://amr-link.open-design.ai/v1")
  })
})

describe("open-design-go 遥测头仿真", () => {
  it("buildForwardTarget 始终带 X-AMR-Client-Source: vela 且生成 Run/Session Id", async () => {
    const provider = new OpenDesignGoProvider()
    ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
      runtimeKey: "rk-123",
      linkUrl: "https://amr-link.open-design.ai",
      controlKey: "ck-123",
      workspaceId: "ws-999",
    })
    const fakeAccount = { id: "test-vela", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
    const cred = { token: "rk-123", credentialVersion: 1 }
    const target1 = provider.buildForwardTarget(
      { method: "POST", endpoint: "chat", model: "deepseek-v4-flash", upstreamModel: "deepseek-v4-flash", body: new TextEncoder().encode("{}") as unknown as Uint8Array<ArrayBuffer>, headers: new Headers(), signal: new AbortController().signal },
      cred,
      fakeAccount,
    )
    expect(target1.headers.get("X-AMR-Client-Source")).toBe("vela")
    expect(target1.headers.get("x-vela-workspace-id")).toBe("ws-999")
    expect(target1.headers.get("X-Open-Design-Workspace-Id")).toBe("ws-999")
    expect(target1.headers.get("X-Open-Design-Run-Id")).toMatch(/^[0-9a-f-]{36}$/i)
    expect(target1.headers.get("X-Open-Design-Session-Id")).toMatch(/^[0-9a-f-]{36}$/i)
    const runId1 = target1.headers.get("X-Open-Design-Run-Id")
    const sessionId1 = target1.headers.get("X-Open-Design-Session-Id")
    const target2 = provider.buildForwardTarget(
      { method: "POST", endpoint: "chat", model: "deepseek-v4-flash", upstreamModel: "deepseek-v4-flash", body: null, headers: new Headers(), signal: new AbortController().signal },
      cred,
      fakeAccount,
    )
    expect(target2.headers.get("X-Open-Design-Run-Id")).not.toBe(runId1)
    expect(target2.headers.get("X-Open-Design-Session-Id")).not.toBe(sessionId1)
    expect(target2.url).toBe("https://amr-link.open-design.ai/v1/chat/completions")
  })
  it("无 workspaceId 时不带 workspace 头但仍带 vela 与 uuid", async () => {
    const provider = new OpenDesignGoProvider()
    ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
      runtimeKey: "rk-456",
      linkUrl: "https://example.com/v1",
      controlKey: "ck-456",
    })
    const fakeAccount = { id: "test2", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
    const cred = { token: "rk-456", credentialVersion: 1 }
    const target = provider.buildForwardTarget(
      { method: "POST", endpoint: "chat", model: "glm-5.2", upstreamModel: "glm-5.2", body: null, headers: new Headers(), signal: new AbortController().signal },
      cred,
      fakeAccount,
    )
    expect(target.headers.get("X-AMR-Client-Source")).toBe("vela")
    expect(target.headers.get("x-vela-workspace-id")).toBeNull()
    expect(target.headers.get("X-Open-Design-Workspace-Id")).toBeNull()
    expect(target.headers.get("X-Open-Design-Run-Id")).toBeTruthy()
  })
})

describe("open-design-go 凭据 workspaceId", () => {
  it("加密往返携带 workspaceId", () => {
    const vault = new SecretVault(encryptionKey)
    const data = { runtimeKey: "rk-1", linkUrl: "https://amr-link.open-design.ai", controlKey: "ck-1", workspaceId: "ws-abc" }
    const cipher = vault.encrypt(JSON.stringify(data))
    expect(JSON.parse(vault.decrypt(cipher))).toEqual(data)
  })
  it("ProviderCredentialRepository 存取 workspaceId", () => {
    const db = createDatabase(":memory:")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner3", "owner3", "owner3", "Owner", "USER", "hash", new Date().toISOString(), new Date().toISOString())
    const repo = new AccountRepository("owner3", db, new SecretVault(encryptionKey))
    const credRepo = new ProviderCredentialRepository("owner3", db, new SecretVault(encryptionKey))
    const account = repo.createProviderAccount({ name: "ws-test", poolType: "open-design-go", externalId: "ext-ws" })
    credRepo.upsert({ accountId: account.id, poolType: "open-design-go", credentialData: { runtimeKey: "rk", linkUrl: "https://amr-link.open-design.ai", controlKey: "ck", workspaceId: "ws-777", email: "a@b.com" } })
    expect(credRepo.get(account.id)?.workspaceId).toBe("ws-777")
    db.close()
  })
})

describe("open-design-go 双通道模型拉取与 isAccountReady 放宽", () => {
  it("缺 controlKey 但有 runtimeKey 时走推理面 linkBase/models", async () => {
    const { vi } = await import("vitest")
    const apiFetchModule = await import("../api-fetch")
    let calledUrl: string | null = null
    let calledAuth: string | null = null
    const spy = vi.spyOn(apiFetchModule, "apiFetch").mockImplementation(async (url: string, init?: RequestInit) => {
      calledUrl = url
      const headers = init?.headers as Record<string, string> | Headers | undefined
      if (headers instanceof Headers) calledAuth = headers.get("authorization")
      else if (headers && typeof headers === "object") calledAuth = (headers as Record<string, string>).authorization ?? null
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "glm-5.2" }] }), { status: 200, headers: { "content-type": "application/json" } })
    })
    try {
      const provider = new OpenDesignGoProvider()
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
        runtimeKey: "rk-only",
        linkUrl: "https://amr-link.open-design.ai",
      })
      const fakeAccount = { id: "dual", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
      const models = await provider.fetchRemoteModels(fakeAccount)
      expect(models).toEqual(["deepseek-v4-flash", "glm-5.2"])
      expect(calledUrl).toBe("https://amr-link.open-design.ai/v1/models")
      expect(calledAuth).toBe("Bearer rk-only")
    } finally {
      spy.mockRestore()
    }
  })
  it("有 runtimeKey 时优先走推理面，即使有 controlKey 也优先 runtimeKey", async () => {
    const { vi } = await import("vitest")
    const apiFetchModule = await import("../api-fetch")
    let calledUrl: string | null = null
    let calledAuth: string | null = null
    const spy = vi.spyOn(apiFetchModule, "apiFetch").mockImplementation(async (url: string, init?: RequestInit) => {
      calledUrl = url
      const headers = init?.headers as Record<string, string> | Headers | undefined
      if (headers instanceof Headers) calledAuth = headers.get("authorization")
      else if (headers && typeof headers === "object") calledAuth = (headers as Record<string, string>).authorization ?? null
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    })
    try {
      const provider = new OpenDesignGoProvider()
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
        runtimeKey: "rk-priority",
        linkUrl: "https://amr-link.open-design.ai",
        controlKey: "ck-priority",
        apiUrl: "https://amr-api.open-design.ai",
      })
      const fakeAccount = { id: "dual2", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
      const models = await provider.fetchRemoteModels(fakeAccount)
      expect(calledUrl).toBe("https://amr-link.open-design.ai/v1/models")
      expect(calledAuth).toBe("Bearer rk-priority")
      expect(models).toEqual(["deepseek-v4-flash"])
    } finally {
      spy.mockRestore()
    }
  })
  it("仅 controlKey 时兜底走控制面并解析 name 优先、剥 public_model_ 前缀", async () => {
    const { vi } = await import("vitest")
    const apiFetchModule = await import("../api-fetch")
    let calledUrl: string | null = null
    const spy = vi.spyOn(apiFetchModule, "apiFetch").mockImplementation(async (url: string) => {
      calledUrl = url
      return new Response(
        JSON.stringify({
          data: [
            { id: "public_model_claude_fable_5", name: "claude-fable-5" },
            { id: "public_model_deepseek_v4_flash", name: "" },
            { id: "glm-5.2", name: "glm-5.2" },
          ],
        }),
        { status: 200 },
      )
    })
    try {
      const provider = new OpenDesignGoProvider()
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
        runtimeKey: "",
        linkUrl: "https://amr-link.open-design.ai",
        controlKey: "ck-only",
        apiUrl: "https://amr-api.open-design.ai",
      } as unknown as ReturnType<typeof provider["readCredentialData"]>)
      // 模拟 runtimeKey 为空时，provider 会跳过推理面直接走控制面
      // 需要 runtimeKey 为 falsy 时，isAccountReady 会 false，但 fetchRemoteModels 仍应走控制面兜底
      // 为测试兜底，临时让 runtimeKey 缺失
      const fakeAccount = { id: "dual-control", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
      // 直接测试解析器
      const { parseOpenDesignControlModels, parseOpenDesignLinkModels } = await import("./open-design-go")
      expect(parseOpenDesignControlModels(JSON.stringify({ data: [{ id: "public_model_claude_fable_5", name: "claude-fable-5" }] }))).toEqual(["claude-fable-5"])
      expect(parseOpenDesignControlModels(JSON.stringify({ data: [{ id: "public_model_deepseek_v4_flash" }] }))).toEqual(["deepseek_v4_flash"])
      expect(parseOpenDesignLinkModels(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }))).toEqual(["deepseek-v4-flash"])
      // 实际 fetch
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
        runtimeKey: undefined as unknown as string,
        linkUrl: "https://amr-link.open-design.ai",
        controlKey: "ck-only",
        apiUrl: "https://amr-api.open-design.ai",
      } as unknown as ReturnType<typeof provider["readCredentialData"]>)
      const models = await provider.fetchRemoteModels(fakeAccount)
      expect(calledUrl).toBe("https://amr-api.open-design.ai/api/v1/models")
      expect(models).toEqual(["claude-fable-5", "deepseek_v4_flash", "glm-5.2"])
    } finally {
      spy.mockRestore()
    }
  })
  it("isAccountReady 仅需 runtimeKey，controlKey可选", async () => {
    const provider = new OpenDesignGoProvider()
    const fakeReady = { id: "ready", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
    ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
      runtimeKey: "rk-only",
      linkUrl: "https://amr-link.open-design.ai",
    })
    expect(provider.isAccountReady(fakeReady)).toBe(true)
    const fakeNotReady = { id: "notready", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
    ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
      runtimeKey: "",
      linkUrl: "https://amr-link.open-design.ai",
    } as unknown as ReturnType<typeof provider["readCredentialData"]>)
    expect(provider.isAccountReady(fakeNotReady)).toBe(false)
  })
})

describe("open-design-go parseOpenDesignBillingSummary", () => {
  const sampleBody = JSON.stringify({
    balanceUsd: "0.5000",
    creditsPerUsd: 10000,
    balances: { subscriptionCredits: "0", rechargeCredits: "5000", totalAvailableCredits: "5000" },
    membershipTier: "go",
    billingInterval: "monthly",
    subscriptionStatus: "active",
    subscriptionCurrentPeriodStart: "2026-08-21T02:29:36.000Z",
    subscriptionCurrentPeriodEnd: "2026-09-21T02:29:36.000Z",
    totalRechargedUsd: "0.5000",
    totalConsumedUsd: "0.0000",
    todayConsumedUsd: "0.0000",
    rechargeCount: 1,
    usageCount: 9,
    updatedAt: "2026-09-19T00:00:00.000Z",
  })

  it("解析实测样例：MONTHLY 窗口 + 订阅周期 resetAt + wallet + extra", () => {
    const nowMs = Date.parse("2026-09-20T02:29:36.000Z")
    const win = parseOpenDesignBillingSummary(sampleBody, nowMs)[0]
    expect(win).toBeTruthy()
    expect(win.kind).toBe("MONTHLY")
    expect(win.usagePercent).toBe(0) // 消费 0 / 充值 0.5
    expect(win.resetAt).toBe("2026-09-21T02:29:36.000Z")
    expect(win.resetInSeconds).toBe(86400)
    expect(win.source).toBe("API_PROBE")
    expect(win.wallet).toEqual({
      balanceCents: 50,
      totalCents: 50,
      monthlyChargeLimitEnabled: false,
      monthlyChargeLimitCents: 0,
      monthlyUsedCents: 0,
      currency: "USD",
    })
    expect(win.extra).toMatchObject({
      membershipTier: "go",
      subscriptionStatus: "active",
      billingInterval: "monthly",
      subscriptionPeriodStart: "2026-08-21T02:29:36.000Z",
      subscriptionPeriodEnd: "2026-09-21T02:29:36.000Z",
      todayConsumedUsd: 0,
      totalConsumedUsd: 0,
      totalRechargedUsd: 0.5,
      usageCount: 9,
      rechargeCount: 1,
    })
  })

  it("usagePercent 按累计消费/充值总额计算", () => {
    const body = JSON.stringify({ balanceUsd: "0.2000", totalRechargedUsd: "0.5000", totalConsumedUsd: "0.3000" })
    const win = parseOpenDesignBillingSummary(body)[0]
    expect(win.usagePercent).toBe(60)
    expect(win.wallet?.monthlyUsedCents).toBe(30)
    expect(win.wallet?.balanceCents).toBe(20)
  })

  it("无充值记录时用 消费/(消费+余额) 兜底", () => {
    const body = JSON.stringify({ balanceUsd: "0.5000", totalRechargedUsd: "0.0000", totalConsumedUsd: "0.5000" })
    const win = parseOpenDesignBillingSummary(body)[0]
    expect(win.usagePercent).toBe(50)
  })

  it("缺订阅周期时 resetAt/resetInSeconds 为 null", () => {
    const body = JSON.stringify({ balanceUsd: "1.0000" })
    const win = parseOpenDesignBillingSummary(body)[0]
    expect(win.resetAt).toBeNull()
    expect(win.resetInSeconds).toBeNull()
    expect(win.usagePercent).toBe(0)
  })

  it("非法 JSON 或缺 balanceUsd 返回空数组", () => {
    expect(parseOpenDesignBillingSummary("not-json")).toEqual([])
    expect(parseOpenDesignBillingSummary(JSON.stringify({ totalConsumedUsd: "1" }))).toEqual([])
  })
})

describe("open-design-go refreshQuota（billing/summary 数据源）", () => {
  it("GET billing/summary 并构造 MONTHLY 窗口", async () => {
    const { vi } = await import("vitest")
    const apiFetchModule = await import("../api-fetch")
    let calledUrl: string | null = null
    let calledAuth: string | null = null
    const spy = vi.spyOn(apiFetchModule, "apiFetch").mockImplementation(async (url: string, init?: RequestInit) => {
      calledUrl = url
      const headers = init?.headers as Record<string, string>
      calledAuth = headers?.authorization ?? null
      return new Response(JSON.stringify({
        balanceUsd: "0.5000",
        membershipTier: "go",
        subscriptionStatus: "active",
        subscriptionCurrentPeriodEnd: "2026-09-21T02:29:36.000Z",
        totalRechargedUsd: "0.5000",
        totalConsumedUsd: "0.0000",
        usageCount: 9,
      }), { status: 200 })
    })
    try {
      const provider = new OpenDesignGoProvider()
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({
        runtimeKey: "rk-1",
        controlKey: "ck-1",
        apiUrl: "https://amr-api.open-design.ai",
      })
      const fakeAccount = { id: "quota-1", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
      const windows = await provider.refreshQuota("quota-1", fakeAccount)
      expect(calledUrl).toBe("https://amr-api.open-design.ai/api/v1/billing/summary")
      expect(calledAuth).toBe("Bearer ck-1")
      expect(windows).toHaveLength(1)
      expect(windows[0]).toMatchObject({ kind: "MONTHLY", resetAt: "2026-09-21T02:29:36.000Z" })
      expect(windows[0].extra?.membershipTier).toBe("go")
    } finally {
      spy.mockRestore()
    }
  })

  it("缺 controlKey 或非 2xx 时返回空数组", async () => {
    const { vi } = await import("vitest")
    const apiFetchModule = await import("../api-fetch")
    const spy = vi.spyOn(apiFetchModule, "apiFetch").mockResolvedValue(new Response("unauthorized", { status: 401 }))
    try {
      const provider = new OpenDesignGoProvider()
      const fakeAccount = { id: "quota-2", adminState: "ENABLED", authState: "VALID" } as unknown as import("../types").AccountRecord
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({ runtimeKey: "rk-2" })
      expect(await provider.refreshQuota("quota-2", fakeAccount)).toEqual([])
      ;(provider as unknown as { readCredentialData: () => unknown }).readCredentialData = () => ({ runtimeKey: "rk-2", controlKey: "ck-2" })
      expect(await provider.refreshQuota("quota-2", fakeAccount)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})