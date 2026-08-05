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

export async function callRemoteDescribe({
  baseUrl,
  apiKey,
  image,
  prompt,
  id = 1,
  fetchImpl = fetch,
}) {
  const url = `${baseUrl}/mcp`;
  const body = JSON.stringify(buildToolsCallPayload({ image, prompt, id }));
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
    });
  } catch (err) {
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

  if (data?.result?.isError === true) {
    throw new Error(data?.result?.content?.[0]?.text || "识图失败");
  }
  const text = data?.result?.content?.[0]?.text || "";
  if (text === "") {
    throw new Error("模型未返回内容");
  }
  return text;
}
