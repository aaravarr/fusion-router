import { getDatabase } from "@/server/db"
import { listProviderModelCatalogs } from "@/server/provider-models"
import { filterVisionModels } from "@/server/mcp/openrouter-models"
import { requireAdministrator } from "../../_auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const db = getDatabase()
  const catalogs = await Promise.all(
    listProviderModelCatalogs(db)
      .filter((catalog) => catalog.models.length > 0)
      .map(async (catalog) => ({
        poolType: catalog.poolType,
        label: catalog.label,
        models: catalog.models,
        // 基于 OpenRouter 模型目录判断支持图片输入（多模态）的模型
        visionModels: await filterVisionModels(catalog.models, db),
      })),
  )
  return Response.json({ catalogs })
}
