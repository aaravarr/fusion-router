import { NextResponse } from "next/server"
import { getDatabase } from "@/server/db"
import { requireCronBearer } from "@/server/opencode/route-auth"

export const runtime = "nodejs"

const BATCH = 100
const MAX_BATCHES = 500

/**
 * 一次性回填 request_bodies.body_bytes（旧行在加列前没有该值）。
 * 分批执行并在批间让出事件循环，避免对超大 JSON 的 LENGTH 全表扫描长时间阻塞服务。
 * 由部署方/运维手动调用（带 cron bearer），返回本轮回填的行数。
 */
export async function POST(request: Request) {
  const unauthorized = requireCronBearer(request)
  if (unauthorized) return unauthorized
  const db = getDatabase()
  let updated = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const changes = db
      .prepare(
        `UPDATE request_bodies SET body_bytes =
           COALESCE(LENGTH(request_body_json), 0)
           + COALESCE(LENGTH(response_body_json), 0)
           + COALESCE(LENGTH(request_headers_json), 0)
         WHERE rowid IN (SELECT rowid FROM request_bodies WHERE body_bytes = 0 LIMIT ?)`,
      )
      .run(BATCH).changes
    updated += changes
    if (changes === 0) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  return NextResponse.json({ updated })
}

export const GET = POST
