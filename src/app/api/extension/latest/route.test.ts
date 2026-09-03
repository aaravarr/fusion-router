import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(async () => new Response(
    JSON.stringify({ tag_name: "v1.2.3", html_url: "https://github.com/x/r/releases/tag/v1.2.3", body: null, assets: [] }),
    { status: 200 },
  )),
}))

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici")
  return { ...actual, fetch: mocks.undiciFetch }
})

import { Agent } from "undici"
import { createDatabase, type AppDatabase } from "@/server/db"
import { getProxyDispatcher } from "@/server/api-fetch"
import { GET } from "./route"

const PROXY_ENVS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const

function setGlobalDatabase(value: AppDatabase | undefined) {
  (globalThis as typeof globalThis & { __opencodeApiDb?: AppDatabase }).__opencodeApiDb = value
}

describe("/api/extension/latest", () => {
  beforeEach(() => {
    setGlobalDatabase(createDatabase(":memory:"))
    for (const key of PROXY_ENVS) vi.stubEnv(key, undefined)
  })
  afterEach(() => {
    setGlobalDatabase(undefined)
    vi.unstubAllEnvs()
  })

  function dispatcherAt(call: number): unknown {
    const init = mocks.undiciFetch.mock.calls[call]?.[1] as { dispatcher?: unknown } | undefined
    return init?.dispatcher
  }

  it("配置代理环境变量时复用 getProxyDispatcher 的进程级缓存实例", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:17890")
    await GET()
    await GET()
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(2)
    expect(dispatcherAt(0)).toBe(getProxyDispatcher("http://127.0.0.1:17890"))
    expect(dispatcherAt(1)).toBe(dispatcherAt(0))
  })

  it("未配置代理时共享同一个直连 Agent 实例", async () => {
    await GET()
    await GET()
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(2)
    expect(dispatcherAt(0)).toBeInstanceOf(Agent)
    expect(dispatcherAt(1)).toBe(dispatcherAt(0))
  })
})
