# Opencode API

多 Provider 号池网关，统一管理多种 AI 订阅账号，对外暴露 OpenAI 兼容 API。

## 能力

- **多 Provider 号池**：OpenCode Go（浏览器扩展接入）、OpenAI Codex（AT token / OAuth 统一号池，有 refresh token 则自动刷新）
- **Sub2API JSON 导入**：粘贴 Sub2API 导出的账号 JSON 批量导入，自动识别 platform 和凭证类型
- **per-pool-type 首选账号**：每种号池类型独立配置第一候选，调度时优先走该号池的偏好账号
- **模型路由优先级**：按模型 pattern 配置号池优先级（如 gpt-5* 优先走 openai），支持通配符和批量配置
- **/models 聚合**：自动聚合所有活跃 provider 的可用模型列表
- **统一域名镜像**：全局域名级镜像映射表，所有出站请求透明走镜像，调用侧无感知
- **额度管理**：5h / weekly / monthly 窗口，从上游 API 响应头被动采集 + 主动查询
- 用户、账号、API Key、路由状态、额度、请求日志严格按用户隔离

## 架构

### Provider 接口

每种号池类型实现统一的 Provider 接口（src/server/providers/types.ts），定义了额度管理、凭证获取、模型列表、上游转发、错误分类和账号就绪判断。调度策略基于接口而非具体实现，新增 provider 只需实现接口并注册。

### Pool Types

| Pool Type | 接入方式 | 额度窗口 | 上游 |
|-----------|---------|---------|------|
| opencode-go | 浏览器扩展（auth cookie -> goApiKey） | 5h + weekly + monthly | opencode.ai/zen/go/v1 |
| openai | Codex CLI OAuth、Sub2API JSON、AT / refresh token | 5h + weekly | chatgpt.com/backend-api/codex |
| kimi-code | Kimi Code 设备码 OAuth（模拟 kimi-code CLI） | 5h + weekly | api.kimi.com/coding/v1 |

### 调度逻辑

1. 请求携带 model -> 查 model_routing 表确定 pool type 优先级
2. 按优先级在对应 pool type 的就绪账号中选择
3. 每个 pool type 有独立的首选账号（pool_preferences 表）
4. 账号额度耗尽 -> 切换同 pool 内下一个账号 -> 该 pool 全部耗尽 -> 切换下一个 pool type
5. 所有 pool type 耗尽 -> 返回 429

### 域名镜像

系统设置中的 domain_mirror_map 是一个 { 原始域名: 镜像地址 } 映射表。所有出站 HTTP 请求经过 apiFetch 拦截器，自动将匹配域名的请求重定向到镜像地址。例如：

```json
{
  "chatgpt.com": "https://your-chatgpt-mirror.com",
  "auth.openai.com": "https://your-auth-mirror.com"
}
```

配置后，Codex API 转发、额度查询、whoami 验证、token 刷新全部透明走镜像，调用侧代码无需任何改动。

## 启动

```bash
npm install
npm run dev
```

首次启动进入管理员初始化页面，密码最少 6 位。

生产构建：

```bash
npm run build
npm start
```

Docker：

```bash
docker build -t opencode-api .
docker run --rm -p 3000:3000 -v opencode-data:/data opencode-api
```

## 连接账号

### OpenCode Go 账号（浏览器扩展）

1. 在管理后台创建 API Key
2. 安装 browser-extension/ 目录的 Chrome/Edge MV3 扩展
3. 在插件中配置后端地址和 API Key
4. Google 登录后自动上报 auth cookie + workspaceId
5. 后端自动创建 Go API Key、读取订阅和额度

### Kimi Code 账号（OAuth 设备码登录）

1. 在「账号池」切换到 **Kimi Code**
2. 点击「Kimi OAuth 登录」
3. 浏览器打开 Kimi 授权页并输入用户码（会自动打开 erification_uri_complete）
4. 授权完成后，系统保存 access/refresh token，并拉取 /models 与 /usages

也可直接导入 refresh token（每行一个）。

### OpenAI 账号

OAuth 登录：

1. 在「账号池」切换到 **OpenAI**
2. 点击「导入 OpenAI 账号」→「OpenAI OAuth 登录」
3. 打开授权页并完成 OpenAI 登录
4. 跳转到 localhost 后，复制浏览器地址栏中的完整回调 URL 并粘贴回系统
5. 系统通过 PKCE 兑换并加密保存 access/refresh token，后续自动刷新

也可以从 Sub2API JSON 导入：

1. 在 Sub2API 管理后台导出账号 JSON
2. 在本项目的「账号池」页面点击「导入 Sub2API JSON」
3. 粘贴导出的完整 JSON
4. 系统自动识别 platform=openai 的账号，统一写入 openai 号池
5. 带有 refresh_token 的账号会自动刷新 access_token；纯 AT token 则直接使用

导入 JSON 格式示例：

```json
{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-07-22T12:00:00Z",
  "proxies": [],
  "accounts": [
    {
      "name": "我的账号",
      "platform": "openai",
      "type": "oauth",
      "credentials": {
        "access_token": "at-xxxxxxxx",
        "auth_mode": "personalAccessToken",
        "plan_type": "plus",
        "chatgpt_account_id": "acc_xxx"
      },
      "concurrency": 3,
      "priority": 50
    }
  ]
}
```

### 模型路由优先级

在「智能路由」页面配置模型路由规则：
- 输入模型 pattern（如 gpt-5* 或 claude-sonnet-4-5），支持通配符
- 选择该模型优先走的 pool type 排序
- 支持批量输入多个 pattern 共享同一优先级配置
- 精确匹配优先于通配符前缀匹配

### 号池首选账号

在「智能路由」页面为每种号池类型单独配置第一候选账号。切换时即时保存。

## 统一模型入口

```text
GET  /v1/models          — 聚合所有活跃 provider 的模型列表
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
```

调用示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer ocg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.3-codex","messages":[{"role":"user","content":"hello"}]}'
```

## 系统设置

域名镜像映射、GitHub 镜像站、OpenCode 上游地址、请求超时、维护周期、日志策略等，均可在管理后台「设置」页面配置。

## 凭据安全

所有凭据（auth cookie、Go API Key、access token、refresh token）使用本机随机生成的主密钥（data/master.key）进行 AES-256-GCM 加密存储。数据库不保存明文。

## 开发

```bash
npm install
npm run dev        # 开发模式（HMR）
npm run build      # 生产构建
npm run test       # 运行测试
npx tsc --noEmit   # 类型检查
```

### 关键文件

- src/server/providers/ — Provider 接口定义、注册表、各 provider 实现
- src/server/routing.ts — 多号池调度 + model routing + per-pool preference
- src/server/gateway.ts — 统一网关，provider 分发 + /models 聚合
- src/server/api-fetch.ts — 带域名镜像拦截的统一 HTTP 请求
- src/server/settings.ts — 系统配置（域名镜像映射、OpenCode 上游等）
- src/server/repository.ts — 账号/凭证/模型路由仓储
- src/app/api/admin/accounts/import/ — Sub2API JSON 导入端点
- src/app/api/admin/model-routing/ — 模型路由规则 CRUD
- src/components/dashboard/ — 前端管理页面
