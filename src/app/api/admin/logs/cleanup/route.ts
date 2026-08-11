import { z } from "zod";
import { getDatabase } from "@/server/db";
import { cleanupOldRequests, stripAllBodies } from "@/server/log-cleanup";
import { requireAdministrator } from "../../_auth";

export const runtime = "nodejs";

const schema = z.object({
  retentionDays: z.number().int().min(1).max(365).optional(),
  stripBodies: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const user = requireAdministrator(request);
  if (user instanceof Response) return user;
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查清理参数", details: input.error.flatten() } }, { status: 400 });
  const db = getDatabase();
  const result: { deletedRequests?: number; deletedBodies?: number; stripped?: number } = {};
  if (input.data.retentionDays !== undefined) {
    const cleanup = await cleanupOldRequests(db, input.data.retentionDays);
    result.deletedRequests = cleanup.deletedRequests;
    result.deletedBodies = cleanup.deletedBodies;
  }
  if (input.data.stripBodies) {
    const strip = await stripAllBodies(db);
    result.stripped = strip.stripped;
  }
  return Response.json(result);
}
