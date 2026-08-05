#!/usr/bin/env node
/**
 * 一键安装 fusionrouter-mcp 到本机常见 MCP 客户端。
 *
 * 用法:
 *   node mcp-bridge/install.mjs --api-key ocg_xxx [--base-url http://49.233.103.93:13600] [--clients claude,cursor,codex] [--dry-run]
 *
 * 默认 base-url 来自环境变量 OPENCODE_MCP_BASE_URL，否则 http://127.0.0.1:13600；
 * api-key 来自 OPENCODE_MCP_API_KEY 或 --api-key。
 * 写入目标（自动探测当前操作系统）：
 *   Claude Desktop: %APPDATA%\Claude\claude_desktop_config.json (Win)
 *                   ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
 *                   ~/.config/Claude/claude_desktop_config.json (Linux)
 *   Cursor:         ~/.cursor/mcp.json (全局)
 *   Codex CLI:      ~/.codex/mcp.json
 */
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENTS = ["claude", "cursor", "codex"];

function parseArgs(argv) {
  const opts = { baseUrl: undefined, apiKey: undefined, clients: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url") opts.baseUrl = argv[++i];
    else if (arg.startsWith("--base-url=")) opts.baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--api-key") opts.apiKey = argv[++i];
    else if (arg.startsWith("--api-key=")) opts.apiKey = arg.slice("--api-key=".length);
    else if (arg === "--clients") opts.clients = argv[++i];
    else if (arg.startsWith("--clients=")) opts.clients = arg.slice("--clients=".length);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help") opts.help = true;
  }
  return opts;
}

/** 解析 clients 参数："claude,cursor" -> ["claude","cursor"]，默认全部。 */
export function resolveClients(raw) {
  if (!raw) return [...CLIENTS];
  const list = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return [...CLIENTS];
  const unknown = list.filter((c) => !CLIENTS.includes(c));
  if (unknown.length) throw new Error(`未知客户端: ${unknown.join(", ")}（支持 ${CLIENTS.join("/")}）`);
  return list;
}

/** 计算各客户端的配置文件路径（当前平台）。 */
export function configPaths() {
  const home = homedir();
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const claude = isWin
    ? join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json")
    : isMac
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");
  return {
    claude,
    cursor: join(home, ".cursor", "mcp.json"),
    codex: join(home, ".codex", "mcp.json"),
  };
}

/** 读 JSON 配置文件，不存在或非法时返回空对象。 */
export function readConfig(file) {
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch {
    // 忽略损坏的配置，从空开始（保留原文件备份由调用方决定）
  }
  return {};
}

/** 在配置对象中写入/更新 fusionrouter-mcp 条目，返回新配置。 */
export function upsertMcpServer(config, entry) {
  const out = { ...config };
  const servers = out.mcpServers && typeof out.mcpServers === "object" ? { ...out.mcpServers } : {};
  servers["fusionrouter-mcp"] = entry;
  out.mcpServers = servers;
  return out;
}

/** 组装 mcpServers 条目：command=node + 本脚本绝对路径 + 参数。 */
export function buildEntry({ baseUrl, apiKey, scriptPath }) {
  const args = [scriptPath, "--base-url", baseUrl];
  if (apiKey) args.push("--api-key", apiKey);
  return { command: "node", args, env: {} };
}

export function printBanner() {
  console.log("fusionrouter-mcp 一键安装");
  console.log("------------------------------");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法: node mcp-bridge/install.mjs [--api-key <key>] [--base-url <url>] [--clients claude,cursor,codex] [--dry-run]

选项:
  --api-key <key>   API Key（管理后台「API 密钥」页创建，格式 ocg_xxx）；也可用环境变量 OPENCODE_MCP_API_KEY
  --base-url <url>  远程 MCP 地址，默认 OPENCODE_MCP_BASE_URL 或 http://127.0.0.1:13600
  --clients <list>  写入哪些客户端：claude,cursor,codex（逗号分隔），默认全部
  --dry-run         只打印将写入的内容，不实际写文件
  --help            显示帮助`);
    return;
  }

  const baseUrl = opts.baseUrl ?? process.env.OPENCODE_MCP_BASE_URL ?? "http://127.0.0.1:13600";
  const apiKey = opts.apiKey ?? process.env.OPENCODE_MCP_API_KEY;
  let clients;
  try {
    clients = resolveClients(opts.clients);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.mjs");
  const entry = buildEntry({ baseUrl, apiKey, scriptPath });
  const paths = configPaths();

  printBanner();
  console.log(`  base-url : ${baseUrl}`);
  console.log(`  api-key  : ${apiKey ? `${apiKey.slice(0, 12)}…` : "（未配置，连接时会报错）"}`);
  console.log(`  脚本路径 : ${scriptPath}`);
  console.log("");

  for (const client of clients) {
    const file = paths[client];
    const label = { claude: "Claude Desktop", cursor: "Cursor", codex: "Codex CLI" }[client];
    if (opts.dryRun) {
      const next = upsertMcpServer(readConfig(file), entry);
      console.log(`[dry-run] ${label} -> ${file}`);
      console.log(JSON.stringify(next, null, 2));
      console.log("");
      continue;
    }
    try {
      const current = readConfig(file);
      const next = upsertMcpServer(current, entry);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf-8");
      console.log(`✓ 已写入 ${label}: ${file}`);
      if (existsSync(file)) console.log(`  （已合并，保留原有 mcpServers）`);
    } catch (err) {
      console.error(`✗ 写入 ${label} 失败: ${err.message}`);
    }
  }

  console.log("");
  console.log("完成。重启对应客户端后即可使用 describe_image（本地路径或 URL）。");
}

main();