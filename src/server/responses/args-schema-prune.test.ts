import { describe, expect, it } from "vitest"
import { extractToolSchemas, pruneFunctionArguments, pruneResponsesPayload, pruneSseText } from "./args-schema-prune"

describe("args-schema-prune", () => {
  it("R1 removes unknown keys from flat object and recurses", () => {
    const schemas = extractToolSchemas({ tools: [{ type: "function", function: { name: "SendToUser", parameters: { type: "object", properties: { type: { type: "string" }, content: { type: "string" }, meta: { type: "object", properties: { ok: { type: "boolean" } } } } } } }] })
    const payload = { output: [{ type: "function_call", name: "SendToUser", arguments: JSON.stringify({ type: "text", content: "ok", unused: "x", meta: { ok: true, extra: 1 } }) }] }
    const result = pruneResponsesPayload(payload, schemas)
    expect(result.rules).toContain("r1")
    expect(JSON.parse(String(payload.output[0].arguments))).toEqual({ type: "text", content: "ok", meta: { ok: true } })
  })

  it("R2 chooses oneOf branch by const discriminator", () => {
    const schema = { type: "object", oneOf: [
      { properties: { type: { const: "text" }, content: { type: "string" } }, required: ["type"] },
      { properties: { type: { const: "widget" }, widget: { type: "object" } }, required: ["type"] },
    ] }
    const summary = { removedKeys: [], rules: [], changed: false }
    const output = pruneFunctionArguments(JSON.stringify({ type: "text", content: "ok", widget: { unused: true } }), schema, summary)
    expect(JSON.parse(String(output))).toEqual({ type: "text", content: "ok" })
    expect(summary.rules).toContain("r1")
    expect(summary.rules).toContain("r2")
  })

  it("R3 removes optional values equal to schema defaults, but keeps required", () => {
    const schema = { type: "object", properties: { mode: { type: "string", default: "auto" }, count: { type: "number", default: 1 } }, required: ["count"] }
    const summary = { removedKeys: [], rules: [], changed: false }
    const output = pruneFunctionArguments(JSON.stringify({ mode: "auto", count: 1 }), schema, summary)
    expect(JSON.parse(String(output))).toEqual({ count: 1 })
    expect(summary.rules).toEqual(["r3"])
  })

  it("SSE tracks tool name from added and prunes arguments.done and output_item.done", () => {
    const schemas = extractToolSchemas({ tools: [{ name: "echo", parameters: { type: "object", properties: { text: { type: "string" } } } }] })
    const raw = [
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","name":"echo","arguments":""}}',
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":${JSON.stringify(JSON.stringify({ text: "ok", extra: 1 }))}}`,
      `data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"echo","arguments":${JSON.stringify(JSON.stringify({ text: "ok", extra: 1 }))}}}`,
    ].join("\n")
    const result = pruneSseText(raw, schemas)
    expect(result.summary.rules).toContain("r1")
    expect(result.text).not.toContain("extra")
  })

  it("fails open when branch discriminator is not provable", () => {
    const schemas = new Map([["tool", { oneOf: [{ properties: { kind: { const: "a" }, a: {} } }, { properties: { kind: { const: "b" }, b: {} } }] }]])
    const payload = { output: [{ type: "function_call", name: "tool", arguments: JSON.stringify({ a: 1, b: 2 }) }] }
    const result = pruneResponsesPayload(payload, schemas)
    expect(result.changed).toBe(false)
    expect(JSON.parse(String(payload.output[0].arguments))).toEqual({ a: 1, b: 2 })
  })
})
