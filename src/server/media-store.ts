import { createHash, createHmac, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { AppDatabase } from "@/server/db"
import { getDatabase } from "@/server/db"
import { getDataDirectory } from "@/server/bootstrap"
import { getSystemSettings } from "@/server/settings"

/**
 * 临时媒体存储：用于"模型不支持图片输入"时的接口兼容。
 *
 * 客户端（如 ZCode）对多模态模型会直接发 data URI 图片；当目标模型不支持图片时，
 * 我们把 data URI 落盘为临时文件，生成带签名的 URL 引用写进消息文本，
 * 让模型/外层工具能通过 URL 取图。图片按内容 md5 去重（KV 缓存），
 * 多轮重复使用同一 data URI 只落盘一次；TTL 与容量上限可在设置页调整。
 */

export const MEDIA_DIR_NAME = "media"
export const MEDIA_URL_PREFIX = "/mcp/media"
const SIGNING_PREFIX = "media-sign:v1"

export interface MediaRecord {
  md5: string
  mime: string
  size: number
  useCount: number
  createdAt: string
  lastUsedAt: string
}

function mediaDir(): string {
  return join(getDataDirectory(), MEDIA_DIR_NAME)
}

export function mediaPath(md5: string): string {
  return join(mediaDir(), md5)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 读取当前媒体配置（TTL 小时、容量上限字节）。 */
export function getMediaConfig(db: AppDatabase = getDatabase()) {
  const settings = getSystemSettings(db)
  return {
    ttlHours: Math.max(1, Number(settings.mediaTtlHours) || 12),
    maxBytes: Math.max(1024 * 1024, Number(settings.mediaMaxBytes) || 200 * 1024 * 1024),
  }
}

function signingKey(): Buffer {
  // 复用 master.key 做签名密钥（不可逆 HMAC，不暴露密钥本身）
  return createHash("sha256").update("opencode-media-sign").digest()
}

/** 生成 /mcp/media/<md5>?exp=<epoch>&sig=<hmac> 的带签名 URL 路径（不含 host）。
 * 同一张图片（md5）在签名有效期内返回固定的路径，绝不重新签名。
 * 原实现每次调用都用 Date.now() 重新生成 exp/sig，让同一张图片写进消息文本后每次都不同，
 * 导致 DeepSeek 等提示词缓存（prefix cache）在第一张图片处就断裂。 */
export function buildSignedMediaPath(md5: string, ttlHours?: number, db: AppDatabase = getDatabase()): string {
  const existing = db
    .prepare("SELECT signed_path FROM media_cache WHERE md5 = ?")
    .get(md5) as { signed_path: string | null } | undefined
  if (existing && typeof existing.signed_path === "string" && existing.signed_path) {
    const exp = parseSignedPathExp(existing.signed_path)
    // 剩余有效期充足就复用，避免每次请求都变化的签名（破坏缓存）。
    if (exp != null && Number.isFinite(exp) && exp - Math.floor(Date.now() / 1000) > SIGNED_PATH_REUSE_MARGIN_SECONDS) {
      return existing.signed_path
    }
  }
  const ttl = ttlHours ?? getMediaConfig(db).ttlHours
  const exp = Math.floor(Date.now() / 1000) + ttl * 3600
  const sig = createHmac("sha256", signingKey()).update(`${md5}:${exp}`).digest("hex").slice(0, 32)
  const path = `${MEDIA_URL_PREFIX}/${md5}?exp=${exp}&sig=${sig}`
  if (existing) {
    // 固定到图片记录上，后续请求再复用。
    db.prepare("UPDATE media_cache SET signed_path = ? WHERE md5 = ?").run(path, md5)
  }
  return path
}

/** 从签名路径中提取 exp（秒），解析失败返回 null。 */
function parseSignedPathExp(path: string): number | null {
  const match = /[?&]exp=(\d+)/.exec(path)
  return match ? Number(match[1]) : null
}

/** 签名复用阈值：剩余有效期小于该值则重新签名。 */
const SIGNED_PATH_REUSE_MARGIN_SECONDS = 5 * 60

/** 校验带签名路径的签名与有效期。 */
export function verifySignedMediaPath(
  md5: string,
  expRaw: string | null,
  sigRaw: string | null,
): boolean {
  if (!expRaw || !sigRaw) return false
  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false
  const expected = createHmac("sha256", signingKey()).update(`${md5}:${exp}`).digest("hex").slice(0, 32)
  if (expected.length !== sigRaw.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigRaw.charCodeAt(i)
  return diff === 0
}

interface ParsedDataUri {
  mime: string
  base64: string
}

/** 解析 data URI（data:<mime>;base64,<data>），非 data URI 返回 null。 */
export function parseDataUri(value: string): ParsedDataUri | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value)
  if (!match) return null
  return { mime: match[1].toLowerCase() || "image/png", base64: match[2] }
}

function md5OfBase64(base64: string): string {
  return createHash("md5").update(base64).digest("hex")
}

/**
 * 存储一张 data URI 图片。按 base64 的 md5 去重：已存在则 use_count+1 并更新
 * last_used_at，不重复落盘。返回 md5、mime、签名 URL 路径。
 */
export function storeDataUri(dataUri: string, db: AppDatabase = getDatabase()): { md5: string; mime: string; size: number; urlPath: string } {
  const parsed = parseDataUri(dataUri)
  if (!parsed) throw new Error("无效的 data URI 图片")
  const md5 = md5OfBase64(parsed.base64)
  const existing = db.prepare("SELECT md5 FROM media_cache WHERE md5 = ?").get(md5) as { md5: string } | undefined
  const now = nowIso()
  if (existing) {
    db.prepare("UPDATE media_cache SET use_count = use_count + 1, last_used_at = ? WHERE md5 = ?").run(now, md5)
    const row = db.prepare("SELECT mime FROM media_cache WHERE md5 = ?").get(md5) as { mime: string }
    return { md5, mime: row.mime, size: 0, urlPath: buildSignedMediaPath(md5, undefined, db) }
  }
  // 未命中：落盘 + 插记录
  mkdirSync(mediaDir(), { recursive: true })
  const buffer = Buffer.from(parsed.base64, "base64")
  writeFileSync(mediaPath(md5), buffer)
  db.prepare(
    "INSERT INTO media_cache(md5, mime, size, use_count, created_at, last_used_at) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(md5, parsed.mime, buffer.length, now, now)
  return { md5, mime: parsed.mime, size: buffer.length, urlPath: buildSignedMediaPath(md5, undefined, db) }
}

/** 按 md5 读取媒体文件，不存在返回 null。 */
export function readMedia(md5: string, db: AppDatabase = getDatabase()): { buffer: Buffer; mime: string } | null {
  const row = db.prepare("SELECT mime FROM media_cache WHERE md5 = ?").get(md5) as { mime: string } | undefined
  if (!row) return null
  const file = mediaPath(md5)
  if (!existsSync(file)) return null
  return { buffer: readFileSync(file), mime: row.mime }
}

export interface MediaCleanupResult {
  expiredRemoved: number
  overCapacityRemoved: number
  remainingBytes: number
}

/**
 * 清理过期与超容量的媒体文件。TTL 与容量上限取自设置（可调整）。
 * 按 last_used_at 最旧优先删除。
 */
export function cleanupMedia(db: AppDatabase = getDatabase(), now = new Date()): MediaCleanupResult {
  const { ttlHours, maxBytes } = getMediaConfig(db)
  let expiredRemoved = 0
  let overCapacityRemoved = 0

  // 1) 清过期
  const expiredAt = new Date(now.getTime() - ttlHours * 3600_000).toISOString()
  const expiredRows = db.prepare("SELECT md5 FROM media_cache WHERE last_used_at < ?").all(expiredAt) as { md5: string }[]
  for (const row of expiredRows) {
    removeMediaFile(db, row.md5)
    expiredRemoved += 1
  }

  // 2) 算剩余总量，超容量按最旧清
  const rows = db.prepare("SELECT md5, size FROM media_cache ORDER BY last_used_at ASC").all() as { md5: string; size: number }[]
  let total = rows.reduce((sum, row) => sum + Number(row.size || 0), 0)
  for (const row of rows) {
    if (total <= maxBytes) break
    removeMediaFile(db, row.md5)
    total -= Number(row.size || 0)
    overCapacityRemoved += 1
  }

  return { expiredRemoved, overCapacityRemoved, remainingBytes: total }
}

function removeMediaFile(db: AppDatabase, md5: string): void {
  db.prepare("DELETE FROM media_cache WHERE md5 = ?").run(md5)
  const file = mediaPath(md5)
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // 文件删除失败不影响 DB 清理
  }
}

/** 生成一个不透明短引用（可选，供以后扩展）；当前用签名 URL 为主。 */
export function generateMediaRef(): string {
  return randomBytes(8).toString("hex")
}
