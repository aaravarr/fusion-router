import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearActionDiscoveryCacheForTests, MANAGED_GO_KEY_NAME, OpenCodeWebClient, OpenCodeWebError } from "./client"

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

