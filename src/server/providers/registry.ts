import type { PoolType, PoolTypeMeta, Provider } from "./types"
import type { AccountRecord, QuotaKind } from "../types"

// ─── Pool Type Metadata ──────────────────────────────────────────────────

export const POOL_TYPE_METADATA: Record<PoolType, PoolTypeMeta> = {
  "opencode-go": {
    type: "opencode-go",
    label: "OpenCode Go",
    description: "OpenCode Go subscription via browser extension. Upstream: opencode.ai/zen/go/v1",
    quotaKinds: ["FIVE_HOUR", "WEEKLY", "MONTHLY"] as readonly QuotaKind[],
    credentialFields: [],
  },
  "xai-grok": {
    type: "xai-grok",
    label: "xAI Grok",
    description: "xAI free OAuth (refresh token). Upstream: api.x.ai/v1. Rolling-24h 1M token window.",
    quotaKinds: ["ROLLING_24H"] as readonly QuotaKind[],
    credentialFields: [
      { key: "refreshToken", label: "Refresh Token", required: true, type: "password" },
      { key: "clientId", label: "Client ID (optional)", required: false, type: "text" },
    ],
  },
  "openai": {
    type: "openai",
    label: "OpenAI",
    description: "OpenAI Codex (AT token or OAuth refresh). Upstream: chatgpt.com/backend-api/codex/responses",
    quotaKinds: ["FIVE_HOUR", "WEEKLY"] as readonly QuotaKind[],
    credentialFields: [
      { key: "token", label: "Access Token", required: true, type: "password" },
      { key: "refreshToken", label: "Refresh Token (optional)", required: false, type: "password" },
      { key: "chatgptAccountId", label: "ChatGPT Account ID", required: false, type: "text" },
    ],
  },
  "kimi-code": {
    type: "kimi-code",
    label: "Kimi Code",
    description: "Kimi Code OAuth device login. Upstream: api.kimi.com/coding/v1. Quota from /usages (5h + weekly).",
    quotaKinds: ["FIVE_HOUR", "WEEKLY"] as readonly QuotaKind[],
    credentialFields: [
      { key: "refreshToken", label: "Refresh Token", required: true, type: "password" },
      { key: "clientId", label: "Client ID (optional)", required: false, type: "text" },
    ],
  },
}

// ─── Registry ────────────────────────────────────────────────────────────

class ProviderRegistry {
  private readonly providers = new Map<PoolType, Provider>()

  register(provider: Provider): void {
    if (this.providers.has(provider.poolType)) {
      throw new Error(`Provider already registered for pool type: ${provider.poolType}`)
    }
    this.providers.set(provider.poolType, provider)
  }

  get(poolType: PoolType): Provider {
    const provider = this.providers.get(poolType)
    if (!provider) throw new Error(`No provider registered for pool type: ${poolType}`)
    return provider
  }

  tryGet(poolType: PoolType): Provider | undefined {
    return this.providers.get(poolType)
  }

  all(): Provider[] {
    return [...this.providers.values()]
  }

  registeredPoolTypes(): PoolType[] {
    return [...this.providers.keys()]
  }

  // Get all pool types that have at least one ready account
  activePoolTypes(accounts: AccountRecord[]): PoolType[] {
    const types = new Set<PoolType>()
    for (const account of accounts) {
      const provider = this.tryGet(account.poolType)
      if (provider && provider.isAccountReady(account)) types.add(account.poolType)
    }
    return [...types]
  }
}

const globalForRegistry = globalThis as typeof globalThis & {
  __opencodeApiProviderRegistry?: ProviderRegistry
}

export function getProviderRegistry(): ProviderRegistry {
  if (!globalForRegistry.__opencodeApiProviderRegistry) {
    globalForRegistry.__opencodeApiProviderRegistry = new ProviderRegistry()
  }
  return globalForRegistry.__opencodeApiProviderRegistry
}

export function getProvider(poolType: PoolType): Provider {
  return getProviderRegistry().get(poolType)
}

export function tryGetProvider(poolType: PoolType): Provider | undefined {
  return getProviderRegistry().tryGet(poolType)
}

export { type ProviderRegistry }
