import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveImageSource,
  resolveImageSources,
  buildToolsCallPayload,
  callRemoteDescribe,
} from "./lib.mjs";

function tempFile(name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), "fusionrouter-mcp-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, dir };
}

test("resolveImageSource: http(s) URL 直接透传", () => {
  assert.equal(resolveImageSource("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(resolveImageSource("  http://example.com/a.jpg  "), "http://example.com/a.jpg");
});

test("resolveImageSource: 空字符串抛错", () => {
  assert.throws(() => resolveImageSource("   "), /image 不能为空/);
  assert.throws(() => resolveImageSource(""), /image 不能为空/);
});

test("resolveImageSource: 本地 png 文件转 data URI 且 base64 正确", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { path, dir } = tempFile("a.png", bytes);
  try {
    const out = resolveImageSource(path);
    assert.equal(out, `data:image/png;base64,${bytes.toString("base64")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveImageSource: .jpg 返回 image/jpeg", () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const { path, dir } = tempFile("b.jpg", bytes);
  try {
    const out = resolveImageSource(path);
    assert.ok(out.startsWith("data:image/jpeg;base64,"));
    assert.equal(out.slice("data:image/jpeg;base64,".length), bytes.toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveImageSource: 未知扩展名默认 image/jpeg", () => {
  const bytes = Buffer.from([1, 2, 3]);
  const { path, dir } = tempFile("c.xyz", bytes);
  try {
    const out = resolveImageSource(path);
    assert.ok(out.startsWith("data:image/jpeg;base64,"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveImageSource: 不存在的路径抛错", () => {
  assert.throws(() => resolveImageSource("Z:/no/such/file.png"), /本地图片不存在/);
});

test("buildToolsCallPayload: 结构正确", () => {
  const p = buildToolsCallPayload({ image: "a.png", prompt: "描述这个界面", id: 7 });
  assert.deepEqual(p, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "describe_image", arguments: { image: "a.png", prompt: "描述这个界面" } },
  });
});

test("buildToolsCallPayload: 无 prompt 时不含 prompt 字段", () => {
  const p = buildToolsCallPayload({ image: "a.png", id: 1 });
  assert.equal("prompt" in p.params.arguments, false);
  assert.deepEqual(p.params.arguments, { image: "a.png" });
});

test("callRemoteDescribe: 成功返回 text，请求 URL/headers/body 正确", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "描述结果" }] },
      }),
    };
  };
  const text = await callRemoteDescribe({
    baseUrl: "http://127.0.0.1:13600",
    apiKey: "ocg_test",
    image: "data:image/png;base64,AAAA",
    prompt: "看看",
    id: 42,
    fetchImpl,
  });
  assert.equal(text, "描述结果");
  assert.equal(captured.url, "http://127.0.0.1:13600/mcp");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["content-type"], "application/json");
  assert.equal(captured.init.headers.authorization, "Bearer ocg_test");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.method, "tools/call");
  assert.equal(body.id, 42);
  assert.deepEqual(body.params, {
    name: "describe_image",
    arguments: { image: "data:image/png;base64,AAAA", prompt: "看看" },
  });
});

test("callRemoteDescribe: isError=true 时 rejects 含错误文本", async () => {
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "余额不足" }], isError: true },
    }),
  });
  await assert.rejects(
    callRemoteDescribe({ baseUrl: "http://x", apiKey: "k", image: "a.png", fetchImpl }),
    /余额不足/
  );
});

test("callRemoteDescribe: fetch 网络异常 rejects 含无法连接", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    callRemoteDescribe({ baseUrl: "http://x", apiKey: "k", image: "a.png", fetchImpl }),
    /无法连接 MCP 服务 http:\/\/x: ECONNREFUSED/
  );
});

test("callRemoteDescribe: HTTP 401 + error.message rejects 含 401 和 message", async () => {
  const fetchImpl = async () => ({
    status: 401,
    json: async () => ({ error: { message: "无效的 API Key" } }),
  });
  await assert.rejects(
    callRemoteDescribe({ baseUrl: "http://x", apiKey: "bad", image: "a.png", fetchImpl }),
    /401.*无效的 API Key|无效的 API Key.*401/
  );
});

test("callRemoteDescribe: 空 text 时 rejects 模型未返回内容", async () => {
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
  });
  await assert.rejects(
    callRemoteDescribe({ baseUrl: "http://x", apiKey: "k", image: "a.png", fetchImpl }),
    /模型未返回内容/
  );
});


test("resolveImageSources: 数组逐张解析为 data URI / URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-multi-"));
  const png = join(dir, "a.png");
  const jpg = join(dir, "b.jpg");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff]));
  try {
    const out = resolveImageSources([png, "https://example.com/x.png"]);
    assert.equal(out.length, 2);
    assert.ok(out[0].startsWith("data:image/png;base64,"));
    assert.equal(out[1], "https://example.com/x.png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveImageSources: 单字符串返回单元素数组", () => {
  assert.deepEqual(resolveImageSources("https://example.com/x.png"), ["https://example.com/x.png"]);
});

test("resolveImageSources: 空数组报错", () => {
  assert.throws(() => resolveImageSources([]), /请至少提供一张图片/);
});

test("callRemoteDescribe: 多图数组转发到远程", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body.params.arguments.image));
    assert.equal(body.params.arguments.image.length, 2);
    return {
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "对比结果" }] } }),
    };
  };
  const text = await callRemoteDescribe({
    baseUrl: "http://x", apiKey: "k", image: ["https://a.com/1.png", "https://a.com/2.png"], fetchImpl,
  });
  assert.equal(text, "对比结果");
});
