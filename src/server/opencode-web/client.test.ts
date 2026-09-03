import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearActionDiscoveryCacheForTests, MANAGED_GO_KEY_NAME, OpenCodeWebClient, OpenCodeWebError, OPENCODE_WEB_DEFAULT_USER_AGENT } from "./client"

const existing = (id: string, name = MANAGED_GO_KEY_NAME, key = "sk-managed") => `{id:"${id}",name:"${name}",key:"${key}",createdAt:"x",userID:"usr_1",email:"a@example.com",keyDisplay:"sk-..."}`
const hash = "a".repeat(64)

describe("OpenCode Web client", () => {
  beforeEach(() => clearActionDiscoveryCacheForTests())

  it("已有命名密钥时直接复用，不创建新密钥", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(existing("key_old")))
    const key = await new OpenCodeWebClient({ fetch: fetcher }).ensureManagedKey("cookie-value", "wrk_abc")
    expect(key.id).toBe("key_old")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("创建后优先选取前后 ID 差分中的命名密钥", async () => {
    let keyPage = 0
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/workspace/wrk_abc/keys")) {
        keyPage += 1
        return new Response(keyPage === 1 ? existing("key_other", "Other", "sk-old") : `${existing("key_other", "Other", "sk-old")}${existing("key_new", MANAGED_GO_KEY_NAME, "sk-new")}`)
      }
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/keys/index.tsx import("./index-keys.js")')
      if (url.endsWith("index-keys.js")) return new Response(`const x=createServerReference("${hash}"); const y=action(x,"key.create")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) return new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ result: { data: { id: "key_new" } } }))}; Path=/` } })
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const key = await new OpenCodeWebClient({ fetch: fetcher }).ensureManagedKey("cookie-value", "wrk_abc")
    expect(key).toMatchObject({ id: "key_new", key: "sk-new" })
  })

  it("302 但缺少 flash 时失败关闭", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/workspace/wrk_abc/keys")) return new Response("")
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/keys/index.tsx import("./index-keys.js")')
      if (url.endsWith("index-keys.js")) return new Response(`const x=createServerReference("${hash}"); const y=action(x,"key.create")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) return new Response(null, { status: 302 })
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).ensureManagedKey("cookie-value", "wrk_abc")).rejects.toMatchObject({ code: "UPSTREAM" } satisfies Partial<OpenCodeWebError>)
  })

  it("重定向登录时标记凭据过期", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "/auth" } })) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).dashboard("expired-cookie", "wrk_abc")).rejects.toMatchObject({ code: "AUTH" } satisfies Partial<OpenCodeWebError>)
  })
})

describe("OpenCode referral 兑换", () => {
  beforeEach(() => clearActionDiscoveryCacheForTests())

  const rewardEntry = '{id:"ref_01KX08X8V2NC05H3BV6RW49WNH",source:"inviter",status:"available",email:"ahao.study@gmail.com",amount:500,timeCreated:$R[35]=new Date("2026-07-08T04:32:05.000Z"),timeApplied:null}'
  const goPage = (extra = "") => `<html>go.referral.get["wrk_abc"]"]=$R[13]=$R[2]($R[14]={p:0,s:0,f:0});referralCode:"VNWWDQARJ6",rewardAmount:500,rewards:[${rewardEntry}]${extra}</html>`

  it("referrals 从 go 页面解析奖励摘要", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(goPage())) as typeof fetch
    const summary = await new OpenCodeWebClient({ fetch: fetcher }).referrals("cookie", "wrk_abc")
    expect(summary).toMatchObject({
      referralCode: "VNWWDQARJ6",
      rewardAmount: 500,
      rewards: [{ id: "ref_01KX08X8V2NC05H3BV6RW49WNH", status: "available", email: "ahao.study@gmail.com", amount: 500 }],
    })
  })

  it("apply 走 GET+args 通道并在 302 无错误时成功（flash 成功）", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/workspace/wrk_abc/go")) return new Response(goPage())
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const applyGoReferralReward_action=createServerReference("${hash}"); const applyGoReferralReward=action(applyGoReferralReward_action,"go.referral.reward.apply")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) {
        // 校验请求形态：GET + X-Server-Id header + args 参数
        expect(init?.method).toBe("GET")
        const headers = new Headers(init?.headers)
        expect(headers.get("X-Server-Id")).toBe(hash)
        expect(url).toContain("args=" + encodeURIComponent(JSON.stringify(["wrk_abc", "ref_01KX08X8V2NC05H3BV6RW49WNH"])))
        return new Response(";fake-seroval-body", { status: 200 })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_01KX08X8V2NC05H3BV6RW49WNH")).resolves.toBeUndefined()
  })

  it("apply 上游业务失败（x-error header）抛出 UPSTREAM 且带上游消息", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const a=createServerReference("${hash}"); const b=action(a,"go.referral.reward.apply")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) {
        return new Response(`;((self.$R)["server-fn:x"]=[],($R=>$R[0]=Object.assign(new Error("Subscribe to Go before applying referral rewards"),{})))($R["server-fn:x"]))`, {
          status: 200,
          headers: { "x-error": "Subscribe to Go before applying referral rewards" },
        })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_x")).rejects.toMatchObject({
      code: "UPSTREAM",
      message: "Subscribe to Go before applying referral rewards",
    } satisfies Partial<OpenCodeWebError>)
  })

  it("apply 302 + flash 无错误时视为成功", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const a=createServerReference("${hash}"); const b=action(a,"go.referral.reward.apply")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) {
        return new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ result: { applied: true } }))}; Path=/` } })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_x")).resolves.toBeUndefined()
  })

  it("apply 302 + flash 失败时抛出 UPSTREAM 且带上游消息", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const a=createServerReference("${hash}"); const b=action(a,"go.referral.reward.apply")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) {
        return new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ error: true, result: { error: "Reward already applied" } }))}; Path=/` } })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_x")).rejects.toMatchObject({
      code: "UPSTREAM",
      message: "Reward already applied",
    } satisfies Partial<OpenCodeWebError>)
  })

  it("apply 302 到 /auth 时标记 AUTH", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const a=createServerReference("${hash}"); const b=action(a,"go.referral.reward.apply")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) {
        return new Response(null, { status: 302, headers: { location: "/auth/authorize" } })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_x")).rejects.toMatchObject({
      code: "AUTH",
    } satisfies Partial<OpenCodeWebError>)
  })
})

