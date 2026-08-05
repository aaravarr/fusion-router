#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolveImageSources, callRemoteDescribe, DEFAULT_BASE_URL } from "./lib.mjs";

const HELP_TEXT = `fusionrouter-mcp - 本地 stdio MCP 桥

用法:
  node index.mjs [--base-url <url>] [--api-key <key>] [--help]

选项:
  --base-url <url>  远程 opencode-api 的 MCP 端点地址 (默认环境变量 OPENCODE_MCP_BASE_URL 或 ${DEFAULT_BASE_URL})
  --api-key <key>   API Key (默认环境变量 OPENCODE_MCP_API_KEY，管理后台「API 密钥」页创建，格式如 ocg_xxx)
  --help            显示本帮助

客户端接入示例 (Claude Desktop claude_desktop_config.json):
  {
    "mcpServers": {
      "fusionrouter-mcp": {
        "command": "node",
        "args": ["D:\\\\Code\\\\AI\\\\opencode-api\\\\mcp-bridge\\\\index.mjs", "--base-url", "http://49.233.103.93:13600", "--api-key", "ocg_xxx"],
        "env": {}
      }
    }
  }
`;

function parseArgs(argv) {
  const opts = { baseUrl: undefined, apiKey: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      opts.help = true;
    } else if (arg === "--base-url") {
      opts.baseUrl = argv[++i];
    } else if (arg === "--api-key") {
      opts.apiKey = argv[++i];
    } else if (arg === "--base-url=") {
      opts.baseUrl = argv[i].slice("--base-url=".length);
    } else if (arg === "--api-key=") {
      opts.apiKey = argv[i].slice("--api-key=".length);
    }
  }
  return opts;
}

function buildConfig(argv) {
  const opts = parseArgs(argv);
  const baseUrl = opts.baseUrl ?? process.env.OPENCODE_MCP_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = opts.apiKey ?? process.env.OPENCODE_MCP_API_KEY;
  return { baseUrl, apiKey };
}

const SERVER_INFO = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "fusionrouter-mcp", version: "0.1.0" },
  instructions:
    "识图工具：传入本地图片路径或 http(s) URL，自动读取本地图片并调用远程 MCP 识图；prompt 可选",
};

const TOOLS_LIST = {
  tools: [
    {
      name: "describe_image",
      description:
        "识图工具：向多模态大模型询问图片内容并返回描述。image 支持本地文件路径（如 C:\\xx\\a.png 或 /home/u/a.png）或 http(s) URL",
      inputSchema: {
        type: "object",
        properties: {
          image: {
            oneOf: [
              { type: "string", description: "本地图片路径或 http(s) URL" },
              { type: "array", items: { type: "string" }, description: "多张图片（本地路径或 URL 数组）" },
            ],
            description: "单张传字符串，多张传数组；支持本地图片路径或 http(s) URL",
          },
          prompt: {
            type: "string",
            description: "可选：本次调用的提问/提示词，不传则由模型直接看图回答",
          },
        },
        required: ["image"],
        additionalProperties: false,
      },
    },
  ],
};

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg, config) {
  if (msg.id === undefined) {
    return null; // 通知，不响应
  }
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, { ...SERVER_INFO });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { ...TOOLS_LIST });
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      if (name !== "describe_image") {
        return rpcError(msg.id, -32602, "Unknown tool");
      }
      try {
        if (!config.apiKey) {
          throw new Error("未配置 API Key，请设置 OPENCODE_MCP_API_KEY 或 --api-key");
        }
        const images = resolveImageSources(args?.image);
        const text = await callRemoteDescribe({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          image: images,
          prompt: args?.prompt,
          id: msg.id,
        });
        return ok(msg.id, { content: [{ type: "text", text }] });
      } catch (err) {
        // MCP 客户端约定：工具错误用成功信封 + isError
        return ok(msg.id, {
          content: [{ type: "text", text: err.message }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(msg.id, -32601, "Method not found");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const config = buildConfig(argv);
  if (config.help) {
    process.stderr.write(HELP_TEXT);
    return;
  }
  process.stderr.write("fusionrouter-mcp ready\n");

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`fusionrouter-mcp: 忽略无法解析的行: ${line}\n`);
      continue;
    }
    const response = await handleMessage(msg, config);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}

// 直接作为脚本运行时启动；被 import（如测试）时不自动启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
