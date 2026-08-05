import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "./index.mjs";

const INDEX_URL = new URL("./index.mjs", import.meta.url);
const INDEX_PATH = fileURLToPath(INDEX_URL);

test("isDirectRun: 真实路径等于模块 URL 返回 true", () => {
  assert.equal(isDirectRun(INDEX_PATH, INDEX_URL.href), true);
});

test("isDirectRun: 空 argv1 返回 false", () => {
  assert.equal(isDirectRun(undefined, INDEX_URL.href), false);
  assert.equal(isDirectRun("", INDEX_URL.href), false);
});

test("isDirectRun: 其它文件路径返回 false", () => {
  const libPath = join(dirname(INDEX_PATH), "lib.mjs");
  assert.equal(isDirectRun(libPath, INDEX_URL.href), false);
});

test("isDirectRun: 符号链接解析到真实路径后返回 true（macOS/Linux .bin 场景）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-entry-"));
  const link = join(dir, "fusionrouter-mcp");
  try {
    symlinkSync(INDEX_PATH, link);
  } catch {
    t.skip("当前环境无法创建符号链接");
    return;
  }
  try {
    // 链接路径与真实路径不同，但 isDirectRun 应返回 true
    assert.notEqual(realpathSync(link), link);
    assert.equal(isDirectRun(link, INDEX_URL.href), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
