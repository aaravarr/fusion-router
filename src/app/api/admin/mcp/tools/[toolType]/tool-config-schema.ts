import { z } from "zod"

/**
 * 工具配置校验。strict：未知字段直接报错而不是静默剥离——
 * 曾因缺少 provider 字段导致 web_search 的 Provider 配置被丢弃。
 */
export const configSchema = z
  .object({
    poolType: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    maxTokens: z.number().int().min(1).max(32768).optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoningEnabled: z.boolean().optional(),
    // describe_image: low/medium/high；web_search 另支持 none/max
    reasoningEffort: z.enum(["none", "low", "medium", "high", "max"]).nullable().optional(),
    maxToolCalls: z.number().int().min(1).max(20).optional(),
  })
  .strict()