describe("OpenCode chinaProviders 开关提交格式", () => {
  beforeEach(() => clearActionDiscoveryCacheForTests())

  const goChunk = `const setGoProviderRouting_action=createServerReference("${hash}"); const setGoProviderRouting=action(setGoProviderRouting_action,"go.providerRouting.set")`

  const discoveryFetcher = (onServer: (url: string, init: RequestInit | undefined) => Response) => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(goChunk)
      if (url.startsWith("https://opencode.ai/_server?id=")) return onServer(url, init)
      return new Response(null, { status: 404 })
    })
    return fetcher as unknown as typeof fetch
  }

  const flashOk = () => new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ result: { data: null } }))}; Path=/` } })

  it("开启时提交 useChinaProviders=true（上游按 === \"true\" 解析，\"on\" 会被误判为 false）", async () => {
    const fetcher = discoveryFetcher((url, init) => {
      expect(url).toContain(`id=${hash}`)
      const body = String(init?.body)
      expect(body).toContain("workspaceID=wrk_abc")
      expect(body).toContain("useChinaProviders=true")
      expect(body).not.toContain("useChinaProviders=on")
      return flashOk()
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setChinaProviders("cookie", "wrk_abc", true)).resolves.toBeUndefined()
  })

  it("关闭时提交 useChinaProviders=false（不再是空串）", async () => {
    const fetcher = discoveryFetcher((_url, init) => {
      const body = String(init?.body)
      expect(body).toContain("useChinaProviders=false")
      return flashOk()
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setChinaProviders("cookie", "wrk_abc", false)).resolves.toBeUndefined()
  })

  it("302 但缺少 flash 时失败关闭；上游业务错误抛 UPSTREAM", async () => {
    const noFlash = discoveryFetcher(() => new Response(null, { status: 302 }))
    await expect(new OpenCodeWebClient({ fetch: noFlash }).setChinaProviders("cookie", "wrk_abc", true)).rejects.toMatchObject({ code: "UPSTREAM" } satisfies Partial<OpenCodeWebError>)
    const flashErr = discoveryFetcher(() => new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ error: true, result: { error: "nope" } }))}; Path=/` } }))
    await expect(new OpenCodeWebClient({ fetch: flashErr }).setChinaProviders("cookie", "wrk_abc", true)).rejects.toMatchObject({ code: "UPSTREAM" } satisfies Partial<OpenCodeWebError>)
  })

  it("传入 userAgent 时 /_server 请求携带操作者 UA；不传用网关默认", async () => {
    const operatorUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0"
    const seen: Array<string | null> = []
    const fetcher = discoveryFetcher((_url, init) => {
      seen.push(new Headers(init?.headers).get("user-agent"))
      return flashOk()
    })
    const client = new OpenCodeWebClient({ fetch: fetcher })
    await client.setChinaProviders("cookie", "wrk_abc", true, { userAgent: operatorUA })
    clearActionDiscoveryCacheForTests()
    await client.setChinaProviders("cookie", "wrk_abc", false)
    expect(seen).toEqual([operatorUA, OPENCODE_WEB_DEFAULT_USER_AGENT])
  })
})

