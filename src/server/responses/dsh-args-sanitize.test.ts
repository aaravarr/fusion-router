import { describe, expect, it } from "vitest"
import {
  DSH_ARGS_SANITIZE_TAG,
  isDshSanitizeScope,
  sanitizeFunctionCallArgumentsString,
  sanitizeResponsesPayload,
  sanitizeSseEventObject,
  sanitizeSseText,
  withDshSanitizeTag,
} from "./dsh-args-sanitize"

const dirtyArgs = JSON.stringify({
  command: "Get-Process",
  description: "列出进程",
  justification: "需要更宽权限执行",
  sandbox_permissions: "workspace-write",
})

describe("dsh-args-sanitize 纯函数", () => {
  it("范围判定：仅 openai 池 + deepseek UA 命中", () => {
    expect(isDshSanitizeScope("openai", "DeepSeek-Harness/1.2.3")).toBe(true)
    expect(isDshSanitizeScope("openai", "deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)")).toBe(true)
    // openai 池 + 非 deepseek UA（如 Codex CLI 官方客户端）不清洗
    expect(isDshSanitizeScope("openai", "codex-cli-client/9.9.9")).toBe(false)
    expect(isDshSanitizeScope("openai", "")).toBe(false)
    expect(isDshSanitizeScope("openai", undefined)).toBe(false)
    // 其他池即使 deepseek UA 也不清洗
    expect(isDshSanitizeScope("opencode-go", "DeepSeek-Harness/1.0")).toBe(false)
    expect(isDshSanitizeScope("xai-grok", "DeepSeek-Harness/1.0")).toBe(false)
    expect(isDshSanitizeScope("glm-coding", "deepseek-harness/1.0")).toBe(false)
    expect(isDshSanitizeScope("custom:foo", "deepseek-harness/1.0")).toBe(false)
  })

  it("arguments 字符串清洗：去掉两 key、保留正常字段", () => {
    const cleaned = sanitizeFunctionCallArgumentsString(dirtyArgs)
    expect(cleaned).not.toBeNull()
    expect(cleaned!.removed.sort()).toEqual(["justification", "sandbox_permissions"])
    expect(JSON.parse(cleaned!.text)).toEqual({ command: "Get-Process", description: "列出进程" })
  })

  it("arguments 非法 JSON：返回 null 原样放行", () => {
    expect(sanitizeFunctionCallArgumentsString("{not-json")).toBeNull()
    expect(sanitizeFunctionCallArgumentsString("")).toBeNull()
    // 顶层数组不动
    expect(sanitizeFunctionCallArgumentsString("[1,2]")).toBeNull()
    // 无目标 key 时返回 null（调用方不改写）
    expect(sanitizeFunctionCallArgumentsString(JSON.stringify({ command: "x" }))).toBeNull()
  })

  it("SSE 事件对象：output_item.done 清洗，delta 类型不动（调用方不传入）", () => {
    const done = {
      type: "response.output_item.done",
      output_index: 1,
      item: { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "pwsh", arguments: dirtyArgs },
    }
    expect(sanitizeSseEventObject(done)).toEqual(expect.arrayContaining(["justification", "sandbox_permissions"]))
    expect(JSON.parse((done.item as { arguments: string }).arguments)).toEqual({ command: "Get-Process", description: "列出进程" })

    // 非 function_call item 不动
    expect(sanitizeSseEventObject({ type: "response.output_item.done", item: { id: "msg_1", type: "message" } })).toEqual([])

    // completed 终态 response.output 一并清洗
    const completed = {
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [{ id: "fc_1", type: "function_call", call_id: "call_1", name: "pwsh", arguments: dirtyArgs }] },
    }
    expect(sanitizeSseEventObject(completed).length).toBe(2)
  })

  it("SSE 文本：delta 行原样透传，done 行清洗", () => {
    const sse = [
      'event: response.function_call_arguments.delta',
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\\"justification\\":"`,
      'event: response.function_call_arguments.delta',
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"x\\"}"}`,
      'event: response.output_item.done',
      `data: {"type":"response.output_item.done","output_index":1,"item":{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"pwsh","arguments":${JSON.stringify(dirtyArgs)}}}`,
      'data: [DONE]',
    ].join("\n")
    const result = sanitizeSseText(sse)
    expect(result.sanitizedEvents).toBe(1)
    expect(result.removedKeys.sort()).toEqual(["justification", "sandbox_permissions"])
    // delta 行逐字节保留
    expect(result.text).toContain('"delta":"{\\"justification\\":"')
    // done 行已清洗（注意 done 的 arguments 是 JSON 字符串的 JSON 转义形态）
    expect(result.text).not.toContain("sandbox_permissions")
    expect(result.text).toContain('\\"command\\":\\"Get-Process\\"')
  })

  it("SSE 文本：非法 JSON / 非目标事件原样放行不炸", () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      "data: {broken-json",
      "data: [DONE]",
    ].join("\n\n")
    const result = sanitizeSseText(sse)
    expect(result.sanitizedEvents).toBe(0)
    expect(result.text).toBe(sse)
  })

  it("聚合载荷清洗：output 数组 function_call 清洗，非对象原样", () => {
    const payload = { id: "resp_1", output: [{ id: "fc_1", type: "function_call", call_id: "call_1", name: "pwsh", arguments: dirtyArgs }] }
    const result = sanitizeResponsesPayload(payload)
    expect(result.sanitizedItems).toBe(1)
    expect(JSON.parse((payload.output[0] as { arguments: string }).arguments)).toEqual({ command: "Get-Process", description: "列出进程" })
    expect(sanitizeResponsesPayload(null)).toEqual({ sanitizedItems: 0, removedKeys: [] })
    expect(sanitizeResponsesPayload({ id: "x" })).toEqual({ sanitizedItems: 0, removedKeys: [] })
  })

  it("transformSummary 标记幂等", () => {
    expect(withDshSanitizeTag("responses-native | remap-codex")).toContain(DSH_ARGS_SANITIZE_TAG)
    const once = withDshSanitizeTag("a | " + DSH_ARGS_SANITIZE_TAG)
    expect(once.split(DSH_ARGS_SANITIZE_TAG).length).toBe(2)
  })
})
