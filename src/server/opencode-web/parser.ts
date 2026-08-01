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
  return {
    subscriptionExists: subscribedText || Boolean(goSubscriptionId),
    goSubscriptionId,
    isZenSubscribed: Boolean(zenSubscriptionId),
    zenSubscriptionId,
    hasManageSubscriptionButton: html.includes("Manage Subscription"),
    useBalance: balance === "true" || balance === "!0" ? true : balance === "false" || balance === "!1" ? false : null,
    useChinaProviders: chinaValue === "true" ? true : chinaValue === "false" ? false : null,
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

export function isLoginPage(html: string): boolean {
  const head = html.slice(0, 1_500)
  return head.includes("<title>OpenAuth</title>") || head.includes("/github/authorize") || head.includes("/google/authorize")
}

export const usageKinds: readonly QuotaKind[] = ["FIVE_HOUR", "WEEKLY", "MONTHLY"]
