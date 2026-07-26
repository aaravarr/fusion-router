import { z } from "zod"

const balanceRequestSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
})

export const balanceConfigSchema = z.object({
  request: balanceRequestSchema,
  extractor: z.string().trim().min(1).max(20_000),
})

export const createCustomProviderSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  baseUrl: z.string().url().max(2000),
  interfaceType: z.enum(["chat", "responses"]),
  models: z.array(z.string().trim().min(1).max(200)).max(500).nullable().optional(),
  balanceConfig: balanceConfigSchema.nullable().optional(),
  enabled: z.boolean().optional(),
})

export const updateCustomProviderSchema = createCustomProviderSchema.partial()

export const createCustomProviderKeySchema = z.object({
  name: z.string().trim().max(100).optional(),
  apiKey: z.string().trim().min(1).max(20_000),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  maxConcurrency: z.number().int().positive().max(1_000_000).nullable().optional(),
})
