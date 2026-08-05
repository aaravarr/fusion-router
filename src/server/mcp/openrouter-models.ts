import type { AppDatabase } from "@/server/db"
import { getDatabase } from "@/server/db"
import { storeDataUri } from "@/server/media-store"

/**
 * 基于 OpenRouter 模型目录判断模型是否支持图片输入（多模态）。
 *
 * OpenRouter GET /api/v1/models 返回每个模型的 architecture.input_modalities，
 * 包含 "image" 即支持图片输入。结果缓存到 system_settings（key:
 * openrouter_model_modalities），TTL 24 小时，避免每次请求都拉取 500KB 目录。
 *
 * 匹配策略：池模型名（如 qwen3.7-plus）与 OpenRouter id 的 slug 部分
 * （qwen/qwen3.7-plus -> qwen3.7-plus）做不区分大小写的精确匹配。
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
export const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const OPENROUTER_CACHE_KEY = "openrouter_model_modalities"

interface ModalityCacheRow {
  value_json: string
}

export interface OpenRouterModelInfo {
  id: string
  inputModalities: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 解析 OpenRouter /api/v1/models 响应，返回模型 id -> 输入模态数组。 */
export function parseOpenRouterModels(payload: unknown): OpenRouterModelInfo[] {
  if (!payload || typeof payload !== "object") return []
  const list = (payload as { data?: unknown }).data
  if (!Array.isArray(list)) return []
  const out: OpenRouterModelInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string") continue
    const arch = record.architecture as Record<string, unknown> | undefined
    const mods = Array.isArray(arch?.input_modalities)
      ? (arch.input_modalities as unknown[]).filter((m): m is string => typeof m === "string")
      : []
    out.push({ id: record.id, inputModalities: mods })
  }
  return out
}

export interface OpenRouterCache {
  fetchedAt: string
  models: Record<string, string[]>
}

function readCache(db: AppDatabase): OpenRouterCache | null {
  const row = db
    .prepare("SELECT value_json FROM system_settings WHERE key = ? AND is_secret = 0")
    .get(OPENROUTER_CACHE_KEY) as ModalityCacheRow | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value_json) as OpenRouterCache
    if (parsed && typeof parsed.fetchedAt === "string" && parsed.models && typeof parsed.models === "object") {
      return parsed
    }
  } catch {
    // 损坏的缓存忽略
  }
  return null
}

