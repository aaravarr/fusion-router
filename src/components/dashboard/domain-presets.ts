// Known upstream hostnames grouped by the provider pool type that uses them.
// Surfaced as a dropdown in the settings UI for the domain-mirror map so
// operators can pick a real target host instead of typing a bare hostname.

export interface DomainPreset {
  domain: string
  label: string
  description: string
}

export interface DomainPresetGroup {
  poolType: string
  label: string
  domains: DomainPreset[]
}

export const PROVIDER_DOMAIN_PRESETS: DomainPresetGroup[] = [
  {
    poolType: "opencode-go",
    label: "OpenCode Go",
    domains: [
      { domain: "opencode.ai", label: "opencode.ai", description: "OpenCode Go callback / quota sync upstream." },
    ],
  },
  {
    poolType: "openai",
    label: "OpenAI",
    domains: [
      { domain: "chatgpt.com", label: "chatgpt.com", description: "Codex responses + wham/usage endpoints." },
      { domain: "auth.openai.com", label: "auth.openai.com", description: "PAT whoami + OAuth token refresh." },
    ],
  },
  {
    poolType: "xai-grok",
    label: "xAI Grok",
    domains: [
      { domain: "accounts.x.ai", label: "accounts.x.ai", description: "xAI 账号登录与 SSO 会话验证。" },
      { domain: "api.x.ai", label: "api.x.ai", description: "xAI inference upstream (/responses, /chat/completions, /images/*)." },
      { domain: "cli-chat-proxy.grok.com", label: "cli-chat-proxy.grok.com", description: "xAI CLI billing probe (subscription tier detection)." },
      { domain: "auth.x.ai", label: "auth.x.ai", description: "xAI OAuth token refresh endpoint (token grant)." },
    ],
  },
  {
    poolType: "kimi-code",
    label: "Kimi Code",
    domains: [
      { domain: "auth.kimi.com", label: "auth.kimi.com", description: "Kimi Code OAuth device authorization + token refresh." },
      { domain: "api.kimi.com", label: "api.kimi.com", description: "Kimi Code inference /models /usages upstream." },
    ],
  },
  {
    poolType: "glm-coding",
    label: "GLM Coding Plan",
    domains: [
      { domain: "zcode.z.ai", label: "zcode.z.ai", description: "GLM Coding OAuth 设备流（cli/init、cli/poll 授权中转）。" },
      { domain: "open.bigmodel.cn", label: "open.bigmodel.cn", description: "国内推理端点（chat/responses/messages）与用量 quota/limit 探测。" },
      { domain: "bigmodel.cn", label: "bigmodel.cn", description: "国内 biz API：OAuth 兑换 coding-plan API key。" },
      { domain: "api.z.ai", label: "api.z.ai", description: "国际版推理 / 用量 / biz 兑换（与国内同构）。" },
    ],
  },
  {
    poolType: "github",
    label: "GitHub",
    domains: [
      { domain: "github.com", label: "github.com", description: "Release download pages (extension auto-update)." },
      { domain: "api.github.com", label: "api.github.com", description: "Releases API for extension version checks." },
      { domain: "raw.githubusercontent.com", label: "raw.githubusercontent.com", description: "Raw release assets / metadata." },
      { domain: "objects.githubusercontent.com", label: "objects.githubusercontent.com", description: "Release asset download CDN." },
    ],
  },
]

// Flat lookup domain -> preset, for quick match checks in the UI.
export const PRESET_DOMAIN_SET: Set<string> = new Set(
  PROVIDER_DOMAIN_PRESETS.flatMap((group) => group.domains.map((domain) => domain.domain)),
)
