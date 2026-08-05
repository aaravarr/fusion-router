import { getDatabase } from "@/server/db"
import { listProviderModelCatalogs } from "@/server/provider-models"
import { requireAdministrator } from "../../_auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireAdministrator(request)
  if (user instanceof Response) return user
  const catalogs = listProviderModelCatalogs(getDatabase())
    .filter((catalog) => catalog.models.length > 0)
    .map((catalog) => ({ poolType: catalog.poolType, label: catalog.label, models: catalog.models }))
  return Response.json({ catalogs })
}
