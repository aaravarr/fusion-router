import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClients, readConfig, upsertMcpServer, buildEntry } from "./install.mjs";

test("resolveClients: 默认全部", () => {
  assert.deepEqual(resolveClients(undefined), ["claude", "cursor", "codex"]);
});

test("resolveClients: 解析逗号列表", () => {
  assert.deepEqual(resolveClients("claude,cursor"), ["claude", "cursor"]);
});

test("resolveClients: 未知客户端抛错", () => {
  assert.throws(() => resolveClients("vim"), /未知客户端/);
});

test("readConfig: 不存在返回空对象", () => {
  assert.deepEqual(readConfig(join(tmpdir(), "no-such-config.json")), {});
});

test("readConfig: 非法 JSON 返回空对象", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-install-"));
  const file = join(dir, "bad.json");
  writeFileSync(file, "not json", "utf-8");
  assert.deepEqual(readConfig(file), {});
  rmSync(dir, { recursive: true, force: true });
});

test("readConfig: 正常读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-install-"));
  const file = join(dir, "ok.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { other: {} } }), "utf-8");
  assert.deepEqual(readConfig(file), { mcpServers: { other: {} } });
  rmSync(dir, { recursive: true, force: true });
});

test("upsertMcpServer: 保留已有 mcpServers 并写入 opencode-mcp", () => {
  const next = upsertMcpServer({ mcpServers: { github: { command: "npx" } } }, { command: "node", args: [] });
  assert.deepEqual(Object.keys(next.mcpServers).sort(), ["github", "opencode-mcp"]);
  assert.deepEqual(next.mcpServers["opencode-mcp"], { command: "node", args: [] });
});

test("upsertMcpServer: 覆盖同名旧条目", () => {
  const next = upsertMcpServer(
    { mcpServers: { "opencode-mcp": { command: "old" } } },
    { command: "node", args: ["x"] },
  );
  assert.deepEqual(next.mcpServers["opencode-mcp"], { command: "node", args: ["x"] });
});

test("buildEntry: 含 api-key 时带参数", () => {
  const entry = buildEntry({ baseUrl: "http://h:1", apiKey: "ocg_abc", scriptPath: "C:/x/index.mjs" });
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, ["C:/x/index.mjs", "--base-url", "http://h:1", "--api-key", "ocg_abc"]);
});

test("buildEntry: 无 api-key 时不带参数", () => {
  const entry = buildEntry({ baseUrl: "http://h:1", apiKey: undefined, scriptPath: "/x/index.mjs" });
  assert.deepEqual(entry.args, ["/x/index.mjs", "--base-url", "http://h:1"]);
});