describe("OpenCode allowTraining 开关", () => {
  beforeEach(() => clearActionDiscoveryCacheForTests())

  const goChunk = `const setGoAllowTraining_action=createServerReference("${hash}"); const setGoAllowTraining=action(setGoAllowTraining_action,"go.allowTraining.set")`

  // action 发现链：首页 → entry-client → go 路由 chunk；/_server 行为由 onServer 自定义。
  const discoveryFetcher = (onServer: (url: string, init: RequestInit | undefined) => Response) => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(goChunk)
      if (url.startsWith("https://opencode.ai/_server?id=")) return onServer(url, init)
      return new Response(null, { status: 404 })
    })
    return fetcher as unknown as typeof fetch
  }

  const flashOk = () => new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ result: { data: null } }))}; Path=/` } })

  it("开启时向上游表单提交 allowTraining=true（显式布尔串，对齐上游 === \"true\" 解析）", async () => {
    const fetcher = discoveryFetcher((url, init) => {
      expect(url).toContain(`id=${hash}`)
      expect(init?.method).toBe("POST")
      const body = String(init?.body)
      expect(body).toContain("workspaceID=wrk_abc")
      expect(body).toContain("allowTraining=true")
      return flashOk()
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setAllowTraining("cookie", "wrk_abc", true)).resolves.toBeUndefined()
  })

  it("关闭时提交 allowTraining=false", async () => {
    const fetcher = discoveryFetcher((_url, init) => {
      expect(String(init?.body)).toContain("allowTraining=false")
      return flashOk()
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setAllowTraining("cookie", "wrk_abc", false)).resolves.toBeUndefined()
  })

  it("302 但缺少 flash 时失败关闭", async () => {
    const fetcher = discoveryFetcher(() => new Response(null, { status: 302 }))
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setAllowTraining("cookie", "wrk_abc", true)).rejects.toMatchObject({ code: "UPSTREAM" } satisfies Partial<OpenCodeWebError>)
  })

  it("flash 带业务错误时抛出 UPSTREAM", async () => {
    const fetcher = discoveryFetcher(() => new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ error: true, result: { error: "nope" } }))}; Path=/` } }))
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setAllowTraining("cookie", "wrk_abc", true)).rejects.toMatchObject({ code: "UPSTREAM" } satisfies Partial<OpenCodeWebError>)
  })

  it("401/403 标记 AUTH", async () => {
    const fetcher = discoveryFetcher(() => new Response(null, { status: 403 }))
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setAllowTraining("cookie", "wrk_abc", true)).rejects.toMatchObject({ code: "AUTH" } satisfies Partial<OpenCodeWebError>)
  })

  it("chunk 缺少 go.allowTraining.set 时抛 PROTOCOL", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const a=createServerReference("${hash}"); const b=action(a,"go.providerRouting.set")`)
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).setAllowTraining("cookie", "wrk_abc", true)).rejects.toMatchObject({ code: "PROTOCOL", message: "OpenCode go.allowTraining.set action was not found" } satisfies Partial<OpenCodeWebError>)
  })

  it("传入 userAgent 时 /_server 请求携带操作者 UA；不传用网关默认", async () => {
    const operatorUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0"
    const seen: Array<string | null> = []
    const fetcher = discoveryFetcher((_url, init) => {
      seen.push(new Headers(init?.headers).get("user-agent"))
      return flashOk()
    })
    const client = new OpenCodeWebClient({ fetch: fetcher })
    await client.setAllowTraining("cookie", "wrk_abc", true, { userAgent: operatorUA })
    clearActionDiscoveryCacheForTests()
    await client.setAllowTraining("cookie", "wrk_abc", false)
    expect(seen).toEqual([operatorUA, OPENCODE_WEB_DEFAULT_USER_AGENT])
  })
})

describe("OpenCode Web client User-Agent 透传", () => {
  beforeEach(() => clearActionDiscoveryCacheForTests())

  const operatorUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0"

  // 兑换 action 发现的通用资源响应；/_server 行为由各用例的 onServer 自定义。
  const discoveryFetcher = (onServer: (init: RequestInit | undefined, callCount: number) => Response) => {
    let serverCalls = 0
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/go/index.tsx import("./index-go.js")')
      if (url.endsWith("index-go.js")) return new Response(`const a=createServerReference("${hash}"); const b=action(a,"go.referral.reward.apply")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) { serverCalls += 1; return onServer(init, serverCalls) }
      return new Response(null, { status: 404 })
    })
    return { fetcher: fetcher as unknown as typeof fetch, serverCallCount: () => serverCalls }
  }

  it("apply 传入 userAgent：/_server 兑换请求携带操作者 UA", async () => {
    const { fetcher } = discoveryFetcher((init) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe(operatorUA)
      return new Response(";ok", { status: 200 })
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_1", { userAgent: operatorUA })).resolves.toBeUndefined()
  })

  it("apply 不传 userAgent：/_server 兑换请求用网关自标识默认 UA", async () => {
    const { fetcher } = discoveryFetcher((init) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe(OPENCODE_WEB_DEFAULT_USER_AGENT)
      return new Response(";ok", { status: 200 })
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_1")).resolves.toBeUndefined()
  })

  it("apply 重试后仍携带传入的 userAgent", async () => {
    const { fetcher, serverCallCount } = discoveryFetcher((init, callCount) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe(operatorUA)
      // 第一次 302 且无 flash → 触发重试；第二次 200 成功
      return callCount === 1 ? new Response(null, { status: 302 }) : new Response(";ok", { status: 200 })
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_1", { userAgent: operatorUA })).resolves.toBeUndefined()
    expect(serverCallCount()).toBe(2)
  })

  it("referrals 传入 userAgent：go 页面请求携带操作者 UA；不传则用默认", async () => {
    const goPage = "<html>go.referral.get;referralCode:\"X\",rewardAmount:0,rewards:[]</html>"
    const seen: Array<string | null> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/workspace/wrk_abc/go")) { seen.push(new Headers(init?.headers).get("user-agent")); return new Response(goPage) }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const client = new OpenCodeWebClient({ fetch: fetcher })
    await client.referrals("cookie", "wrk_abc", { userAgent: operatorUA })
    await client.referrals("cookie", "wrk_abc")
    expect(seen).toEqual([operatorUA, OPENCODE_WEB_DEFAULT_USER_AGENT])
  })

  it("空白 userAgent 回落默认值", async () => {
    const { fetcher } = discoveryFetcher((init) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe(OPENCODE_WEB_DEFAULT_USER_AGENT)
      return new Response(";ok", { status: 200 })
    })
    await expect(new OpenCodeWebClient({ fetch: fetcher }).applyReferralReward("cookie", "wrk_abc", "ref_1", { userAgent: "   " })).resolves.toBeUndefined()
  })
})

