import { getProviderRegistry, setCustomProviderFactory } from "./registry"
import { OpenCodeGoProvider } from "./opencode-go"
import { OpenAICPAProvider } from "./openai-cpa"
import { XAIGrokProvider } from "./xai-grok"
import { KimiCodeProvider } from "./kimi-code"
import { OpenDesignGoProvider } from "./open-design-go"
import { CustomProvider } from "./custom"
import { getCustomProviderByPoolType } from "../custom-providers"

// Register all built-in providers. This runs once on first import.

const globalInit = globalThis as typeof globalThis & { __opencodeApiProvidersInitialized?: boolean }

export function ensureProvidersRegistered(): void {
  setCustomProviderFactory((poolType) => getCustomProviderByPoolType(poolType) ? new CustomProvider(poolType) : undefined)
  if (globalInit.__opencodeApiProvidersInitialized) return
  globalInit.__opencodeApiProvidersInitialized = true
  const registry = getProviderRegistry()
  registry.register(new OpenCodeGoProvider())
  registry.register(new OpenAICPAProvider())
  registry.register(new XAIGrokProvider())
  registry.register(new KimiCodeProvider())
  registry.register(new OpenDesignGoProvider())
}

// Trigger registration on module load
ensureProvidersRegistered()

export { getProviderRegistry, getProvider, tryGetProvider, POOL_TYPE_METADATA } from "./registry"
export { POOL_TYPES } from "./types"
export type { Provider, PoolType, PoolTypeMeta, QuotaWindow, ProviderCredential, UpstreamErrorClassification, ForwardRequestInput, ForwardTarget } from "./types"
