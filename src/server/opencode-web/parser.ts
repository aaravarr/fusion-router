import type { QuotaKind } from "@/server/types"

export interface ParsedGoKey {
  id: string
  name: string
  key: string
  userId: string
  email: string
  keyDisplay: string
}

export interface ParsedUsageWindow {
  usagePercent: number
  resetInSeconds: number
}

export type ParsedUsage = Record<"FIVE_HOUR" | "WEEKLY" | "MONTHLY", ParsedUsageWindow>
export interface ParsedGoDashboard {
  subscriptionExists: boolean
  goSubscriptionId: string | null
  isZenSubscribed: boolean
  zenSubscriptionId: string | null
  hasManageSubscriptionButton: boolean
  useBalance: boolean | null
  useChinaProviders: boolean | null
  allowTraining: boolean | null
  usage: ParsedUsage | null
}

const number = "(-?\\d+(?:\\.\\d+)?)"

function parseHydrationWindow(html: string, name: string): ParsedUsageWindow | null {
  const percentFirst = new RegExp(
    `${name}Usage:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${number}[^}]*resetInSec:${number}[^}]*\\}`,
  ).exec(html)
  if (percentFirst) return windowValue(percentFirst[1], percentFirst[2])
  const resetFirst = new RegExp(
    `${name}Usage:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${number}[^}]*usagePercent:${number}[^}]*\\}`,
  ).exec(html)
  return resetFirst ? windowValue(resetFirst[2], resetFirst[1]) : null
}

function windowValue(percent: string, reset: string): ParsedUsageWindow | null {
  const usagePercent = Number(percent)
  const resetInSeconds = Number(reset)
  if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSeconds)) return null
  return { usagePercent: Math.max(0, usagePercent), resetInSeconds: Math.max(0, resetInSeconds) }
}

