# AGENTS.md

## 工作原则

### 先跑通再动手（必须遵守）

- 凡是涉及调用外部 API / 协议（尤其是用户明确给出示例或端点时），**必须先实测**：用 curl 或最小脚本把用户给的示例跑通，确认请求格式、响应结构，再写实现代码。
- 不要凭训练知识假设某端点支持/不支持某种格式（例如「OpenAI 兼容端点应该也支持原生工具」）——不同端点能力差异很大，实测为准。
- 实现前先确认依赖方（provider、网关、协议）的真实行为，再设计代码结构，避免写完才发现方向错了返工。
- 教训案例（2026-08-07）：用户明确给出 DeepSeek Anthropic messages 端点示例（`/anthropic/v1/messages` + `web_search_20260209` 工具），但实现时按惯性走了 OpenAI chat/completions 格式，写完才实测发现 OpenAI 端点不支持该工具类型，全部返工。正确顺序：先 curl 实测端点与响应结构 → 确认格式 → 再实现。

### Kimi Code（Coding Plan）对接要点（2026-08-09，对照官方 MoonshotAI/kimi-code）

- 官方仓库：`MoonshotAI/kimi-code`，关键代码 `packages/oauth/src/managed-usage.ts`（余额）、`managed-kimi-code.ts`（models 认证）、`identity.ts`（设备头）。
- API Key 认证：`GET https://api.kimi.com/coding/v1/models`，header 只需 `Authorization: Bearer <sk-...>` + `Accept: application/json`（X-Msh-* 设备头可选，官方 CLI 会带）。401/402/403 均视为 key/计划认证类错误。
- 余额/配额：`GET https://api.kimi.com/coding/v1/usages`，Bearer 认证；响应 `{ usage: {used,limit,resetTime}, limits: [{window:{duration,timeUnit},detail:{used,limit,resetTime}}], boosterWallet: {...} }`，数字多为字符串；`boosterWallet.balance.amount/amountLeft` 是 fixed-point（÷1_000_000 = 美分），`monthlyChargeLimit/monthlyUsed` 的 `priceInCents` 直接是美分，balance.type 必须是 `BOOSTER` 才算钱包。
- **业务错误码禁用 401**：前端 `sessionFetch`（admin-context.tsx）会把任何 401 当会话过期跳登录页；业务校验失败（如 key 无效）必须返回 400/422，否则出现「验证并录入 → 跳登录」的诡异现象。
