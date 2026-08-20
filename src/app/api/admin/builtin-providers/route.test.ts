import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppDatabase } from "@/server/db"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "owner" })),
  db: null as unknown as AppDatabase,
}))

vi.mock("../_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/server/db")>("@/server/db")
  return { ...actual, getDatabase: () => mocks.db }
})

import { createDatabase } from "@/server/db"
import { isBuiltinProviderEnabled } from "@/server/builtin-provider-state"
import { GET, PATCH } from "./route"

interface ProviderPayload {
  poolType: string
  label: string
  description: string
  quotaKinds: string[]
  accountCount: number
  readyAccountCount: number
  enabled: boolean
  updatedAt: string | null
}

function patchRequest(body: unknown): Request {
  return new Request("http://x/api/admin/builtin-providers", { method: "PATCH", body: JSON.stringify(body) })
}

describe("/api/admin/builtin-providers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "owner" })
    mocks.db = createDatabase(":memory:")
  })

  it("GET 返回全部内置 provider，默认启用", async () => {
    const response = await GET(new Request("http://x/api/admin/builtin-providers"))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { providers: ProviderPayload[] }
    expect(payload.providers.map((provider) => provider.poolType)).toEqual(["opencode-go", "openai", "xai-grok", "kimi-code", "open-design-go"])
    for (const provider of payload.providers) {
      expect(provider.enabled).toBe(true)
      expect(provider.accountCount).toBe(0)
      expect(provider.readyAccountCount).toBe(0)
      expect(typeof provider.label).toBe("string")
      expect(Array.isArray(provider.quotaKinds)).toBe(true)
    }
    expect(payload.providers.find((provider) => provider.poolType === "opencode-go")?.label).toBe("OpenCode Go")
  })

  it("PATCH 禁用后状态持久化，GET 反映为 disabled", async () => {
    const patchResponse = await PATCH(patchRequest({ poolType: "xai-grok", enabled: false }))
    expect(patchResponse.status).toBe(200)
    const patched = (await patchResponse.json()) as { provider: ProviderPayload }
    expect(patched.provider.poolType).toBe("xai-grok")
    expect(patched.provider.enabled).toBe(false)
    expect(typeof patched.provider.updatedAt).toBe("string")
    expect(isBuiltinProviderEnabled("xai-grok", mocks.db)).toBe(false)

    const getResponse = await GET(new Request("http://x/api/admin/builtin-providers"))
    const payload = (await getResponse.json()) as { providers: ProviderPayload[] }
    expect(payload.providers.find((provider) => provider.poolType === "xai-grok")?.enabled).toBe(false)
    expect(payload.providers.find((provider) => provider.poolType === "openai")?.enabled).toBe(true)

    // 重新启用恢复
    const enableResponse = await PATCH(patchRequest({ poolType: "xai-grok", enabled: true }))
    expect(enableResponse.status).toBe(200)
    expect(isBuiltinProviderEnabled("xai-grok", mocks.db)).toBe(true)
  })

  it("PATCH 非法 poolType 返回 400（非 401，避免前端误判未登录跳转）", async () => {
    const response = await PATCH(patchRequest({ poolType: "not-a-pool", enabled: false }))
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { type: string } }
    expect(payload.error.type).toBe("validation_error")
  })

  it("PATCH enabled 非 boolean 返回 400", async () => {
    const response = await PATCH(patchRequest({ poolType: "openai", enabled: "yes" }))
    expect(response.status).toBe(400)
  })

  it("PATCH custom:* poolType 返回 400（不属于内置 provider）", async () => {
    const response = await PATCH(patchRequest({ poolType: "custom:abc", enabled: false }))
    expect(response.status).toBe(400)
  })
})
