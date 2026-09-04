# AGENTS.md

## 工作原则

### 先跑通再动手（必须遵守）

- 凡是涉及调用外部 API / 协议（尤其是用户明确给出示例或端点时），**必须先实测**：用 curl 或最小脚本把用户给的示例跑通，确认请求格式、响应结构，再写实现代码。
- 不要凭训练知识假设某端点支持/不支持某种格式（例如「OpenAI 兼容端点应该也支持原生工具」）——不同端点能力差异很大，实测为准。
- 实现前先确认依赖方（provider、网关、协议）的真实行为，再设计代码结构，避免写完才发现方向错了返工。
- 教训案例（2026-08-07）：用户明确给出 DeepSeek Anthropic messages 端点示例（`/anthropic/v1/messages` + `web_search_20260209` 工具），但实现时按惯性走了 OpenAI chat/completions 格式，写完才实测发现 OpenAI 端点不支持该工具类型，全部返工。正确顺序：先 curl 实测端点与响应结构 → 确认格式 → 再实现。

### Kimi Code（Coding Plan）对接要点（2026-08-09，对照官方 MoonshotAI/kimi-code）

- 官方仓库：`MoonshotAI/kimi-code`，关键代码 `packages/oauth/src/managed-usage.ts`（余额）、`managed-kimi-code.ts`（models 认证）、`identity.ts`（设备头）、`oauth-manager.ts`（刷新阈值/revoked）、`managed-userinfo.ts`（/me）。
- API Key 认证：`GET https://api.kimi.com/coding/v1/models`，header 只需 `Authorization: Bearer <sk-...>` + `Accept: application/json`（X-Msh-* 设备头可选，官方 CLI 会带）。401/402/403 均视为 key/计划认证类错误。
- 余额/配额：`GET https://api.kimi.com/coding/v1/usages`，Bearer 认证；响应 `{ usage: {used,limit,remaining,resetTime}, limits: [{window:{duration,timeUnit},detail:{used,limit,remaining,resetTime}}], boosterWallet: {...} }`，数字多为字符串；`boosterWallet.balance.amount/amountLeft` 是 fixed-point（÷1_000_000 = 美分），`monthlyChargeLimit/monthlyUsed` 的 `priceInCents` 直接是美分，balance.type 必须是 `BOOSTER` 才算钱包。
- 用户信息：`GET https://api.kimi.com/coding/v1/me`，Bearer + Accept；返回 user_id/region/domain_name/user_level_name 等，**email 为可选**（实测企业版账号可能没有 email，账号 email 需 JWT 解码兜底）。建号时 best-effort 拉取并存凭据（kimiUserId/region/domainName/userLevel）。
- **刷新阈值**：对齐官方 `defaultRefreshThreshold` = `max(300, expiresIn * 0.5)`（oauth-manager.ts），token 剩余不足一半（至少 5 分钟）即提前刷新；凭据需持久化 `expiresIn`（poll 路由、import-jobs、provider 刷新后都要写）。
- **refresh 401/403 = 凭据失效**：`refreshKimiAccessToken` 对 401/403/invalid_grant 抛 `KimiTokenInvalidError`；provider 捕获后清空 token 并写 `revokedAt`（对齐官方 revoked tombstone，token-state.ts），`getCredential` 直接报「需重新登录」，不要反复拿死 token 白刷；网络/5xx 抖动保留旧 token 静默降级。
- **429 语义**：Moonshot 的配额/余额耗尽也是 429——结构化 `error.type=exceeded_current_quota_error` 或 billing 措辞（"exceeded your current quota"/"insufficient balance"/"please recharge"/"in arrears"）→ 配额耗尽（切换账号），其余 429 才是瞬时限流（kimi-errors.ts 语义）。402 在 /models 语境是会员权益/认证类错误。
- **业务错误码禁用 401**：前端 `sessionFetch`（admin-context.tsx）会把任何 401 当会话过期跳登录页；业务校验失败（如 key 无效）必须返回 400/422，否则出现「验证并录入 → 跳登录」的诡异现象。

### GLM Coding Plan 对接要点（2026-09-04，ZCode 3.9.1 app.asar 逆向 + TriDefender/zcode-api 复刻 + 真实 key 实测）

