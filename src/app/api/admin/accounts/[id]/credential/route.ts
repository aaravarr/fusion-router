import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { requireSession } from "../../../_auth"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const account = new AccountRepository(user.id).get(id)
  if (!account) return Response.json({ error: { type: "not_found", message: "账号不存在" } }, { status: 404 })
  if (account.poolType === "opencode-go") {
    return Response.json({ error: { type: "not_supported", message: "OpenCode Go 账号凭据为浏览器会话，无原始 API Key" } }, { status: 400 })
  }
  const credential = new ProviderCredentialRepository(user.id).get(id)
  const token = credential?.token
  if (!token) return Response.json({ error: { type: "not_found", message: "未找到可复制的原始 API Key" } }, { status: 404 })
  return Response.json({ key: token })
}