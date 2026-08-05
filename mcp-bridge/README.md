# fusionrouter-mcp

本地 stdio MCP 桥：动态透传远程 opencode-api 的 MCP 工具（describe_image 识图 / web_search 联网搜索）。工具列表以远程为准，Claude Desktop / Cursor / Codex CLI 等客户端始终能看到与远程一致的工具；describe_image 的本地图片路径或 http(s) URL 由本桥自动转 data URI 转发。

## 这是什么

远程 opencode-api 的识图工具 `describe_image` 只接受 `image`（http(s) URL 或 data:image URI）。data URI 动辄几十上百 KB，让 AI 在对话里复述一遍既不现实也容易出错。

本桥跑在用户本地机器上，解决这个问题：

- AI 只需要传一个**短路径字符串**（如 `C:\Users\xx\Desktop\截图.png`）或 URL；
- 本地桥读取本地文件 → 转成 data URI → 通过 HTTP POST 转发到远程 `/mcp`；
- 远程账号池识图后，把纯文本描述原样返回给 AI。

本地桥本身**无状态、不存图**，图片字节仅在转发瞬间经过内存。

## 架构图

```text
┌──────────────┐   stdio (newline JSON)   ┌──────────────────┐   HTTP POST /mcp   ┌────────────────────┐
│ Claude /     │ ───────────────────────▶ │  fusionrouter-mcp-   │ ─────────────────▶ │ 远程 opencode-api  │
│ Cursor /     │   tools/call             │  bridge (index)  │   Bearer ocg_xxx   │  账号池多模态识图   │
│ Codex CLI    │ ◀─────────────────────── │  读文件→data URI │ ◀───────────────── │                    │
└──────────────┘   文本描述               └──────────────────┘     识别结果        └────────────────────┘
```

## 安装 / 运行

无需安装依赖（零依赖，纯 Node 内置模块）：

```bash
cd mcp-bridge
npm install        # 可跳过，本包没有任何依赖
```

配置环境变量（也可以直接用 CLI 参数，见下文客户端接入配置）：

```bash
# Windows PowerShell
$env:OPENCODE_MCP_BASE_URL = "http://49.233.103.93:13600"
$env:OPENCODE_MCP_API_KEY  = "ocg_xxx"   # 管理后台「API 密钥」页创建
```

参数优先级：**CLI 参数 > 环境变量 > 默认值**（默认 baseUrl 为 `http://127.0.0.1:13600`；apiKey 无默认，缺失时 `tools/call` 会报错「未配置 API Key，请设置 OPENCODE_MCP_API_KEY 或 --api-key」）。

```bash
node mcp-bridge/index.mjs --base-url http://49.233.103.93:13600 --api-key ocg_xxx
```

## 通过 npm 安装（无需本地项目，推荐给外部用户）

包已发布到 npm（`fusionrouter-mcp`），任何机器只需 npx 即可运行，无需 clone 仓库：

```json
{
  "mcpServers": {
    "fusionrouter-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "fusionrouter-mcp",
        "--base-url", "http://49.233.103.93:13600",
        "--api-key", "ocg_xxx"
      ]
    }
  }
}
```

> Windows 下若 Claude Desktop / Cursor 不识别 `npx`，改用：
> `"command": "cmd", "args": ["/c", "npx", "-y", "fusionrouter-mcp", "--base-url", "http://49.233.103.93:13600", "--api-key", "ocg_xxx"]`

发布流程：推送到 `mcp-bridge/` 或手动触发 GitHub Actions `Publish fusionrouter-mcp` workflow，自动 `npm publish`。

### Windows 注意事项（Cursor / VsCode 必读）

1. **不要**把 `command` 直接填成 `index.mjs` 的路径——Windows 会把它当文件用 VsCode 打开（弹出编辑器窗口）而不是用 node 执行。`command` 必须是 `node`、`npx`、`cmd` 这类**可执行程序**。
2. 若用 `npx` 且客户端（尤其 Cursor / VsCode）不识别，用下面的写法（强制走 cmd）：
   ```json
   { "command": "cmd", "args": ["/c", "npx", "-y", "fusionrouter-mcp", "--base-url", "http://49.233.103.93:13600", "--api-key", "ocg_xxx"] }
   ```
3. **连接超时（MCP error -32000: Connection closed）**：早期版本（≤0.1.4）在 macOS/Linux 上通过 npx 启动时可能静默退出，原因是入口守卫未解析符号链接（已修复，0.1.5+ 无此问题）。若仍遇到：
   - 升级到最新版：`npx -y fusionrouter-mcp@latest`；
   - 或先手动执行一次 `npx -y fusionrouter-mcp`（或 `npm install -g fusionrouter-mcp --registry=https://registry.npmjs.org` 全局安装），建立缓存/全局 bin；
   - 全局安装后可直接用全局命令：`"command": "fusionrouter-mcp", "args": ["--base-url", "http://49.233.103.93:13600", "--api-key", "ocg_xxx"]`（Windows 上若仍不识别，套 `cmd /c`）。
