import { authenticateApiKey } from "@/server/repository"
import { getOpenCodeWebService } from "@/server/opencode-web/service"
import { createPluginAccountPost, pluginCors } from "./handler"

export const runtime = "nodejs"

export function OPTIONS() { return new Response(null, { status: 204, headers: pluginCors }) }
export const POST = createPluginAccountPost({
  authenticate: (key) => authenticateApiKey(key),
  report: (ownerUserId, input) => getOpenCodeWebService(ownerUserId).report(input) as Promise<{ id: string; name: string; email: string | null; workspaceId: string }>,
})
