import { getProviderRegistry } from "./registry"
import { OpenCodeGoProvider } from "./opencode-go"
import { OpenAICPAProvider } from "./openai-cpa"
import { XAIGrokProvider } from "./xai-grok"
import { KimiCodeProvider } from "./kimi-code"

// Register all built-in providers. This runs once on first import.

const globalInit = globalThis as typeof globalThis & { __opencodeApiProvidersInitialized?: boolean }

export function ensureProvidersRegistered(): void {
  if (globalInit.__opencodeApiProvidersInitialized) return
  globalInit.__opencodeApiProvidersInitialized = true
  const registry = getProviderRegistry()
  registry.register(new OpenCodeGoProvider())
  registry.register(new OpenAICPAProvider("openai-cpa"))
  registry.register(new OpenAICPAProvider("openai-oauth"))
  registry.register(new XAIGrokProvider())
  registry.register(new KimiCodeProvider())
}

// Trigger registration on module load
ensureProvidersRegistered()

export { getProviderRegistry, getProvider, tryGetProvider, POOL_TYPE_METADATA } from "./registry"
export { POOL_TYPES } from "./types"
export type { Provider, PoolType, PoolTypeMeta, QuotaWindow, ProviderCredential, UpstreamErrorClassification, ForwardRequestInput, ForwardTarget } from "./types"

