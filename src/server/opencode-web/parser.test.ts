import { describe, expect, it } from "vitest"
import { isLoginPage, parseGoDashboard, parseGoKeys, parseGoUsage, parseReferralSummary } from "./parser"

const usageHtml = `rollingUsage:$R[1]={usagePercent:12.5,resetInSec:300}
weeklyUsage:$R[2]={resetInSec:600,usagePercent:45}
monthlyUsage:$R[3]={usagePercent:99,resetInSec:900}`

describe("OpenCode Go 页面解析", () => {
  it("解析 5h、周、月额度并兼容字段顺序", () => {
    expect(parseGoUsage(usageHtml)).toEqual({
      FIVE_HOUR: { usagePercent: 12.5, resetInSeconds: 300 },
      WEEKLY: { usagePercent: 45, resetInSeconds: 600 },
      MONTHLY: { usagePercent: 99, resetInSeconds: 900 },
    })
  })

  it("hydration 缺失时兼容 data-slot 和缩写恢复时间", () => {
    const item = (label: string, percent: number, reset: string) => `<div data-slot="usage-item"><span data-slot="usage-label">${label}</span><span data-slot="usage-value">${percent}%</span><span data-slot="reset-time">Resets in ${reset}</span></div>`
    expect(parseGoUsage(`${item("5-hour", 5, "1h 30m")}${item("Weekly", 6, "2d")}${item("Monthly", 7, "45s")}`)).toEqual({
      FIVE_HOUR: { usagePercent: 5, resetInSeconds: 5_400 },
      WEEKLY: { usagePercent: 6, resetInSeconds: 172_800 },
      MONTHLY: { usagePercent: 7, resetInSeconds: 45 },
    })
  })

  it("通过 liteSubscriptionID 或订阅文案自动识别 Go 订阅", () => {
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_1",useBalance:false,Manage Subscription`)).toMatchObject({
      subscriptionExists: true,
      goSubscriptionId: "sub_go_1",
      hasManageSubscriptionButton: true,
      useBalance: false,
    })
    expect(parseGoDashboard(`${usageHtml}<p>You are subscribed to OpenCode Go.</p>,useBalance:true`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: null, useBalance: true })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_json","useBalance":false`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_json", useBalance: false })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_escaped",\\"useBalance\\":true`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_escaped", useBalance: true })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_minified",mine:!0,useBalance:!1`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_minified", useBalance: false })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_minified",mine:!0,useBalance:!0`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_minified", useBalance: true })
    expect(parseGoDashboard(usageHtml)).toMatchObject({ subscriptionExists: false, goSubscriptionId: null, useBalance: null })
  })

  it("区分 Zen 与 Go 的订阅 ID", () => {
    expect(parseGoDashboard(`liteSubscriptionID:"sub_go",subscriptionID:"sub_zen"`)).toMatchObject({
      subscriptionExists: true,
      goSubscriptionId: "sub_go",
      isZenSubscribed: true,
      zenSubscriptionId: "sub_zen",
    })
  })

  it("解析完整密钥且识别登录页", () => {
    const html = `{id:"key_abc",name:"OpenCode to API",key:"sk-secret",createdAt:"x",userID:"usr_1",email:"a@example.com",keyDisplay:"sk-...cret"}`
    expect(parseGoKeys(html)[0]).toMatchObject({ id: "key_abc", key: "sk-secret", email: "a@example.com" })
    expect(isLoginPage("<html><head><title>OpenAuth</title></head></html>")).toBe(true)
  })
})

describe("邀请奖励解析", () => {
  const availableEntry = '{id:"ref_01KX08X8V2NC05H3BV6RW49WNH",source:"inviter",status:"available",email:"ahao.study@gmail.com",amount:500,timeCreated:$R[35]=new Date("2026-07-08T04:32:05.000Z"),timeApplied:null}'
  const appliedEntry = '{id:"ref_01KWZZSTG7J5W3CCDCKHGCCDEN",source:"inviter",status:"applied",email:"roseanncorbinn1sim@alazinst.org",amount:500,timeCreated:$R[35]=new Date("2026-07-08T04:32:05.000Z"),timeApplied:$R[36]=new Date("2026-07-08T07:18:37.000Z")}'
  const pendingEntry = '{id:"ref_abc123:inviter",source:"inviter",status:"pending",email:null,amount:500,timeCreated:new Date("2026-07-09T00:00:00.000Z"),timeApplied:null}'

  it("解析 available/applied/pending 奖励与 summary 字段", () => {
    const html = `window.xxx\u0022go.referral.get[\u0022wrk_01KRWCTZC3S4H5GXG0RACMCM36\u0022]\u0022]=$R[13]=$R[2]($R[14]={p:0,s:0,f:0});referralCode:"VNWWDQARJ6",rewardAmount:500,rewards:[${availableEntry},${appliedEntry},${pendingEntry}]`
    const summary = parseReferralSummary(html)
    expect(summary).toEqual({
      referralCode: "VNWWDQARJ6",
      rewardAmount: 500,
      rewards: [
        { id: "ref_01KX08X8V2NC05H3BV6RW49WNH", source: "inviter", status: "available", email: "ahao.study@gmail.com", amount: 500, timeCreated: "2026-07-08T04:32:05.000Z", timeApplied: null },
        { id: "ref_01KWZZSTG7J5W3CCDCKHGCCDEN", source: "inviter", status: "applied", email: "roseanncorbinn1sim@alazinst.org", amount: 500, timeCreated: "2026-07-08T04:32:05.000Z", timeApplied: "2026-07-08T07:18:37.000Z" },
        { id: "ref_abc123:inviter", source: "inviter", status: "pending", email: null, amount: 500, timeCreated: "2026-07-09T00:00:00.000Z", timeApplied: null },
      ],
    })
  })

  it("email 为 null 与 invitee 来源的奖励", () => {
    const html = `go.referral.get[\u0022wrk_x\u0022],referralCode:"X1",rewardAmount:500,rewards:[${' {id:"ref_a:invitee",source:"invitee",status:"pending",email:null,amount:500,timeCreated:new Date("2026-07-10T00:00:00.000Z"),timeApplied:null}' }]`
    const summary = parseReferralSummary(html)
    expect(summary?.rewards[0]).toMatchObject({ id: "ref_a:invitee", source: "invitee", status: "pending", email: null })
  })

  it("找不到 go.referral.get 标记时返回 null", () => {
    expect(parseReferralSummary("<html><body>no referrals here</body></html>")).toBeNull()
  })
})