4. 国内网络访问 npmjs 慢：全局安装时加 `--registry=https://registry.npmjs.org`，或等腾讯云镜像同步后使用镜像源。

## 快速安装（推荐）



一条命令自动写入 Claude Desktop / Cursor / Codex CLI 的配置，不用手动编辑 JSON：

```bash
# PowerShell
node mcp-bridge/install.mjs --api-key ocg_xxx --base-url http://49.233.103.93:13600
```

- `--api-key` 也可用环境变量 `OPENCODE_MCP_API_KEY`，`--base-url` 也可用 `OPENCODE_MCP_BASE_URL`
- 默认写入三种客户端；只想装某个用 `--clients claude,cursor,codex` 过滤
- 先预览不写文件：加 `--dry-run`
- 脚本会自动探测配置文件路径（Windows / macOS / Linux），**合并保留**已有 mcpServers，不会覆盖其它 MCP 配置

安装后**重启对应客户端**即可使用 describe_image。

## 客户端接入配置（手动方式）


### Claude Desktop

编辑 `claude_desktop_config.json`（Claude 菜单 → Settings → Developer → Edit Config）：

```json
{
  "mcpServers": {
    "fusionrouter-mcp": {
      "command": "node",
      "args": [
        "D:\\Code\\AI\\opencode-api\\mcp-bridge\\index.mjs",
        "--base-url",
        "http://49.233.103.93:13600",
        "--api-key",
        "ocg_xxx"
      ],
      "env": {}
    }
  }
}
```

### Cursor

在项目根目录创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "fusionrouter-mcp": {
      "command": "node",
      "args": [
        "D:\\Code\\AI\\opencode-api\\mcp-bridge\\index.mjs",
        "--base-url",
        "http://49.233.103.93:13600",
        "--api-key",
        "ocg_xxx"
      ]
    }
  }
}
```

### Codex CLI

在 MCP 配置中指向本脚本（路径按实际位置填写），例如：

```json
{
  "mcpServers": {
    "fusionrouter-mcp": {
      "command": "node",
      "args": ["D:/Code/AI/opencode-api/mcp-bridge/index.mjs", "--base-url", "http://49.233.103.93:13600", "--api-key", "ocg_xxx"]
    }
  }
}
```

也可先 `npm link`（或全局安装本包）后，用 `npx fusionrouter-mcp-bridge --base-url ... --api-key ...` 启动。

## 用法示例（AI 视角）

```js
describe_image({ image: "C:\\Users\\xx\\Desktop\\截图.png", prompt: "描述这个界面" })
describe_image({ image: "https://example.com/photo.jpg" })   // URL 直接透传，不读本地
```

`image` 支持：

- 本地绝对/相对路径：`C:\Users\xx\Desktop\截图.png`、`/home/u/a.png`、`./screenshot.png`
- http(s) URL：原样透传给远程，不经过本地读取
- **多图**：传字符串数组 `["C:\\xx\\1.png", "https://example.com/2.png"]`，一次提问同时分析多张（可对比/多图综合）

`prompt` 可选：不传则由模型直接看图回答。

## 支持格式与限制

| 扩展名 | MIME |
| --- | --- |
| `.png` | image/png |
| `.jpg` / `.jpeg` | image/jpeg |
| `.webp` | image/webp |
| `.gif` | image/gif |
| `.bmp` | image/bmp |
| `.svg` | image/svg+xml |
| 其它未知扩展名 | image/jpeg（默认） |

限制：

- 大图注意远程约 **10MB** 上限（data URI 会有 base64 膨胀约 33%）。
- 本地桥无状态、不存图，图片字节仅在转发瞬间经过内存。
- 网络异常 / 非 200 / 远程 isError 都会以错误文本返回给客户端。

## 开发与测试

测试用 Node 内置 test runner（`node:test` + `node:assert`），不依赖 vitest：

```bash
cd <仓库根>
node --test mcp-bridge/        # 或 node --test ./mcp-bridge/lib.test.mjs
```

冒烟测试（手动）：把下面两行 JSON 用管道喂给入口脚本，应回两行 JSON（initialize 带 serverInfo、tools/list 带 describe_image）：

```powershell
$lines = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
)
$lines | node mcp-bridge/index.mjs
```
