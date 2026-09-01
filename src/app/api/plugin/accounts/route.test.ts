import { describe, expect, it, vi } from "vitest"
import { createPluginAccountPost, OPTIONS } from "./route"

const body = { authCookie: "a-valid-browser-auth-cookie", workspaceId: "wrk_abc", extensionVersion: "1.2.3" }

describe("plugin account report API", () => {
  it("要求现有统一 API key，并保留跨域预检头", async () => {
    const report = vi.fn(); const post = createPluginAccountPost({ authenticate: () => null, report })
    const response = await post(new Request("http://localhost/api/plugin/accounts", { method: "POST", body: JSON.stringify(body) }))
    expect(response.status).toBe(401); expect(report).not.toHaveBeenCalled()
    expect(OPTIONS().headers.get("access-control-allow-headers")).toContain("x-api-key")
  })

  it("从 API key 所属关系确定 owner，客户端不能在 payload 指定其他用户", async () => {
    const report = vi.fn().mockResolvedValue({ id: "account-1", ownerUserId: "owner-from-key", credentialSource: "BROWSER_EXTENSION" })
    const post = createPluginAccountPost({ authenticate: (key) => key === "ocg_valid" ? { id: "key-1", ownerUserId: "owner-from-key", name: "test-key", prefix: "ocg_xxx", enabled: true, allowedModels: null, expiresAt: null, lastUsedAt: null, createdAt: "now", revealable: false, hash: "hash" } : null, report })
    const response = await post(new Request("http://localhost/api/plugin/accounts", { method: "POST", headers: { authorization: "Bearer ocg_valid", "content-type": "application/json" }, body: JSON.stringify({ ...body, ownerUserId: "attacker-selected" }) }))
    expect(response.status).toBe(201)
    expect(report).toHaveBeenCalledWith("owner-from-key", body)
  })

  it("透传扩展上报请求的 User-Agent 给 report", async () => {
    const report = vi.fn().mockResolvedValue({ id: "account-1", ownerUserId: "owner-from-key" })
    const post = createPluginAccountPost({ authenticate: (key) => key === "ocg_valid" ? { id: "key-1", ownerUserId: "owner-from-key", name: "test-key", prefix: "ocg_xxx", enabled: true, allowedModels: null, expiresAt: null, lastUsedAt: null, createdAt: "now", revealable: false, hash: "hash" } : null, report })
    const ua = "Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0"
    const response = await post(new Request("http://localhost/api/plugin/accounts", { method: "POST", headers: { authorization: "Bearer ocg_valid", "content-type": "application/json", "user-agent": ua }, body: JSON.stringify(body) }))
    expect(response.status).toBe(201)
    expect(report).toHaveBeenCalledWith("owner-from-key", { ...body, userAgent: ua })
  })
})
