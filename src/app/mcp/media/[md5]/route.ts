import { getDatabase } from "@/server/db"
import { readMedia, verifySignedMediaPath } from "@/server/media-store"

export const runtime = "nodejs"

/**
 * 临时媒体读取端点：/mcp/media/<md5>?exp=<ts>&sig=<sig>
 * 带签名 + 过期校验，仅用于接口兼容下把图片引用写进消息文本后由外层取图。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ md5: string }> },
) {
  const { md5 } = await context.params
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    return Response.json({ error: { type: "not_found" } }, { status: 404 })
  }
  const url = new URL(request.url)
  const exp = url.searchParams.get("exp")
  const sig = url.searchParams.get("sig")
  if (!verifySignedMediaPath(md5, exp, sig)) {
    return Response.json({ error: { type: "forbidden", message: "媒体链接无效或已过期" } }, { status: 403 })
  }
  const media = readMedia(md5, getDatabase())
  if (!media) {
    return Response.json({ error: { type: "not_found" } }, { status: 404 })
  }
  return new Response(new Uint8Array(media.buffer), {
    status: 200,
    headers: {
      "content-type": media.mime,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  })
}
