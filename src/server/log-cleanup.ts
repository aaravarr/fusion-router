import type { AppDatabase } from "./db";

export interface CleanupBatchResult {
  deletedRequests: number;
  deletedBodies: number;
}

/** 按保留天数计算 cutoff 时间（ISO 字符串，可直接与 started_at 字典序比较并走索引）。 */
export function cutoffForRetention(retentionDays: number): string {
  const days = Math.max(1, Math.floor(retentionDays))
  return new Date(Date.now() - days * 24 * 3600_000).toISOString()
}

/**
 * 删除一批过期请求及其 body（先删 body 再删 request，单事务内完成）。
 * 用 started_at < ? 而非 julianday(...) 比较，避免函数套列导致索引失效全表扫描；
 * 分批 + LIMIT 避免一次级联删除超大 request_bodies 长事务持锁。
 */
export function deleteOldRequestsBatch(db: AppDatabase, cutoffIso: string, limit = 200): CleanupBatchResult {
  return db
    .transaction(() => {
      const deletedBodies = db
        .prepare(
          `DELETE FROM request_bodies WHERE request_id IN (SELECT id FROM gateway_requests WHERE started_at < ? LIMIT ?)`,
        )
        .run(cutoffIso, limit).changes
      const deletedRequests = db
        .prepare(
          `DELETE FROM gateway_requests WHERE id IN (SELECT id FROM gateway_requests WHERE started_at < ? LIMIT ?)`,
        )
        .run(cutoffIso, limit).changes
      return { deletedRequests, deletedBodies }
    })
    .immediate()
}

const CLEANUP_BATCH_LIMIT = 200
const CLEANUP_MAX_BATCHES = 500

/** 分批清理过期日志，每批之间让出事件循环，避免长事务持锁阻塞整个服务。 */
export async function cleanupOldRequests(
  db: AppDatabase,
  retentionDays: number,
): Promise<{ deletedRequests: number; deletedBodies: number }> {
  const cutoffIso = cutoffForRetention(retentionDays)
  let deletedRequests = 0
  let deletedBodies = 0
  for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
    const batch = deleteOldRequestsBatch(db, cutoffIso, CLEANUP_BATCH_LIMIT)
    deletedRequests += batch.deletedRequests
    deletedBodies += batch.deletedBodies
    if (batch.deletedRequests === 0) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { deletedRequests, deletedBodies }
}

const STRIP_BATCH_LIMIT = 200
const STRIP_MAX_BATCHES = 500

/** 分批剥离所有请求体（rowid 快照），每批之间让出事件循环。 */
export async function stripAllBodies(db: AppDatabase): Promise<{ stripped: number }> {
  let stripped = 0
  for (let i = 0; i < STRIP_MAX_BATCHES; i++) {
    const changes = db
      .prepare(`DELETE FROM request_bodies WHERE rowid IN (SELECT rowid FROM request_bodies LIMIT ?)`)
      .run(STRIP_BATCH_LIMIT).changes
    stripped += changes
    if (changes === 0) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { stripped }
}
