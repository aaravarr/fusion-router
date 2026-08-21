import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createDatabase } from "./db"
import { SecretVault } from "./crypto"
import { _clearSessionsForTest, startOpenDesignGoDeviceSession, pollOpenDesignGoDeviceSession, cancelOpenDesignGoDeviceSession } from "./open-design-go-device"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")

describe("open-design-go device flow", () => {
  let db: ReturnType<typeof createDatabase>
  let apiFetchSpy: ReturnType<typeof vi.spyOn>
  let getDatabaseSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey
    _clearSessionsForTest()
    db = createDatabase(":memory:")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", new Date().toISOString(), new Date().toISOString())
    const dbModule = await import("./db")
    getDatabaseSpy = vi.spyOn(dbModule, "getDatabase").mockReturnValue(db as unknown as ReturnType<typeof dbModule.getDatabase>)
    const apiFetchModule = await import("./api-fetch")
    apiFetchSpy = vi.spyOn(apiFetchModule, "apiFetch")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    _clearSessionsForTest()
    try { db.close() } catch {}
  })

  it("start 创建会话成功", async () => {
    apiFetchSpy.mockResolvedValue(new Response(JSON.stringify({
      deviceId: "ou9qh40ikg1pwoumwhv4tzmw",
      userCode: "5UC79N",
      deviceSecret: "secret-123",
      activationUrl: "https://open-design.ai/cloud/cli/activate?deviceId=ou9qh40ikg1pwoumwhv4tzmw&userCode=5UC79N",
      pollIntervalSeconds: 2,
      expiresAt: new Date(Date.now() + 15*60*1000).toISOString(),
    }), { status: 201, headers: { "content-type": "application/json" } }) as unknown as Response)

    const result = await startOpenDesignGoDeviceSession("owner")
    expect(result.sessionId).toBeTruthy()
    expect(result.userCode).toBe("5UC79N")
    expect(result.activationUrl).toContain("5UC79N")
    expect(result.pollIntervalSeconds).toBe(2)
    expect(result.expiresIn).toBeGreaterThan(800)
    expect(apiFetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/v1/cli/device-authorizations"), expect.objectContaining({ method: "POST" }))
    const body = JSON.parse((apiFetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.cliVersion).toBe("0.0.33")
    expect(body.profile).toBe("prod")
    expect(body.host).toMatch(/^host-/)
  })

  it("poll pending 返回 pending", async () => {
    apiFetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/device-authorizations") && !url.includes("/token")) {
        return new Response(JSON.stringify({
          deviceId: "dev-1", userCode: "CODE1", deviceSecret: "sec-1", activationUrl: "https://open-design.ai/activate", pollIntervalSeconds: 2, expiresAt: new Date(Date.now()+900000).toISOString()
        }), { status: 201 }) as unknown as Response
      }
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ status: "pending", controlKey: null, runtimeKey: null }), { status: 200 }) as unknown as Response
      }
      return new Response("not found", { status: 404 }) as unknown as Response
    })
    const started = await startOpenDesignGoDeviceSession("owner")
    const result = await pollOpenDesignGoDeviceSession("owner", started.sessionId)
    expect(result.status).toBe("pending")
    // 会话仍存在
    const { _getSessionForTest } = await import("./open-design-go-device")
    expect(_getSessionForTest(started.sessionId)).toBeTruthy()
  })

  it("poll approved 创建账号、凭据并自动发现 workspaceId", async () => {
    let walletCalled = false
    apiFetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/device-authorizations") && !url.includes("/token")) {
        return new Response(JSON.stringify({
          deviceId: "dev-approved", userCode: "APPR", deviceSecret: "sec-approved", activationUrl: "https://open-design.ai/activate", pollIntervalSeconds: 1, expiresAt: new Date(Date.now()+900000).toISOString()
        }), { status: 201 }) as unknown as Response
      }
      if (url.includes("/token")) {
        return new Response(JSON.stringify({
          status: "approved",
          controlKey: "ck-approved",
          runtimeKey: "rk-approved",
          apiUrl: "https://amr-api.open-design.ai",
          linkUrl: "https://amr-link.open-design.ai",
          user: { id: "uid-123", email: "user@example.com", name: "Test User" }
        }), { status: 200 }) as unknown as Response
      }
      if (url.includes("/wallet/balance")) {
        walletCalled = true
        return new Response(JSON.stringify({ balanceUsd: "0.5000", workspaceId: "ir54ivb6ypgpv4y442txczu4" }), { status: 200 }) as unknown as Response
      }
      return new Response("not found", { status: 404 }) as unknown as Response
    })
    const started = await startOpenDesignGoDeviceSession("owner")
    const result = await pollOpenDesignGoDeviceSession("owner", started.sessionId)
    expect(result.status).toBe("approved")
    if (result.status === "approved") {
      expect(result.account.poolType).toBe("open-design-go")
      expect(result.account.email).toBe("user@example.com")
      expect(result.workspaceId).toBe("ir54ivb6ypgpv4y442txczu4")
    }
    expect(walletCalled).toBe(true)
    // 验证账号与凭据落库
    const { AccountRepository, ProviderCredentialRepository } = await import("./repository")
    const repo = new AccountRepository("owner", db)
    const credRepo = new ProviderCredentialRepository("owner", db)
    const accounts = repo.list()
    expect(accounts.length).toBe(1)
    expect(accounts[0].poolType).toBe("open-design-go")
    const cred = credRepo.get(accounts[0].id)
    expect(cred?.runtimeKey).toBe("rk-approved")
    expect(cred?.controlKey).toBe("ck-approved")
    expect(cred?.workspaceId).toBe("ir54ivb6ypgpv4y442txczu4")
    expect(cred?.email).toBe("user@example.com")
    // 会话已清理
    const { _getSessionForTest } = await import("./open-design-go-device")
    expect(_getSessionForTest(started.sessionId)).toBeUndefined()
  })

  it("poll denied 返回 denied", async () => {
    apiFetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/device-authorizations") && !url.includes("/token")) {
        return new Response(JSON.stringify({ deviceId: "dev-denied", userCode: "DENY", deviceSecret: "sec-deny", activationUrl: "https://x", pollIntervalSeconds: 1, expiresAt: new Date(Date.now()+900000).toISOString() }), { status: 201 }) as unknown as Response
      }
      return new Response(JSON.stringify({ status: "denied" }), { status: 200 }) as unknown as Response
    })
    const started = await startOpenDesignGoDeviceSession("owner")
    const result = await pollOpenDesignGoDeviceSession("owner", started.sessionId)
    expect(result.status).toBe("denied")
  })

  it("poll expired 返回 expired", async () => {
    apiFetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/device-authorizations") && !url.includes("/token")) {
        return new Response(JSON.stringify({ deviceId: "dev-exp", userCode: "EXP", deviceSecret: "sec-exp", activationUrl: "https://x", pollIntervalSeconds: 1, expiresAt: new Date(Date.now()+900000).toISOString() }), { status: 201 }) as unknown as Response
      }
      return new Response(JSON.stringify({ status: "expired" }), { status: 200 }) as unknown as Response
    })
    const started = await startOpenDesignGoDeviceSession("owner")
    const result = await pollOpenDesignGoDeviceSession("owner", started.sessionId)
    expect(result.status).toBe("expired")
  })

  it("poll 401 invalid_device_secret 返回 invalid_secret", async () => {
    apiFetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/device-authorizations") && !url.includes("/token")) {
        return new Response(JSON.stringify({ deviceId: "dev-401", userCode: "BAD", deviceSecret: "sec-bad", activationUrl: "https://x", pollIntervalSeconds: 1, expiresAt: new Date(Date.now()+900000).toISOString() }), { status: 201 }) as unknown as Response
      }
      return new Response(JSON.stringify({ error: "invalid_device_secret" }), { status: 401 }) as unknown as Response
    })
    const started = await startOpenDesignGoDeviceSession("owner")
    const result = await pollOpenDesignGoDeviceSession("owner", started.sessionId)
    expect(result.status).toBe("invalid_secret")
  })

  it("cancel 清理会话", async () => {
    apiFetchSpy.mockResolvedValue(new Response(JSON.stringify({ deviceId: "dev-cancel", userCode: "CANC", deviceSecret: "sec", activationUrl: "https://x", pollIntervalSeconds: 1, expiresAt: new Date(Date.now()+900000).toISOString() }), { status: 201 }) as unknown as Response)
    const started = await startOpenDesignGoDeviceSession("owner")
    const ok = cancelOpenDesignGoDeviceSession("owner", started.sessionId)
    expect(ok).toBe(true)
    await expect(pollOpenDesignGoDeviceSession("owner", started.sessionId)).rejects.toThrow(/不存在|过期/)
  })
})