function writeCache(db: AppDatabase, models: Record<string, string[]>): void {
  const cache: OpenRouterCache = { fetchedAt: nowIso(), models }
  const value = JSON.stringify(cache)
  db.prepare(
    `INSERT INTO system_settings(key, value_json, is_secret, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(OPENROUTER_CACHE_KEY, value, nowIso())
}

export function isCacheFresh(cache: OpenRouterCache): boolean {
  const fetched = Date.parse(cache.fetchedAt)
  if (Number.isNaN(fetched)) return false
  return Date.now() - fetched < OPENROUTER_CACHE_TTL_MS
}

/**
 * 从 OpenRouter 拉取模型目录并解析为 slug -> 输入模态映射（不缓存，供测试/手动刷新）。
 * 失败时返回 null。
 */
export async function fetchOpenRouterModalities(
  fetchImpl: typeof fetch = fetch,
  url = OPENROUTER_MODELS_URL,
): Promise<Record<string, string[]> | null> {
  try {
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    const infos = parseOpenRouterModels(payload)
    const map: Record<string, string[]> = {}
    for (const info of infos) {
      const slug = info.id.split("/").pop() ?? info.id
      map[slug.toLowerCase()] = info.inputModalities
    }
    return map
  } catch {
    return null
  }
}

/**
 * 获取"模型名（小写）-> 是否支持图片输入"的判断函数。
 * 优先用 OpenRouter 缓存；缓存缺失/过期时尝试拉取一次（成功则更新缓存），
 * 拉取失败回退到内置白名单（避免网络抖动时下拉空掉）。
 */
export async function getOpenRouterModalityMap(
  db: AppDatabase = getDatabase(),
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string[]>> {
  const cached = readCache(db)
  if (cached && isCacheFresh(cached)) return cached.models
  const fetched = await fetchOpenRouterModalities(fetchImpl)
  if (fetched) {
    writeCache(db, fetched)
    return fetched
  }
  // 有旧缓存（虽过期）先用着，避免请求期下拉为空
  if (cached) return cached.models
  return {}
}

/**
 * 兜底白名单：OpenRouter 不可达且无缓存时使用。
 * 覆盖本池常见的已验证多模态模型；正常情况以 OpenRouter 数据为准。
 */
const FALLBACK_VISION_SLUGS = new Set([
  "minimax-m3",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.7-plus",
  "qwen3.8-max",
  "mimo-v2.5",
  "grok-4.5",
  "gpt-5.6-luna",
])

/** 返回给定模型名是否为多模态（支持图片输入）。 */
export async function isVisionModel(
  model: string,
  db: AppDatabase = getDatabase(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const slug = model.trim().toLowerCase()
  if (!slug) return false
  const map = await getOpenRouterModalityMap(db, fetchImpl)
  const mods = map[slug]
  if (mods) return mods.includes("image")
  return FALLBACK_VISION_SLUGS.has(slug)
}

/** 从模型列表过滤出支持图片输入的模型。 */
export async function filterVisionModels(
  models: string[],
  db: AppDatabase = getDatabase(),
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const map = await getOpenRouterModalityMap(db, fetchImpl)
  const out: string[] = []
  for (const model of models) {
    const slug = model.trim().toLowerCase()
    if (!slug) continue
    const mods = map[slug]
    if (mods ? mods.includes("image") : FALLBACK_VISION_SLUGS.has(slug)) {
      out.push(model)
    }
  }
  return out
}


/**
 * 判断模型是否支持图片输入，供网关"接口兼容"拦截使用。
 * 返回值语义：
 * - true  ：支持图片（OpenRouter 确认或兜底白名单）
 * - false ：明确不支持图片（OpenRouter 确认）
 * - null  ：未知（OpenRouter 无此模型且不在兜底白名单）——调用方应放行，避免误拦。
 */
export async function modelSupportsImage(
  model: string,
  db: AppDatabase = getDatabase(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  const slug = model.trim().toLowerCase()
  if (!slug) return null
  const map = await getOpenRouterModalityMap(db, fetchImpl)
  const mods = map[slug]
  if (mods) return mods.includes("image")
  if (FALLBACK_VISION_SLUGS.has(slug)) return true
  return null
}


/**
 * 检测请求体是否包含图片输入（chat 的 image_url，或 responses 的 input_image / input_file）。
 * 供网关在调用前判断：模型不支持图片时给出清晰错误，而不是把图片发上去让上游报错。
 */
export function hasImageInBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const record = body as Record<string, unknown>
  // Responses 格式：input 数组里的 input_image / input_file
  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      if (!item || typeof item !== "object") continue
      const part = item as Record<string, unknown>
      const type = String(part.type ?? "")
      if (type === "input_image" || type === "input_file") return true
      if (type === "message" && Array.isArray(part.content)) {
        for (const sub of part.content) {
          if (sub && typeof sub === "object") {
            const st = String((sub as Record<string, unknown>).type ?? "")
            if (st === "input_image" || st === "input_file") return true
          }
        }
      }
    }
  }
  // Chat 格式：messages[].content 数组里的 image_url / input_image / input_file
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (!message || typeof message !== "object") continue
      const content = (message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue
          const type = String((part as Record<string, unknown>).type ?? "")
          if (type === "image_url" || type === "input_image" || type === "input_file") return true
        }
      }
    }
  }
  return false
}
/**
 * 把单个图片 part 转成文本信息 part。
 * - http(s) URL：直接文本化 URL（模型能看到图片来源，配合外层机制取图）
 * - data URI：落盘为临时媒体，生成带签名 URL 引用写进文本（完整 base64 塞文本会爆 token）
 */
async function imagePartToText(
  part: Record<string, unknown>,
  db: AppDatabase,
): Promise<Record<string, unknown>> {
  const imageUrl =
    typeof part.image_url === "string"
      ? part.image_url
      : part.image_url && typeof part.image_url === "object"
        ? (part.image_url as Record<string, unknown>).url
        : part.url
  const url = typeof imageUrl === "string" ? imageUrl : ""
  if (/^https?:\/\/.*/i.test(url)) {
    return { type: "text", text: `[图片: ${url}]` }
  }
  try {
    const stored = storeDataUri(url, db)
    return { type: "text", text: `[图片: ${stored.urlPath}]` }
  } catch {
    const mime = url.startsWith("data:") ? (url.slice(5, url.indexOf(";")) || "图片") : "图片"
    return { type: "text", text: `[用户上传了一张${mime}，图片数据未随请求发送]` }
  }
}

/**
 * 接口兼容：把请求体中的图片 part 改写为文本信息（chat 的 image_url /
 * responses 的 input_image / input_file），返回改写后的深拷贝与是否发生了改写。
 * 用于"模型不支持图片输入"的场景：不把图片字节发给模型，只让模型知道图的存在与来源，
 * data URI 会落盘为临时媒体并生成签名 URL 引用（外层 MCP 识图工具可经 URL 取图）。
 */
export async function rewriteImagesToText(
  body: unknown,
  db: AppDatabase = getDatabase(),
): Promise<{ body: unknown; converted: boolean }> {
  if (!body || typeof body !== "object") return { body, converted: false }
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
  let converted = false

  // chat 格式：messages[].content 数组里的 image_url
  if (Array.isArray(clone.messages)) {
    for (const message of clone.messages) {
      if (!message || typeof message !== "object") continue
      const record = message as Record<string, unknown>
      if (!Array.isArray(record.content)) continue
      const parts: unknown[] = []
      for (const part of record.content) {
        if (!part || typeof part !== "object") { parts.push(part); continue }
        const p = part as Record<string, unknown>
        if (String(p.type ?? "") === "image_url") {
          converted = true
          parts.push(await imagePartToText(p, db))
        } else {
          parts.push(p)
        }
      }
      record.content = parts
    }
  }

  // responses 格式：input 数组里的顶层 input_image / input_file，
  // 或 message 的 content 数组里的 input_image / input_file
  if (Array.isArray(clone.input)) {
    const input: unknown[] = []
    for (const item of clone.input) {
      if (!item || typeof item !== "object") { input.push(item); continue }
      const it = item as Record<string, unknown>
      const type = String(it.type ?? "")
      if (type === "input_image" || type === "input_file") {
        converted = true
        input.push({ type: "message", role: "user", content: [await imagePartToText(it, db)] })
        continue
      }
      if (type === "message" && Array.isArray(it.content)) {
        const parts: unknown[] = []
        for (const part of it.content) {
          if (!part || typeof part !== "object") { parts.push(part); continue }
          const p = part as Record<string, unknown>
          const pt = String(p.type ?? "")
          if (pt === "input_image" || pt === "input_file") {
            converted = true
            parts.push(await imagePartToText(p, db))
          } else {
            parts.push(p)
          }
        }
        it.content = parts
      }
      input.push(it)
    }
    clone.input = input
  }

  return { body: clone, converted }
}

