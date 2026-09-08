type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => Boolean(value && typeof value === "object" && !Array.isArray(value))

export type ArgsSchemaPruneSummary = {
  removedKeys: string[]
  rules: string[]
  changed: boolean
}

export type ArgsSchemaToolSchemas = Map<string, unknown>

function own(value: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => deepEqual(value, b[index]))
  }
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return false
    const ak = Object.keys(a); const bk = Object.keys(b)
    return ak.length === bk.length && ak.every((key) => own(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

function matchDiscriminator(arg: unknown, condition: unknown): boolean | null {
  if (!isObj(arg) || !isObj(condition) || !isObj(condition.properties)) return null
  const entries = Object.entries(condition.properties).filter(([, value]) => isObj(value) && (own(value, "const") || Array.isArray(value.enum)))
  if (entries.length === 0) return null
  let matched = true
  for (const [key, value] of entries) {
    if (!isObj(value)) return null
    const actual = own(value, "const") ? value.const : value.enum
    if (Array.isArray(actual)) matched = matched && actual.some((expected) => deepEqual(arg[key], expected))
    else matched = matched && deepEqual(arg[key], actual)
  }
  return matched
}

function branchProperties(schema: Obj, args: Obj): { properties: Obj; branchSelected: boolean; branchUncertain: boolean } {
  const properties: Obj = isObj(schema.properties) ? { ...schema.properties } : {}
  const branches: unknown[] = []
  if (Array.isArray(schema.oneOf)) branches.push(...schema.oneOf)
  if (Array.isArray(schema.anyOf)) branches.push(...schema.anyOf)
  let selected: Obj | undefined
  let branchUncertain = false
  if (branches.length) {
    const matches = branches.filter((branch) => matchDiscriminator(args, branch) === true).filter(isObj)
    if (matches.length === 1) selected = matches[0]
    else branchUncertain = true
  }
  if (isObj(schema.if)) {
    const condition = matchDiscriminator(args, schema.if)
    if (condition === true && isObj(schema.then)) selected = schema.then
    else if (condition === false && isObj(schema.else)) selected = schema.else
    else if (condition === null || (condition === true && !isObj(schema.then)) || (condition === false && !isObj(schema.else))) branchUncertain = true
  }
  if (selected && isObj(selected.properties)) Object.assign(properties, selected.properties)
  return { properties, branchSelected: Boolean(selected), branchUncertain }
}

function record(summary: ArgsSchemaPruneSummary, rule: string, key: string): void {
  summary.changed = true
  summary.removedKeys.push(key)
  if (!summary.rules.includes(rule)) summary.rules.push(rule)
}

function pruneObject(value: Obj, rawSchema: unknown, summary: ArgsSchemaPruneSummary, path: string): void {
  if (!isObj(rawSchema)) return
  const schema = rawSchema
  const { properties, branchSelected, branchUncertain } = branchProperties(schema, value)
  // A branch without a provable discriminator is intentionally untouched.
  if (branchUncertain) return
  const hasProperties = isObj(schema.properties) || (branchSelected && Object.keys(properties).length > 0) || schema.type === "object"
  const additionalAllowed = schema.additionalProperties === true
  for (const key of Object.keys(value)) {
    const childSchema = properties[key]
    const keyPath = path ? `${path}.${key}` : key
    if (!childSchema && hasProperties && !additionalAllowed) {
      delete value[key]
      record(summary, "r1", keyPath)
      continue
    }
    if (!isObj(childSchema)) continue
    const required = Array.isArray(schema.required) ? schema.required : []
    if (own(childSchema, "default") && !required.includes(key) && deepEqual(value[key], childSchema.default)) {
      delete value[key]
      record(summary, "r3", keyPath)
      continue
    }
    if (isObj(value[key])) pruneObject(value[key], childSchema, summary, keyPath)
    else if (Array.isArray(value[key]) && isObj(childSchema.items)) {
      for (let i = 0; i < value[key].length; i++) if (isObj(value[key][i])) pruneObject(value[key][i], childSchema.items, summary, `${keyPath}[${i}]`)
    }
  }
}

export function extractToolSchemas(body: unknown): ArgsSchemaToolSchemas {
  const result: ArgsSchemaToolSchemas = new Map()
  if (!isObj(body) || !Array.isArray(body.tools)) return result
  for (const tool of body.tools) {
    if (!isObj(tool)) continue
    const fn = isObj(tool.function) ? tool.function : undefined
    const name = typeof (fn?.name ?? tool.name) === "string" ? String(fn?.name ?? tool.name) : ""
    const schema = fn?.parameters ?? tool.parameters
    if (name && schema !== undefined) result.set(name, schema)
  }
  return result
}

function schemaFor(schemas: ArgsSchemaToolSchemas, name: unknown): unknown {
  return typeof name === "string" && name ? schemas.get(name) : undefined
}

function pruneArgsValue(value: unknown, schema: unknown, summary: ArgsSchemaPruneSummary, path = ""): unknown {
  if (!isObj(value) || !isObj(schema)) return value
  pruneObject(value, schema, summary, path)
  return value
}

export function pruneFunctionArguments(raw: unknown, schema: unknown, summary: ArgsSchemaPruneSummary, path = ""): unknown {
  const before = summary.removedKeys.length
  let result = raw
  if (typeof raw === "string") {
    let value: unknown
    try { value = JSON.parse(raw) } catch { return raw }
    if (!isObj(value)) return raw
    pruneArgsValue(value, schema, summary, path)
    try { result = JSON.stringify(value) } catch { return raw }
  } else if (isObj(raw)) result = pruneArgsValue(raw, schema, summary, path)
  if (summary.removedKeys.length > before && isObj(schema) && (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || isObj(schema.if)) && !summary.rules.includes("r2")) summary.rules.push("r2")
  return result
}

function emptySummary(): ArgsSchemaPruneSummary { return { removedKeys: [], rules: [], changed: false } }

function pruneOutputItem(item: unknown, schemas: ArgsSchemaToolSchemas, summary: ArgsSchemaPruneSummary, path: string): void {
  if (!isObj(item) || String(item.type ?? "").toLowerCase() !== "function_call") return
  const schema = schemaFor(schemas, item.name)
  if (schema === undefined) return
  const before = summary.removedKeys.length
  item.arguments = pruneFunctionArguments(item.arguments, schema, summary, path)
  if (summary.removedKeys.length > before && (isObj(schema) && (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || isObj(schema.if)))) {
    if (!summary.rules.includes("r2")) summary.rules.push("r2")
  }
}

export function pruneResponsesPayload(payload: unknown, schemas: ArgsSchemaToolSchemas): ArgsSchemaPruneSummary {
  const summary = emptySummary()
  if (!isObj(payload) || schemas.size === 0) return summary
  if (Array.isArray(payload.output)) payload.output.forEach((item, index) => pruneOutputItem(item, schemas, summary, `output[${index}].arguments`))
  if (Array.isArray(payload.choices)) {
    payload.choices.forEach((choice, ci) => {
      if (!isObj(choice) || !isObj(choice.message) || !Array.isArray(choice.message.tool_calls)) return
      choice.message.tool_calls.forEach((call, ti) => {
        if (!isObj(call) || !isObj(call.function)) return
        const schema = schemaFor(schemas, call.function.name)
        if (schema === undefined) return
        call.function.arguments = pruneFunctionArguments(call.function.arguments, schema, summary, `choices[${ci}].message.tool_calls[${ti}].function.arguments`)
      })
    })
  }
  return summary
}

function pruneSseEvent(event: Obj, schemas: ArgsSchemaToolSchemas, names: Map<string, string>): ArgsSchemaPruneSummary {
  const summary = emptySummary()
  const type = String(event.type ?? "")
  if ((type === "response.output_item.added" || type === "response.output_item.done") && isObj(event.item)) {
    const id = event.item.id ?? event.item.call_id
    if (typeof id === "string" && typeof event.item.name === "string") names.set(id, event.item.name)
    if (type === "response.output_item.done") pruneOutputItem(event.item, schemas, summary, "event.item.arguments")
  } else if (type === "response.function_call_arguments.done") {
    const name = names.get(String(event.item_id ?? "")) ?? event.name
    const schema = schemaFor(schemas, name)
    if (schema !== undefined) event.arguments = pruneFunctionArguments(event.arguments, schema, summary, "event.arguments")
  } else if (["response.completed", "response.incomplete", "response.failed"].includes(type) && isObj(event.response)) {
    const nested = pruneResponsesPayload(event.response, schemas)
    summary.changed = nested.changed; summary.removedKeys.push(...nested.removedKeys); summary.rules.push(...nested.rules.filter((rule) => !summary.rules.includes(rule)))
  }
  return summary
}

function mergeSummary(target: ArgsSchemaPruneSummary, source: ArgsSchemaPruneSummary): void {
  if (!source.changed) return
  target.changed = true
  target.removedKeys.push(...source.removedKeys)
  for (const rule of source.rules) if (!target.rules.includes(rule)) target.rules.push(rule)
}

export function pruneSseText(rawText: string, schemas: ArgsSchemaToolSchemas): { text: string; summary: ArgsSchemaPruneSummary; sanitizedEvents: number } {
  const summary = emptySummary(); let sanitizedEvents = 0
  if (!rawText || schemas.size === 0 || !rawText.includes("data:")) return { text: rawText, summary, sanitizedEvents }
  const names = new Map<string, string>(); const lines = rawText.split(/\r?\n/); let dirty = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trimStart(); if (!payload || payload === "[DONE]") continue
    let parsed: unknown; try { parsed = JSON.parse(payload) } catch { continue }
    if (!isObj(parsed)) continue
    const eventSummary = pruneSseEvent(parsed, schemas, names)
    if (!eventSummary.changed) continue
    try { lines[i] = `data: ${JSON.stringify(parsed)}`; dirty = true; sanitizedEvents++; mergeSummary(summary, eventSummary) } catch { /* fail-open */ }
  }
  return { text: dirty ? lines.join("\n") : rawText, summary: dirty ? summary : emptySummary(), sanitizedEvents }
}

export type IncrementalArgsSchemaPrunerResult = ArgsSchemaPruneSummary & { sanitizedEvents: number }

export function createIncrementalArgsSchemaPruner(
  schemas: ArgsSchemaToolSchemas,
  onPruned?: (result: IncrementalArgsSchemaPrunerResult) => void,
): { stream: TransformStream<Uint8Array, Uint8Array>; result: () => IncrementalArgsSchemaPrunerResult } {
  const decoder = new TextDecoder(); const encoder = new TextEncoder(); let buffer = ""; let sanitizedEvents = 0; const summary = emptySummary(); const names = new Map<string, string>()
  const processLine = (lineWithEnding: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const ending = lineWithEnding.endsWith("\r\n") ? "\r\n" : lineWithEnding.endsWith("\n") ? "\n" : ""; const line = ending ? lineWithEnding.slice(0, -ending.length) : lineWithEnding
    if (!line.startsWith("data:")) { controller.enqueue(encoder.encode(lineWithEnding)); return }
    const payload = line.slice(5).trimStart(); if (!payload || payload === "[DONE]") { controller.enqueue(encoder.encode(lineWithEnding)); return }
    let parsed: unknown; try { parsed = JSON.parse(payload) } catch { controller.enqueue(encoder.encode(lineWithEnding)); return }
    if (!isObj(parsed)) { controller.enqueue(encoder.encode(lineWithEnding)); return }
    const eventSummary = pruneSseEvent(parsed, schemas, names)
    if (!eventSummary.changed) { controller.enqueue(encoder.encode(lineWithEnding)); return }
    try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}${ending}`)); sanitizedEvents++; mergeSummary(summary, eventSummary); onPruned?.({ ...summary, sanitizedEvents }) } catch { controller.enqueue(encoder.encode(lineWithEnding)) }
  }
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); for (;;) { const match = /\r?\n/.exec(buffer); if (!match || match.index == null) break; const end = match.index + match[0].length; processLine(buffer.slice(0, end), controller); buffer = buffer.slice(end) } },
    flush(controller) { buffer += decoder.decode(); if (buffer) processLine(buffer, controller); buffer = "" },
  })
  return { stream, result: () => ({ ...summary, removedKeys: [...summary.removedKeys], rules: [...summary.rules], sanitizedEvents }) }
}

export function withArgsSchemaPruneTag(transformSummary: unknown, summary: Pick<ArgsSchemaPruneSummary, "rules" | "removedKeys">): string {
  const parts = String(transformSummary || "").split(" | ").filter(Boolean)
  const keys = [...new Set(summary.removedKeys)].join(",") || "none"
  const tag = `args-schema-prune[${summary.rules.join(",") || "unknown"}]:${summary.removedKeys.length}:${keys}`
  if (!parts.some((part) => part.startsWith("args-schema-prune["))) parts.push(tag)
  return parts.join(" | ")
}

export function summarizeArgsSchemaPrune(summary: ArgsSchemaPruneSummary): ArgsSchemaPruneSummary {
  return { changed: summary.changed, rules: [...summary.rules], removedKeys: [...new Set(summary.removedKeys)] }
}

export function isArgsSchemaPruneScope(poolType: unknown): boolean {
  return poolType === "openai"
}

export function createEmptyArgsSchemaPruneSummary(): ArgsSchemaPruneSummary { return emptySummary() }