- 关键代码：`src/server/glm-coding.ts`（端点表/指纹头/配额/OAuth 设备流与兑换）、`src/server/providers/glm-coding.ts`（provider）、录入路由 `glm-apikey` 与 `glm-oauth/start|poll`。
- **三接口三 base_url**（国内 `open.bigmodel.cn`）：chat = `/api/coding/paas/v4`、responses = `/api/v1`（注意不在 coding 路径下）、messages = `/api/anthropic/v1`；国际版 `api.z.ai` 同构。`buildForwardTarget` 按 endpoint 查表（`glmBaseForEndpoint`），三格式全原生直通，网关零改动。
- **ZCode 指纹头注入**（`createZcodeIdentityHeaders`）：UA 固定 `ZCode/3.9.1` 不透传客户端 UA、`X-ZCode-App-Version`/`X-Platform`/`X-Os-Category`/`X-Release-Channel` 等家族头、`X-Device-Mid` 每账号生成一次并持久化到凭据 `data.deviceMid`、`x-request-id` 每请求 randomUUID。这是 GLM「ZCode 中使用按 67% 扣减」的触发条件，生产 A/B 实测扣减比例约 0.40-0.41（2026-09-04 实测）。zcode 推理路径免签名（Ed25519 + PoW 请求签名存在但 fail-open，代码留 `TODO(zcode-signing)`，生产确认不签名照常拿折扣）。
- **双录入**：① API Key（`glm-apikey` 路由先 `GET quota/limit` 实测验证，key 无效回 400、上游不可达回 502，禁 401——同 Kimi 的 sessionFetch 语义）；② OAuth 设备流（`POST zcode.z.ai/api/v1/oauth/cli/init` + `GET cli/poll/{flow_id}`，`provider` 参数 bigmodel（国内）/zai（国际）；ready 后经 biz API 自动兑换长期 coding-plan API key——名称 `zcode-api-key`、形态 `{apiKey}.{secret}`，凭据按 apikey 语义存，无过期无刷新）。**OAuth ready 响应形态与兑换链契约源自 zcode-api 复刻项目（需真人授权无法离线实测），首次真实授权待验证**。
- **用量**：`GET /api/monitor/usage/quota/limit`（Bearer）；`CREDIT_LIMIT` 行 `unit=3` = 5h 滚动窗（FIVE_HOUR）、`unit=6` = 周窗（WEEKLY），`percentage` 为已用百分比（与网关阻塞语义同向直接采用）、`nextResetTime` 为毫秒时间戳；`level` = 套餐等级（pro 等），写入 quota_windows 的 `extra.level` 透传管理端。
- **模型**：`glm-5.3` / `glm-5.3-flash`（`[1m]` 后缀开 1M 上下文）；旧型号（glm-5.2 等）上游自动映射，网关原样透传。
- **错误语义**：401/403 = 认证错误；402 与命中配额措辞的 429 = 配额/套餐耗尽（切账号）；其余 429 = 并发限流（GLM 限流口径是并发数），同账号退避重试最多 6 次（`GLM_RATE_LIMIT_MAX_RETRIES`）再切号。
- **生产路由**：`glm-*` 规则优先级已调为 glm-coding 优先、原 custom BigModel 兜底。

### 各 provider 原生接口格式能力（2026-08-09 确认）

- opencode-go：chat completions + Anthropic messages（上游 opencode.ai 原生支持 /messages）；responses 入口对**白名单模型**（`OPENCODE_GO_RESPONSES_MODELS`，见 `src/server/providers/opencode-go.ts`）原生直通，其余模型走网关转 chat 的兼容链路。**muse-\* 模型上游仅支持 /v1/responses**（2026-09-03 实测，commit `40aecd5`）：网关对 `/^muse-/i` 命中模型只声明 responses 能力，chat/messages 入口自动转换接力上行。
- kimi-code：chat completions + Anthropic messages（官方 Claude Code 接入方式 `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/` → `/v1/messages`，文档确认）。
- openai (codex)：仅 responses（chatgpt.com/backend-api/codex）。
- xai-grok：chat completions + responses（cli-chat-proxy.grok.com）；**不支持 messages（用户确认，已知事实）**。
- glm-coding：chat completions + responses + Anthropic messages **三格式全原生**（2026-09-04 真实 key 实测均 200）；三 base_url 按 endpoint 查表（见上节），路由零转换。
- 通用原则：上游格式能力以实测/官方文档为准，不靠猜；调度遵循「原生优先，兼容转换兜底」。
