export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { startMaintenanceScheduler } = await import("@/server/opencode/maintenance")
  startMaintenanceScheduler()
  const { startImportJobRunner } = await import("@/server/import-jobs")
  startImportJobRunner()
  // Best-effort: refresh provider model catalogs after boot so routing uses
  // live /models data instead of only hardcoded defaults.
  void import("@/server/provider-models").then(({ syncAllProviderModels }) =>
    syncAllProviderModels().catch((error) => {
      console.error("[provider-models] startup sync failed", error instanceof Error ? error.message : error)
    }),
  )
  void import("@/server/model-pricing").then(({ ensureModelPricingLoaded }) =>
    ensureModelPricingLoaded().catch((error) => {
      console.error("[model-pricing] startup load failed", error instanceof Error ? error.message : error)
    }),
  )
}
