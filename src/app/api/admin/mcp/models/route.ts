import { getDatabase } from "@/server/db"
import { listProviderModelCatalogs } from "@/server/provider-models"
import { requireAdministrator } from "../../_auth"

export const runtime = "nodejs"

/**
 * 已知支持图片输入（多模态）的模型名单，按模型名匹配。
 * 基于本账号池线上实测：minimax-m3、qwen3.7-plus 可识图；
 * grok-4.5 / gpt-5.6-luna / glm-5.2 等端点不可用或不支持图片，不列入。
 * 后续实测确认新模型可识图后在此追加。
 */
const VISION_MODEL_PATTERNS = [/^minimax-m3/i, /^qwen3\.[5-9]-(plus|max)/i]

function isVisionModel(model: string): boolean {
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model))
}

export async function GET(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const catalogs = listProviderModelCatalogs(getDatabase())
    .filter((catalog) => catalog.models.length > 0)
    .map((catalog) => ({
      poolType: catalog.poolType,
      label: catalog.label,
      models: catalog.models,
      visionModels: catalog.models.filter(isVisionModel),
    }))
  return Response.json({ catalogs })
}
