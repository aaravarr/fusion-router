type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => Boolean(value && typeof value === "object" && !Array.isArray(value))

function hasOwn(value: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function visitSchema(node: unknown, seen: WeakSet<object>): number {
  if (!isObj(node) && !Array.isArray(node)) return 0
  const objectNode = node as object
  if (seen.has(objectNode)) return 0
  seen.add(objectNode)

  let patched = 0
  if (isObj(node)) {
    // A declared properties object proves this is a record schema even when
    // the producer omitted `type: "object"`. An object without properties is
    // intentionally treated as a free-form map and left untouched.
    if (isObj(node.properties) && !hasOwn(node, "additionalProperties")) {
      node.additionalProperties = false
      patched += 1
    }
    // Only walk schema-bearing keywords. Do not inspect arbitrary examples,
    // defaults, or descriptions as if they were schema nodes.
    if (isObj(node.properties)) {
      for (const child of Object.values(node.properties)) patched += visitSchema(child, seen)
    }
    for (const key of ["items", "additionalProperties", "contains", "propertyNames", "if", "then", "else", "not"]) {
      if (hasOwn(node, key)) patched += visitSchema(node[key], seen)
    }
    for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
      if (Array.isArray(node[key])) for (const child of node[key]) patched += visitSchema(child, seen)
    }
    if (isObj(node.dependentSchemas)) {
      for (const child of Object.values(node.dependentSchemas)) patched += visitSchema(child, seen)
    }
  } else {
    for (const child of node) patched += visitSchema(child, seen)
  }
  return patched
}

/**
 * 在请求 tools schema 的每个封闭记录节点补 additionalProperties:false。
 * 仅修改 schema 本身；map、显式 additionalProperties 和异常节点 fail-open。
 */
export function strictifyToolSchemasInBody(body: unknown): number {
  if (!isObj(body) || !Array.isArray(body.tools)) return 0
  let patched = 0
  for (const tool of body.tools) {
    if (!isObj(tool)) continue
    const fn = isObj(tool.function) ? tool.function : undefined
    const schema = fn?.parameters ?? tool.parameters
    if (schema !== undefined) patched += visitSchema(schema, new WeakSet<object>())
  }
  return patched
}

export type StrictifyToolSchemasBytesResult = {
  body: Uint8Array<ArrayBuffer> | null
  patchedObjects: number
  changed: boolean
  json: unknown
}

export function strictifyToolSchemasBytes(body: Uint8Array<ArrayBuffer> | null): StrictifyToolSchemasBytesResult {
  if (!body || body.byteLength === 0) return { body, patchedObjects: 0, changed: false, json: undefined }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(body)) } catch { return { body, patchedObjects: 0, changed: false, json: undefined } }
  if (!isObj(parsed)) return { body, patchedObjects: 0, changed: false, json: parsed }
  const patchedObjects = strictifyToolSchemasInBody(parsed)
  if (patchedObjects === 0) return { body, patchedObjects, changed: false, json: parsed }
  return {
    body: new TextEncoder().encode(JSON.stringify(parsed)) as Uint8Array<ArrayBuffer>,
    patchedObjects,
    changed: true,
    json: parsed,
  }
}

export function withSchemaStrictTag(transformSummary: unknown, patchedObjects: number): string {
  const parts = String(transformSummary || "").split(" | ").filter(Boolean)
  const tag = `schema-strict:${patchedObjects}`
  if (!parts.some((part) => part.startsWith("schema-strict:"))) parts.push(tag)
  return parts.join(" | ")
}

export function strictifyToolSchemasForTests(body: unknown): { body: unknown; patchedObjects: number } {
  const cloned = isObj(body) || Array.isArray(body) ? JSON.parse(JSON.stringify(body)) : body
  return { body: cloned, patchedObjects: strictifyToolSchemasInBody(cloned) }
}

export function isSchemaStrictScope(poolType: unknown): boolean {
  return poolType === "openai"
}

export function createEmptyStrictifyResult(): StrictifyToolSchemasBytesResult {
  return { body: null, patchedObjects: 0, changed: false, json: undefined }
}