function parseHumanTime(value: string): number | null {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim()
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) return 0
  let total = 0
  let matched = false
  for (const [unit, seconds] of [["(?:days?|d)", 86_400], ["(?:hours?|hrs?|h)", 3_600], ["(?:minutes?|mins?|m)", 60], ["(?:seconds?|secs?|s)", 1]] as const) {
    const match = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`).exec(normalized)
    if (!match) continue
    total += Number(match[1]) * seconds
    matched = true
  }
  return matched ? total : null
}

function parseDataSlots(html: string): Partial<ParsedUsage> {
  const result: Partial<ParsedUsage> = {}
  for (const part of html.split('data-slot="usage-item"').slice(1)) {
    const label = /data-slot="usage-label">([^<]+)</.exec(part)?.[1]?.trim().toLowerCase()
    const percent = /data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/.exec(part)?.[1]
    const reset = /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/.exec(part)
    if (!label || !percent || !reset) continue
    const content = reset[2]
      .replace(/<!--\/?\$-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim()
    const resetInSeconds = reset[1] === "reset-now" ? 0 : parseHumanTime(content)
    if (resetInSeconds === null) continue
    const kind: keyof ParsedUsage | undefined = label.includes("rolling") || label.includes("5 hour") || label.includes("5-hour")
      ? "FIVE_HOUR"
      : label.includes("weekly")
        ? "WEEKLY"
        : label.includes("monthly")
          ? "MONTHLY"
          : undefined
    if (kind) result[kind] = { usagePercent: Math.max(0, Number(percent)), resetInSeconds }
  }
  return result
}

export function parseGoUsage(html: string): ParsedUsage | null {
  const slots = parseDataSlots(html)
  const rolling = parseHydrationWindow(html, "rolling") ?? slots.FIVE_HOUR
  const weekly = parseHydrationWindow(html, "weekly") ?? slots.WEEKLY
  const monthly = parseHydrationWindow(html, "monthly") ?? slots.MONTHLY
  return rolling && weekly && monthly ? { FIVE_HOUR: rolling, WEEKLY: weekly, MONTHLY: monthly } : null
}

export function parseGoDashboard(html: string): ParsedGoDashboard {
  const usage = parseGoUsage(html)
  const balance = /(?:useBalance|["']useBalance["']|\\["']useBalance\\["'])\s*:\s*(?:\$R\[\d+\]=)?(true|false|!0|!1)/.exec(html)?.[1]
  const goSubscriptionId = /liteSubscriptionID:"([^"]+)"/.exec(html)?.[1] ?? null
  const zenSubscriptionId = /subscriptionID:"([^"]+)"/.exec(html)?.[1] ?? null
  const subscribedText = html.includes("You are subscribed to OpenCode Go")
  const chinaValue = /name="useChinaProviders"\s+value="(true|false)"/.exec(html)?.[1]
  // allowTraining 当前状态只能从 hydration 数据读取（与 useBalance 同一序列化对象）。
  // 上游页面里 name="allowTraining" 的 hidden input 持有的是点击后要提交的“目标值”
  // （sub().allowTraining ? "false" : "true"，与当前状态相反），不能用它判断当前状态。
  const training = /(?:allowTraining|["']allowTraining["']|\\["']allowTraining\\["'])\s*:\s*(?:\$R\[\d+\]=)?(true|false|!0|!1)/.exec(html)?.[1]
  return {
    subscriptionExists: subscribedText || Boolean(goSubscriptionId),
    goSubscriptionId,
    isZenSubscribed: Boolean(zenSubscriptionId),
    zenSubscriptionId,
    hasManageSubscriptionButton: html.includes("Manage Subscription"),
    useBalance: balance === "true" || balance === "!0" ? true : balance === "false" || balance === "!1" ? false : null,
    useChinaProviders: chinaValue === "true" ? true : chinaValue === "false" ? false : null,
    allowTraining: training === "true" || training === "!0" ? true : training === "false" || training === "!1" ? false : null,
    usage,
  }
}

export function parseGoKeys(html: string): ParsedGoKey[] {
  const result: ParsedGoKey[] = []
  const pattern = /\{id:"(key_[^"]+)",name:"([^"]*)",key:"(sk-[^"]+)",[^}]*?userID:"([^"]*)",email:"([^"]*)",keyDisplay:"([^"]*)"/g
  for (const match of html.matchAll(pattern)) {
    result.push({ id: match[1], name: match[2], key: match[3], userId: match[4], email: match[5], keyDisplay: match[6] })
  }
  return result
}

export interface ParsedReferralReward {
  id: string
  source: "inviter" | "invitee"
  status: "available" | "applied" | "pending"
  email: string | null
  amount: number
  timeCreated: string | null
  timeApplied: string | null
}

export interface ParsedReferralSummary {
  referralCode: string | null
  rewardAmount: number | null
  rewards: ParsedReferralReward[]
}

// WorkSpace Go 页面 hydration 中 go.referral.get 序列化片段样例：
//   {id:"ref_01KX08X8V2NC05H3BV6RW49WNH",source:"inviter",status:"available",email:"ahao.study@gmail.com",amount:500,timeCreated:$R[35]=new Date("2026-07-08T04:32:05.000Z"),timeApplied:null}
//   {id:"<referralId>:inviter",source:"inviter",status:"pending",email:null,amount:500,timeCreated:...}
// email 可能带引号或为 null；timeApplied 可能为 null；时间值可能带 $R[x]= 引用前缀。
const REFERRAL_REWARD_PATTERN = /{id:"([^"]+)",source:"([a-z]+)",status:"([a-z]+)",email:([^,}]+),amount:(\d+),timeCreated:[^}]*?new Date\("([^"]+)"\),timeApplied:(?:[^}]*?new Date\("([^"]+)"\)|null)\}/g
const REFERRAL_SLICE_LENGTH = 20_000

function cleanReferralEmail(raw: string): string | null {
  const value = raw.trim()
  if (value === "null" || value === "") return null
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}

export function parseReferralSummary(html: string): ParsedReferralSummary | null {
  const markerIndex = html.indexOf("go.referral.get")
  if (markerIndex < 0) return null
  const slice = html.slice(markerIndex, markerIndex + REFERRAL_SLICE_LENGTH)
  const referralCode = /referralCode:"([^"]+)"/.exec(slice)?.[1] ?? null
  const rewardAmountRaw = /rewardAmount:(\d+)/.exec(slice)?.[1]
  const rewards: ParsedReferralReward[] = []
  REFERRAL_REWARD_PATTERN.lastIndex = 0
  for (const match of slice.matchAll(REFERRAL_REWARD_PATTERN)) {
    rewards.push({
      id: match[1],
      source: match[2] === "invitee" ? "invitee" : "inviter",
      status: match[3] === "applied" ? "applied" : match[3] === "pending" ? "pending" : "available",
      email: cleanReferralEmail(match[4]),
      amount: Number(match[5]),
      timeCreated: match[6] ?? null,
      timeApplied: match[7] ?? null,
    })
  }
  return { referralCode, rewardAmount: rewardAmountRaw ? Number(rewardAmountRaw) : null, rewards }
}

export function isLoginPage(html: string): boolean {
  const head = html.slice(0, 1_500)
  return head.includes("<title>OpenAuth</title>") || head.includes("/github/authorize") || head.includes("/google/authorize")
}

export const usageKinds: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY", "MONTHLY"]
