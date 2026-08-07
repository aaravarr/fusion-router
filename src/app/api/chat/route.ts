import { z } from "zod"
import { requireSession } from "../admin/_auth"
import { GatewayService, type CredentialProvider } from "@/server/gateway"
import { getGoCredential } from "@/server/opencode-web/service"
import { getDatabase } from "@/server/db"
import { AccountRepository } from "@/server/repository"
import { listProviderModelCatalogs } from "@/server/provider-models"
import { listPoolTypeLabelMap } from "@/server/pool-type-options"
import { tryGetProvider } from "@/server/providers"
import type { PoolType } from "@/server/types"

export const runtime = "nodejs"
export const maxDuration = 300

const credentials: CredentialProvider = { get: getGoCredential }

const chatSchema = z.object({
  model: z.string().trim().min(1).max(200),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(200_000),
  })).min(1).max(100),
  interfaceType: z.enum(["chat", "responses"]).default("chat"),
  reasoningEffort: z.enum(["auto", "none", "minimal", "low", "medium", "high", "xhigh"]).default("auto"),
  routing: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }),
    z.object({ mode: z.literal("pool"), poolType: z.string().trim().min(1).max(100) }),
    z.object({ mode: z.literal("account"), accountId: z.string().trim().min(1).max(100) }),
  ]).default({ mode: "auto" }),
})

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const db = getDatabase()
  const repo = new AccountRepository(user.id, db)
  const poolLabels = listPoolTypeLabelMap(user.id, db)
  const blockedIds = new Set((db.prepare(`SELECT DISTINCT account_id FROM quota_windows
    WHERE owner_user_id=? AND usage_percent>=100 AND (reset_at IS NULL OR reset_at>?)`)
    .all(user.id, new Date().toISOString()) as Array<{ account_id: string }>).map((row) => row.account_id))
  const accounts = repo.list().map((account) => ({
    id: account.id,
    name: account.name,
    email: account.email,
    poolType: account.poolType,
    poolLabel: tryGetProvider(account.poolType)?.displayName ?? poolLabels.get(account.poolType) ?? (account.poolType.startsWith("custom:") ? account.poolType.slice(7, 15) : account.poolType),
    ready: (tryGetProvider(account.poolType)?.isAccountReady(account) ?? false) && !blockedIds.has(account.id),
    blocked: blockedIds.has(account.id),
  }))
  const catalogs = listProviderModelCatalogs(db, user.id)
  const pools = [...new Map(catalogs.map((catalog) => [catalog.poolType, {
    type: catalog.poolType,
    label: catalog.label,
    models: catalog.models.filter((model) => tryGetProvider(catalog.poolType)?.supportsEndpoint?.(model, "responses") !== false),
    readyAccounts: accounts.filter((account) => account.poolType === catalog.poolType && account.ready).length,
  }])).values()]

  return Response.json({
    models: [...new Set(pools.filter((pool) => pool.readyAccounts > 0).flatMap((pool) => pool.models))].sort(),
    pools,
    accounts,
    capabilities: { webSearch: false, mcp: false },
  })
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = chatSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", message: "聊天参数无效", details: parsed.error.flatten() } }, { status: 400 })
  }

  const { model, messages, interfaceType, reasoningEffort, routing } = parsed.data
  const body = interfaceType === "chat" ? {
    model,
    messages,
    stream: true,
    ...(reasoningEffort === "auto" ? {} : { reasoning_effort: reasoningEffort }),
  } : {
    model,
    input: messages.map((message) => ({ role: message.role, content: message.content })),
    stream: true,
    ...(reasoningEffort === "none"
      ? { reasoning: { effort: "none" } }
      : reasoningEffort === "auto"
        ? { reasoning: { summary: "auto" } }
        : { reasoning: { effort: reasoningEffort, summary: "auto" } }),
  }
  const gatewayRequest = new Request(request.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": request.headers.get("user-agent") ?? "dashboard-chat",
      "x-opencode-client": "dashboard-chat",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  })

  return new GatewayService(credentials).handle(gatewayRequest, interfaceType === "chat" ? "chat/completions" : "responses", {
    principal: { ownerUserId: user.id, label: "chat" },
    routing: routing.mode === "pool"
      ? { poolType: routing.poolType as PoolType }
      : routing.mode === "account" ? { accountId: routing.accountId } : undefined,
  })
}
