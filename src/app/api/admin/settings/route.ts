import { z } from "zod";
import { getLogSettings, getPublicSecretStatus, getSystemSettings, updateSystemSettings } from "@/server/settings";
import { requireAdministrator } from "../_auth";
export const runtime = "nodejs";
const schema = z.object({
  githubMirrorUrl: z.string().trim().max(500).optional(),
  domainMirrorMap: z.record(z.string(), z.object({
    mirrors: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), enabled: z.boolean() })),
    accountAssignments: z.record(z.string(), z.string()),
    rules: z.array(z.object({ id: z.string(), pattern: z.string().max(500), mirrorId: z.string(), enabled: z.boolean() })),
    requestRules: z.array(z.object({
      id: z.string(),
      enabled: z.boolean(),
      mirrorId: z.string(),
      condition: z.enum(["and", "or"]),
      rules: z.array(z.object({
        id: z.string(),
        enabled: z.boolean(),
        source: z.enum(["body", "header"]),
        field: z.string().max(100),
        operator: z.enum(["equals", "notEquals", "contains", "startsWith"]),
        value: z.string().max(500),
      })),
    })).optional(),
  })).optional(),
  domainMirrorGroups: z.array(z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    domains: z.array(z.string()),
    accountIds: z.array(z.string()),
    mirrors: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), enabled: z.boolean() })),
    rules: z.array(z.object({ id: z.string(), pattern: z.string().max(500), mirrorId: z.string(), enabled: z.boolean() })),
    requestRules: z.array(z.object({
      id: z.string(),
      enabled: z.boolean(),
      mirrorId: z.string(),
      condition: z.enum(["and", "or"]),
      rules: z.array(z.object({
        id: z.string(),
        enabled: z.boolean(),
        source: z.enum(["body", "header"]),
        field: z.string().max(100),
        operator: z.enum(["equals", "notEquals", "contains", "startsWith"]),
        value: z.string().max(500),
      })),
    })).optional(),
  })).optional(),
  upstreamBaseUrl: z.url(),
  upstreamRequestTimeoutMs: z.number().int().min(1000).max(600000),
  maxFailoverAttempts: z.number().int().min(1).max(32).optional(),
  maintenanceEnabled: z.boolean(),
  maintenanceIntervalMs: z.number().int().min(10000).max(86400000),
  refreshBatchLimit: z.number().int().min(1).max(500),
  refreshConcurrency: z.number().int().min(1).max(32),
  loggingEnabled: z.boolean(),
  logBodies: z.boolean(),
  logBodiesOnError: z.boolean(),
  logRetentionDays: z.number().int().min(1).max(365),
  maxBodyCaptureBytes: z.number().int().min(1024).max(16777216),
});
function secretStatus() { const value = getPublicSecretStatus(); return { masterKeyReady: true, apiKeyPepperReady: value.apiKeyPepper.configured, cronSecretReady: value.cronSecret.configured }; }
function mergedSettings() { return { ...getSystemSettings(), ...getLogSettings() }; }
export function GET(request: Request) { const user = requireAdministrator(request); if (user instanceof Response) return user; return Response.json({ settings: mergedSettings(), secrets: secretStatus() }); }
export async function PATCH(request: Request) { const user = requireAdministrator(request); if (user instanceof Response) return user; const input = schema.safeParse(await request.json().catch(() => null)); if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查配置值", details: input.error.flatten() } }, { status: 400 }); try { updateSystemSettings(input.data, user.id); return Response.json({ settings: mergedSettings(), secrets: secretStatus() }); } catch (cause) { return Response.json({ error: { type: "validation_error", message: cause instanceof Error ? cause.message : "配置地址不安全" } }, { status: 400 }); } }
