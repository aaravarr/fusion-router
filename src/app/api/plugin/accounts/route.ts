import { z } from "zod"
import { randomUUID } from "node:crypto"
import { authenticateApiKey, type ApiKeyRecord } from "@/server/repository"
import { AccountOwnershipConflictError } from "@/server/repository"
import { OpenCodeWebError } from "@/server/opencode-web/client"
import { getOpenCodeWebService, type ReportBrowserAccountInput } from "@/server/opencode-web/service"
import { getDatabase } from "@/server/db"

export const runtime = "nodejs"
const schema = z.object({
  authCookie: z.string().min(20).max(16_384),
  workspaceId: z.string().regex(/^wrk_[A-Za-z0-9]+$/),
  extensionVersion: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100).optional(),
})
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,x-api-key,content-type", "Access-Control-Allow-Methods": "POST,OPTIONS" }

function recordEvent(ownerUserId: string, type: string, severity: "INFO" | "WARN" | "ERROR", accountId: string | null, metadata: Record<string, unknown>): void {
  try {
    const db = getDatabase()
    db.prepare("INSERT INTO events(id,owner_user_id,type,severity,account_id,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), ownerUserId, type, severity, accountId, null, JSON.stringify(metadata), new Date().toISOString())
  } catch {
    // 事件写入失败不应阻断账号录入主流程
  }
}

interface PluginAccountDependencies {
  authenticate(key: string): (ApiKeyRecord & { hash: string }) | null
  report(ownerUserId: string, input: ReportBrowserAccountInput): Promise<{ id: string; name: string; email: string | null; workspaceId: string }>
}

export function createPluginAccountPost(dependencies: PluginAccountDependencies) {
  return async (request: Request) => {
    const authorization = request.headers.get("authorization")
    const plaintext = authorization?.startsWith("Bearer ") ? authorization.slice(7) : request.headers.get("x-api-key") ?? ""
    const apiKey = dependencies.authenticate(plaintext)
    if (!apiKey) return Response.json({ error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401, headers: cors })
    const input = schema.safeParse(await request.json().catch(() => null))
    if (!input.success) return Response.json({ error: { type: "validation_error", details: input.error.flatten() } }, { status: 400, headers: cors })
    try {
      // 扩展上报来自真实浏览器：透传其 UA 给 opencode.ai 控制面（录入会拉取页面/创建 key）。
      const account = await dependencies.report(apiKey.ownerUserId, { ...input.data, userAgent: request.headers.get("user-agent") ?? undefined })
      recordEvent(apiKey.ownerUserId, "ACCOUNT_CONNECTED", "INFO", account.id, {
        apiKeyId: apiKey.id,
        apiKeyName: apiKey.name,
        apiKeyPrefix: apiKey.prefix,
        workspaceId: input.data.workspaceId,
        accountName: account.name,
        accountEmail: account.email,
        extensionVersion: input.data.extensionVersion ?? null,
      })
      return Response.json({ account, message: "账号已连接，OpenCode Go Key 与额度已同步。" }, { status: 201, headers: cors })
    } catch (cause) {
      const errorType = cause instanceof AccountOwnershipConflictError ? "workspace_conflict"
        : cause instanceof OpenCodeWebError && cause.code === "AUTH" ? "opencode_auth_invalid"
        : "account_sync_failed"
      const status = cause instanceof AccountOwnershipConflictError ? 409
        : cause instanceof OpenCodeWebError && cause.code === "AUTH" ? 422
        : 502
      const message = cause instanceof Error ? cause.message : "Account sync failed"
      recordEvent(apiKey.ownerUserId, "ACCOUNT_CONNECT_FAILED", "ERROR", null, {
        apiKeyId: apiKey.id,
        apiKeyName: apiKey.name,
        apiKeyPrefix: apiKey.prefix,
        workspaceId: input.data.workspaceId,
        errorType,
        message,
        extensionVersion: input.data.extensionVersion ?? null,
      })
      return Response.json({ error: { type: errorType, message } }, { status, headers: cors })
    }
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: cors }) }
export const POST = createPluginAccountPost({
  authenticate: (key) => authenticateApiKey(key),
  report: (ownerUserId, input) => getOpenCodeWebService(ownerUserId).report(input) as Promise<{ id: string; name: string; email: string | null; workspaceId: string }>,
})
