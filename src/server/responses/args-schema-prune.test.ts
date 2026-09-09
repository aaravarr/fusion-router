import { describe, expect, it } from "vitest"
import { extractToolSchemas, pruneFunctionArguments, pruneResponsesPayload, pruneSseText } from "./args-schema-prune"

describe("args-schema-prune", () => {
  it("flat object and default values remain untouched (only R2 is active)", () => {
    const schemas = extractToolSchemas({ tools: [{ type: "function", function: { name: "SendToUser", parameters: { type: "object", properties: { content: { type: "string" }, mode: { type: "string", default: "auto" } } } } }] })
    const payload = { output: [{ type: "function_call", name: "SendToUser", arguments: JSON.stringify({ content: "ok", extra: "x", mode: "auto" }) }] }
    const result = pruneResponsesPayload(payload, schemas)
    expect(result.changed).toBe(false)
    expect(JSON.parse(String(payload.output[0].arguments))).toEqual({ content: "ok", extra: "x", mode: "auto" })
  })

  it("R2 chooses oneOf branch by const discriminator", () => {
    const schema = { type: "object", oneOf: [
      { properties: { type: { const: "text" }, content: { type: "string" } }, required: ["type"] },
      { properties: { type: { const: "widget" }, widget: { type: "object" } }, required: ["type"] },
    ] }
    const summary = { removedKeys: [], rules: [], changed: false }
    const output = pruneFunctionArguments(JSON.stringify({ type: "text", content: "ok", widget: { unused: true } }), schema, summary)
    expect(JSON.parse(String(output))).toEqual({ type: "text", content: "ok" })
    expect(summary.rules).toEqual(["r2"])
  })

  it("SSE tracks tool name from added and prunes arguments.done and output_item.done", () => {
    const schemas = extractToolSchemas({ tools: [{ name: "echo", parameters: { oneOf: [{ properties: { kind: { const: "echo" }, text: { type: "string" } } }] } }] })
    const raw = [
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","name":"echo","arguments":""}}',
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":${JSON.stringify(JSON.stringify({ kind: "echo", text: "ok", extra: 1 }))}}`,
      `data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"echo","arguments":${JSON.stringify(JSON.stringify({ kind: "echo", text: "ok", extra: 1 }))}}}`,
    ].join("\n")
    const result = pruneSseText(raw, schemas)
    expect(result.summary.rules).toEqual(["r2"])
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
