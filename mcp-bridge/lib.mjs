import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:13600";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const DEFAULT_MIME = "image/jpeg";

function extnameOf(path) {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

export function resolveImageSource(image, deps) {
  const trimmed = (image ?? "").trim();
  if (trimmed === "") {
    throw new Error("image 不能为空");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const { existsSync: fsExists, readFileSync: fsRead } = deps ?? {
    existsSync,
    readFileSync,
  };
  const path = trimmed;
  if (!fsExists(path)) {
    throw new Error(`本地图片不存在: ${path}`);
  }
  const buf = fsRead(path);
  const mime = MIME_BY_EXT[extnameOf(path)] ?? DEFAULT_MIME;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * 解析图片参数为 data URI / URL 数组：
 * - 字符串：单图
 * - 数组：多图，逐张解析
 */
export function resolveImageSources(image, deps) {
  if (Array.isArray(image)) {
    if (image.length === 0) throw new Error("请至少提供一张图片");
    return image.map((item) => resolveImageSource(item, deps));
  }
  return [resolveImageSource(image, deps)];
}

/**
 * 构造 describe_image 的 tools/call 请求体（保留旧签名，供测试与旧调用方使用）
 */
export function buildToolsCallPayload({ image, prompt, id }) {
  const args = { image };
  if (prompt) {
    args.prompt = prompt;
  }
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "describe_image", arguments: args },
  };
}

/**
 * 构造任意工具的 tools/call 请求体
 */
export function buildRemoteCallPayload({ name, args, id }) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

export function buildListToolsPayload({ id = 1 } = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  };
}

async function postJson(baseUrl, apiKey, body, fetchImpl) {
  const url = `${baseUrl}/mcp`;
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 错误消息沿用 baseUrl（不含 /mcp 后缀），与旧版行为一致
    throw new Error(`无法连接 MCP 服务 ${baseUrl}: ${err.message}`);
  }

  if (resp.status !== 200) {
    let message = "";
    try {
      const data = await resp.json();
      message = data?.error?.message ?? data?.error ?? "";
    } catch {
      // 忽略解析失败，使用空 message
    }
    throw new Error(`MCP 服务错误 (${resp.status}): ${message}`);
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`MCP 服务响应解析失败: ${err.message}`);
  }

  if (data?.error) {
    throw new Error(data.error.message || `MCP 服务错误 (${data.error.code ?? "unknown"})`);
  }
  return data;
}

/**
 * 通用远程工具转发：调用远程 /mcp 的 tools/call，返回首个 text 内容
 */
export async function callRemoteTool({
  baseUrl,
  apiKey,
  name,
  args,
  id = 1,
  fetchImpl = fetch,
}) {
  const data = await postJson(
    baseUrl,
    apiKey,
    buildRemoteCallPayload({ name, args, id }),
    fetchImpl
  );

  if (data?.result?.isError === true) {
    throw new Error(data?.result?.content?.[0]?.text || "工具调用失败");
  }
  const text = data?.result?.content?.[0]?.text || "";
  if (text === "") {
    throw new Error("模型未返回内容");
  }
  return text;
}

/**
 * 识图专用：image 已由调用方解析为 data URI / URL 数组后透传
 */
export async function callRemoteDescribe({
  baseUrl,
  apiKey,
  image,
  prompt,
  id = 1,
  fetchImpl = fetch,
}) {
  const args = { image };
  if (prompt) {
    args.prompt = prompt;
  }
  return callRemoteTool({ baseUrl, apiKey, name: "describe_image", args, id, fetchImpl });
}

/**
 * 从远程拉取真实工具列表（供 stdio 桥 tools/list 透传，保证与远程同步）
 */
export async function fetchRemoteToolList({
  baseUrl,
  apiKey,
  id = 1,
  fetchImpl = fetch,
}) {
  const data = await postJson(baseUrl, apiKey, buildListToolsPayload({ id }), fetchImpl);
  const tools = data?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("远程 MCP 未返回工具列表");
  }
  return tools;
}