import { describe, expect, it } from "vitest"
import { strictifyToolSchemasBytes, strictifyToolSchemasForTests } from "./schema-strict"

describe("schema-strict", () => {
  it("chat/responses tools 的封闭记录递归补 additionalProperties:false", () => {
    const input = {
      model: "gpt-test",
      tools: [
        { type: "function", function: { name: "chatTool", parameters: {
          type: "object", properties: {
            nested: { type: "object", properties: { value: { type: "string" } } },
            list: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
          },
          oneOf: [{ properties: { type: { const: "a" }, a: { type: "object", properties: { x: { type: "number" } } } } }, { properties: { type: { const: "b" }, b: { type: "string" } } }],
        } } },
        { type: "function", name: "responsesTool", parameters: { type: "object", properties: { text: { type: "string" } } } },
      ],
    }
    const result = strictifyToolSchemasForTests(input)
    expect(result.patchedObjects).toBe(7)
    const body = result.body as Record<string, unknown>
    const tools = body.tools as Array<Record<string, unknown>>
    const chat = (tools[0].function as Record<string, unknown>).parameters as Record<string, unknown>
    const properties = chat.properties as Record<string, unknown>
    expect(chat.additionalProperties).toBeUndefined()
    expect(Object.keys(properties).at(-1)).toBe("additionalProperties")
    expect(properties.additionalProperties).toBe(false)
    expect((properties.nested as Record<string, unknown>).additionalProperties).toBeUndefined()
    const nestedProperties = (properties.nested as Record<string, unknown>).properties as Record<string, unknown>
    expect(Object.keys(nestedProperties).at(-1)).toBe("additionalProperties")
    expect(nestedProperties.additionalProperties).toBe(false)
    const listItem = ((properties.list as Record<string, unknown>).items) as Record<string, unknown>
    const listProperties = listItem.properties as Record<string, unknown>
    expect(Object.keys(listProperties).at(-1)).toBe("additionalProperties")
    expect(listProperties.additionalProperties).toBe(false)
    const branches = chat.oneOf as Array<Record<string, unknown>>
    const branchProperties = branches[0].properties as Record<string, unknown>
    expect(branches[0].additionalProperties).toBeUndefined()
    expect(Object.keys(branchProperties).at(-1)).toBe("additionalProperties")
    expect(branchProperties.additionalProperties).toBe(false)
    const branchAProperties = (branchProperties.a as Record<string, unknown>).properties as Record<string, unknown>
    expect(branchAProperties.additionalProperties).toBe(false)
    const branchBProperties = branches[1].properties as Record<string, unknown>
    expect(Object.keys(branchBProperties).at(-1)).toBe("additionalProperties")
    expect(branchBProperties.additionalProperties).toBe(false)
    const responseProperties = ((tools[1].parameters as Record<string, unknown>).properties) as Record<string, unknown>
    expect(responseProperties.additionalProperties).toBe(false)
  })

  it("纯 map 和显式 additionalProperties 不改动", () => {
    const input = { tools: [{ parameters: { type: "object", properties: {
      map: { type: "object" },
      open: { type: "object", properties: { x: { type: "string" } }, additionalProperties: true },
      closed: { type: "object", properties: { x: { type: "string" } }, additionalProperties: { type: "string" } },
       member: { type: "object", properties: { x: { type: "string" }, additionalProperties: { const: false } } },
    } } }] }
    const result = strictifyToolSchemasForTests(input)
    expect(result.patchedObjects).toBe(1)
    const schema = (((result.body as Record<string, unknown>).tools as Array<Record<string, unknown>>)[0].parameters) as Record<string, unknown>
    const properties = schema.properties as Record<string, unknown>
    expect(schema.additionalProperties).toBeUndefined()
    expect(Object.keys(properties).at(-1)).toBe("additionalProperties")
    expect(properties.additionalProperties).toBe(false)
    expect((properties.map as Record<string, unknown>).additionalProperties).toBeUndefined()
    expect((properties.open as Record<string, unknown>).additionalProperties).toBe(true)
    expect((properties.closed as Record<string, unknown>).additionalProperties).toEqual({ type: "string" })
    expect(((properties.member as Record<string, unknown>).properties as Record<string, unknown>).additionalProperties).toEqual({ const: false })
  })

  it("异常 schema 和非法 JSON fail-open", () => {
    const malformed = { tools: [{ function: { parameters: { type: "object", properties: "bad" } } }, { parameters: null }, null] }
    const result = strictifyToolSchemasForTests(malformed)
    expect(result.patchedObjects).toBe(0)
    expect(result.body).toEqual(malformed)
    const raw = new TextEncoder().encode("not-json") as Uint8Array<ArrayBuffer>
    const bytes = strictifyToolSchemasBytes(raw)
    expect(bytes.changed).toBe(false)
    expect(bytes.body).toBe(raw)
  })
})
