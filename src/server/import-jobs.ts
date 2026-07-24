import { createHash, randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { SecretVault } from "./crypto"
import { AccountRepository, ProviderCredentialRepository } from "./repository"
import type { PoolType } from "./types"
import { convertSsoToBuild, decodeJwtClaims, jwtClaimString } from "./xai-sso-device"
import { exchangeXaiRefreshToken } from "./providers/xai-grok"
import { exchangeOpenAIRefreshToken } from "./providers/openai-cpa"
import { refreshKimiAccessToken, KIMI_CODE_CLIENT_ID } from "./kimi-oauth"
import { tryGetProvider } from "./providers"

export const IMPORT_FORMATS = ["sub2api-json", "cpa-json", "refresh-token", "access-token", "xai-sso"] as const
export type ImportFormat = (typeof IMPORT_FORMATS)[number]
export type ImportJobStatus = "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED"

interface ImportSeed {
  label: string
  poolType: PoolType
  accessToken?: string
  refreshToken?: string
  clientId?: string
  expiresAt?: string
  idToken?: string
  tokenType?: string
  scope?: string
  email?: string
  subject?: string
  ssoToken?: string
  concurrency?: number
}

interface ImportJobRow {
  id: string
  owner_user_id: string
  pool_type: PoolType
  format: ImportFormat
  status: ImportJobStatus
  total_items: number
  processed_items: number
  succeeded_items: number
  failed_items: number
  current_step: string | null
  error: string | null
  payload_ciphertext: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  rolled_back_at: string | null
  rolled_back_accounts: number
  updated_at: string
}

type JsonRecord = Record<string, unknown>
const MAX_IMPORT_ITEMS = 10_000
const nowIso = () => new Date().toISOString()
const stringValue = (value: unknown) => typeof value === "string" ? value.trim() : ""
const recordValue = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
const firstString = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = stringValue(record[key])
    if (value) return value
  }
  return ""
}

function parseJson(input: string): unknown {
  try { return JSON.parse(input.replace(/^\uFEFF/, "")) }
  catch { throw new Error("JSON 格式无效，请检查文件内容") }
}

function parseJsonOrSequence(input: string): unknown {
  try { return JSON.parse(input.replace(/^\uFEFF/, "")) }
  catch {
    const lines = input.split(/\r?\n/).map((line) => line.trim().replace(/,$/, "")).filter(Boolean)
    if (lines.length < 2) throw new Error("JSON 格式无效，请检查文件内容")
    try { return lines.map((line) => JSON.parse(line) as unknown) }
    catch { throw new Error("JSON / JSONL 格式无效，请检查文件内容") }
  }
}

function normalizeExpiry(value: string, expiresIn?: number): string | undefined {
  if (value) {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value)
      return String(numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : numeric)
    }
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return String(Math.floor(parsed / 1000))
  }
  return expiresIn && expiresIn > 0 ? String(Math.floor(Date.now() / 1000) + expiresIn) : undefined
}

function poolForSub2Account(account: JsonRecord): PoolType | null {
  const platform = firstString(account, "platform").toLowerCase()
  const credentials = recordValue(account.credentials)
  if (platform === "grok" || platform === "xai") return credentials.refresh_token || credentials.access_token ? "xai-grok" : null
  if (platform === "kimi" || platform === "kimi-code" || platform === "moonshot") return credentials.refresh_token || credentials.access_token ? "kimi-code" : null
  if (platform !== "openai") return null
  // AT token / OAuth / api key all land in the unified openai pool.
  return credentials.access_token || credentials.api_key || credentials.refresh_token ? "openai" : null
}

function seedFromCredential(record: JsonRecord, poolType: PoolType, fallbackLabel: string): ImportSeed {
  const expiresInRaw = record.expires_in
  const expiresIn = typeof expiresInRaw === "number" ? expiresInRaw : Number(expiresInRaw || 0)
  const email = firstString(record, "email")
  return {
    label: firstString(record, "name", "label") || email || fallbackLabel,
    poolType,
    accessToken: firstString(record, "access_token", "accessToken", "token", "api_key"),
    refreshToken: firstString(record, "refresh_token", "refreshToken"),
    clientId: firstString(record, "client_id", "clientId"),
    expiresAt: normalizeExpiry(firstString(record, "expires_at", "expired", "expiresAt"), expiresIn),
    idToken: firstString(record, "id_token", "idToken"),
    tokenType: firstString(record, "token_type", "tokenType"),
    scope: firstString(record, "scope"),
    email,
    subject: firstString(record, "sub", "subject", "user_id", "principal_id"),
    concurrency: typeof record.concurrency === "number" ? record.concurrency : undefined,
  }
}

function parseSub2Api(input: string, selectedPool: PoolType): ImportSeed[] {
  const root = recordValue(parseJson(input))
  if (!Array.isArray(root.accounts)) throw new Error("Sub2API JSON 缺少 accounts 数组")
  const seeds: ImportSeed[] = []
  for (const [index, raw] of root.accounts.entries()) {
    const account = recordValue(raw)
    const poolType = poolForSub2Account(account)
    if (!poolType || poolType !== selectedPool) continue
    const credentials = recordValue(account.credentials)
    const seed = seedFromCredential({ ...credentials, name: firstString(account, "name"), concurrency: account.concurrency }, poolType, `账号 #${index + 1}`)
    if (!seed.accessToken && !seed.refreshToken) continue
    seeds.push(seed)
  }
  if (!seeds.length) throw new Error(`文件中没有可导入到 ${selectedPool} 的账号`)
  return seeds
}

function parseCpaJson(input: string, selectedPool: PoolType): ImportSeed[] {
  if (selectedPool !== "xai-grok") throw new Error("CPA JSON 当前仅用于 xAI Grok 号池")
  const parsed = parseJsonOrSequence(input)
  const root = recordValue(parsed)
  const topLevelValues = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root.accounts)
      ? root.accounts
      : Array.isArray(root.auths)
        ? root.auths
        : [parsed]
  const values = topLevelValues.flatMap((value) => {
    const wrapper = recordValue(value)
    return Array.isArray(wrapper.accounts) ? wrapper.accounts : [value]
  })
  const seeds = values.map((raw, index) => seedFromCredential(recordValue(raw), "xai-grok", `xAI 账号 #${index + 1}`))
    .filter((seed) => seed.accessToken || seed.refreshToken)
  if (!seeds.length) throw new Error("CPA JSON 中没有 access_token 或 refresh_token")
  return seeds
}

export function parseImportInput(poolType: PoolType, format: ImportFormat, input: string): ImportSeed[] {
  if (!input.trim()) throw new Error("导入内容不能为空")
  let seeds: ImportSeed[]
  if (format === "sub2api-json") seeds = parseSub2Api(input, poolType)
  else if (format === "cpa-json") seeds = parseCpaJson(input, poolType)
  else if (format === "access-token") {
    if (poolType !== "openai") throw new Error("Access Token 导入仅支持 OpenAI 号池")
    const values = input.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    seeds = values.map((value, index) => ({
      label: `Access Token #${index + 1}`,
      poolType,
      accessToken: value.replace(/^(access_token|token)\s*[=:]\s*/i, ""),
    }))
  } else {
    if (poolType !== "xai-grok" && poolType !== "kimi-code" && poolType !== "openai") {
      throw new Error("此导入方式仅支持 OpenAI、xAI Grok 或 Kimi Code")
    }
    const values = input.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    seeds = values.map((value, index) => {
      if (format === "xai-sso") {
        if (poolType !== "xai-grok") throw new Error("xAI SSO 仅支持 xAI Grok 号池")
        return { label: `SSO #${index + 1}`, poolType, ssoToken: value }
      }
      return {
        label: `Refresh Token #${index + 1}`,
        poolType,
        refreshToken: value.replace(/^refresh_token\s*[=:]\s*/i, ""),
      }
    })
  }
  if (seeds.length > MAX_IMPORT_ITEMS) throw new Error(`单次最多导入 ${MAX_IMPORT_ITEMS} 个账号`)
  return seeds
}

function publicJob(row: ImportJobRow, db: AppDatabase, withItems = true) {
  const items = withItems ? db.prepare(`SELECT item_index AS itemIndex,label,status,step,account_id AS accountId,account_created AS accountCreated,error,updated_at AS updatedAt
    FROM import_job_items WHERE job_id=? ORDER BY item_index`).all(row.id) : undefined
  const rollbackAccountCount = Number((db.prepare(`SELECT COUNT(DISTINCT account_id) AS value FROM import_job_items
    WHERE job_id=? AND account_created=1 AND account_id IS NOT NULL`).get(row.id) as { value: number }).value)
  return {
    id: row.id,
    poolType: row.pool_type,
    format: row.format,
    status: row.status,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    succeededItems: row.succeeded_items,
    failedItems: row.failed_items,
    currentStep: row.current_step,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    rolledBackAt: row.rolled_back_at,
    rolledBackAccounts: row.rolled_back_accounts,
    rollbackAccountCount,
    updatedAt: row.updated_at,
    ...(withItems ? { items } : {}),
  }
}

export function getImportJob(ownerUserId: string, jobId: string, db: AppDatabase = getDatabase()) {
  const row = db.prepare("SELECT * FROM import_jobs WHERE id=? AND owner_user_id=?").get(jobId, ownerUserId) as ImportJobRow | undefined
  return row ? publicJob(row, db) : null
}

export function listImportJobs(ownerUserId: string, db: AppDatabase = getDatabase(), limit = 10, poolType?: string | null) {
  const safeLimit = Math.max(1, Math.min(limit, 50))
  const rows = poolType && poolType !== "all"
    ? db.prepare("SELECT * FROM import_jobs WHERE owner_user_id=? AND pool_type=? ORDER BY created_at DESC LIMIT ?").all(ownerUserId, poolType, safeLimit) as ImportJobRow[]
    : db.prepare("SELECT * FROM import_jobs WHERE owner_user_id=? ORDER BY created_at DESC LIMIT ?").all(ownerUserId, safeLimit) as ImportJobRow[]
  return rows.map((row) => publicJob(row, db, false))
}

export function createImportJob(ownerUserId: string, poolType: PoolType, format: ImportFormat, input: string, db: AppDatabase = getDatabase()) {
  const seeds = parseImportInput(poolType, format, input)
  const id = randomUUID()
  const timestamp = nowIso()
  const ciphertext = new SecretVault().encrypt(JSON.stringify(seeds))
  db.transaction(() => {
    db.prepare(`INSERT INTO import_jobs(id,owner_user_id,pool_type,format,status,total_items,payload_ciphertext,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, ownerUserId, poolType, format, "QUEUED", seeds.length, ciphertext, timestamp, timestamp)
    const insert = db.prepare(`INSERT INTO import_job_items(id,job_id,item_index,label,status,step,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    seeds.forEach((seed, index) => insert.run(randomUUID(), id, index, seed.label, "QUEUED", "等待处理", timestamp, timestamp))
  })()
  void runImportJob(id, db)
  return getImportJob(ownerUserId, id, db)!
}

function updateItem(db: AppDatabase, jobId: string, index: number, status: string, step: string, accountId?: string | null, error?: string | null, accountCreated = false) {
  const timestamp = nowIso()
  db.prepare("UPDATE import_job_items SET status=?,step=?,account_id=COALESCE(?,account_id),account_created=MAX(account_created,?),error=?,updated_at=? WHERE job_id=? AND item_index=?")
    .run(status, step, accountId ?? null, Number(accountCreated), error ?? null, timestamp, jobId, index)
  const counts = db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('COMPLETED','FAILED') THEN 1 ELSE 0 END) AS processed,
    SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS succeeded,SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed
    FROM import_job_items WHERE job_id=?`).get(jobId) as { total: number; processed: number; succeeded: number; failed: number }
  db.prepare("UPDATE import_jobs SET processed_items=?,succeeded_items=?,failed_items=?,current_step=CASE WHEN status='PAUSED' THEN current_step ELSE ? END,updated_at=? WHERE id=?")
    .run(counts.processed || 0, counts.succeeded || 0, counts.failed || 0, step, timestamp, jobId)
}

function decodeIdentity(seed: ImportSeed): { email: string; subject: string } {
  for (const token of [seed.idToken, seed.accessToken]) {
    if (!token) continue
    const claims = decodeJwtClaims(token)
    if (claims) return { email: seed.email || jwtClaimString(claims, "email"), subject: seed.subject || jwtClaimString(claims, "sub") }
  }
  return { email: seed.email || "", subject: seed.subject || "" }
}

function externalId(seed: ImportSeed, email: string, subject: string): string {
  const identity = subject || email.toLowerCase() || seed.refreshToken || seed.accessToken || randomUUID()
  return createHash("sha256").update(`${seed.poolType}:${identity}`).digest("hex").slice(0, 24)
}

async function importSeed(ownerUserId: string, jobId: string, index: number, initial: ImportSeed, db: AppDatabase): Promise<{ accountId: string; accountCreated: boolean }> {
  const accounts = new AccountRepository(ownerUserId, db)
  const credentials = new ProviderCredentialRepository(ownerUserId, db)
  let seed = { ...initial }
  if (seed.ssoToken) {
    updateItem(db, jobId, index, "RUNNING", "正在兑换 xAI SSO")
    const result = await convertSsoToBuild(seed.ssoToken)
    seed = { ...seed, accessToken: result.accessToken, refreshToken: result.refreshToken, idToken: result.idToken, tokenType: result.tokenType, scope: result.scope, expiresAt: normalizeExpiry("", result.expiresIn) }
  }
  if (!seed.accessToken && seed.refreshToken && seed.poolType === "xai-grok") {
    updateItem(db, jobId, index, "RUNNING", "正在刷新 OAuth 凭据")
    const result = await exchangeXaiRefreshToken(seed.refreshToken, seed.clientId)
    seed = { ...seed, ...result, idToken: result.idToken || seed.idToken }
  }
  if (!seed.accessToken && seed.refreshToken && seed.poolType === "kimi-code") {
    updateItem(db, jobId, index, "RUNNING", "正在刷新 Kimi OAuth 凭据")
    const result = await refreshKimiAccessToken(seed.refreshToken, seed.clientId || KIMI_CODE_CLIENT_ID)
    seed = {
      ...seed,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: String(result.expiresAt),
      tokenType: result.tokenType,
      scope: result.scope,
      clientId: seed.clientId || KIMI_CODE_CLIENT_ID,
    }
  }
  if (!seed.accessToken && seed.refreshToken && seed.poolType === "openai") {
    updateItem(db, jobId, index, "RUNNING", "正在刷新 OpenAI OAuth 凭据")
    const result = await exchangeOpenAIRefreshToken(seed.refreshToken, seed.clientId)
    seed = {
      ...seed,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      clientId: seed.clientId || "app_EMoamEEZ73f0CkXaXp7hrann",
    }
  }
  if (!seed.accessToken) throw new Error("凭据缺少可用的 access_token")

  const identity = decodeIdentity(seed)
  const accountName = identity.email || seed.label
  updateItem(db, jobId, index, "RUNNING", "正在保存加密凭据")
  const { account, created: accountCreated } = accounts.createProviderAccountTracked({
    name: accountName,
    poolType: seed.poolType,
    email: identity.email || null,
    externalId: externalId(seed, identity.email, identity.subject),
  })
  updateItem(db, jobId, index, "RUNNING", "正在保存加密凭据", account.id, undefined, accountCreated)
  const credentialData: Record<string, string> = { token: seed.accessToken }
  if (seed.refreshToken) credentialData.refreshToken = seed.refreshToken
  if (seed.clientId) credentialData.clientId = seed.clientId
  if (seed.expiresAt) credentialData.expiresAt = seed.expiresAt
  if (identity.email) credentialData.email = identity.email
  if (seed.idToken) credentialData.idToken = seed.idToken
  if (seed.tokenType) credentialData.tokenType = seed.tokenType
  if (seed.scope) credentialData.scope = seed.scope
  credentials.upsert({ accountId: account.id, poolType: seed.poolType, credentialData })
  if (seed.concurrency && seed.concurrency > 0) accounts.updateState(account.id, { maxConcurrency: Math.min(64, seed.concurrency) })

  updateItem(db, jobId, index, "RUNNING", seed.poolType === "xai-grok" ? "正在探测真实额度" : "正在验证账号", account.id, undefined, accountCreated)
  // Account + credentials are already persisted. Post-import probe/validation is
  // best-effort: bulk xAI SSO imports can hit temporary 403/rate-limit noise on
  // the probe endpoint even when the OAuth tokens are valid for later inference.
  try {
    if (seed.poolType === "xai-grok") {
      const { syncProviderAccount } = await import("./provider-sync")
      await syncProviderAccount(ownerUserId, account.id, db)
    } else {
      const provider = tryGetProvider(seed.poolType)
      const latest = accounts.get(account.id)
      if (provider && latest) {
        const validation = await provider.validateCredential(latest)
        if (!validation.valid) throw new Error("上游未接受该账号凭据")
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "导入后探测失败"
    // Keep the account usable; surface the probe error without failing the job item.
    accounts.updateState(account.id, {
      adminState: "ENABLED",
      authState: "VALID",
      disabledReason: null,
      disabledAt: null,
      lastError: message.slice(0, 500),
    })
    updateItem(db, jobId, index, "RUNNING", `账号已保存，探测失败：${message.slice(0, 80)}`, account.id, undefined, accountCreated)
  }
  // Newly imported ready account: refresh that provider's model catalog.
  try {
    const { syncProviderModelsForAccount } = await import("./provider-models")
    await syncProviderModelsForAccount(ownerUserId, account.id, db)
  } catch {
    // Model catalog refresh is best-effort and must not fail the import.
  }
  return { accountId: account.id, accountCreated }
}

const runnerGlobal = globalThis as typeof globalThis & { __accountImportJobs?: Set<string> }
const activeJobs = (runnerGlobal.__accountImportJobs ??= new Set<string>())

export interface ImportRunnerOptions {
  processItem?: (ownerUserId: string, jobId: string, index: number, seed: ImportSeed, db: AppDatabase) => Promise<string | { accountId: string; accountCreated: boolean }>
}

export async function runImportJob(jobId: string, db: AppDatabase = getDatabase(), options: ImportRunnerOptions = {}): Promise<void> {
  if (activeJobs.has(jobId)) return
  const claimed = db.prepare("UPDATE import_jobs SET status='RUNNING',started_at=COALESCE(started_at,?),current_step='正在准备导入',updated_at=? WHERE id=? AND status='QUEUED'")
    .run(nowIso(), nowIso(), jobId).changes
  if (!claimed) return
  activeJobs.add(jobId)
  try {
    const job = db.prepare("SELECT * FROM import_jobs WHERE id=?").get(jobId) as ImportJobRow
    const seeds = JSON.parse(new SecretVault().decrypt(job.payload_ciphertext)) as ImportSeed[]
    const terminalItems = new Set((db.prepare("SELECT item_index FROM import_job_items WHERE job_id=? AND status IN ('COMPLETED','FAILED')").all(jobId) as { item_index: number }[]).map((item) => item.item_index))
    let cursor = 0
    const workers = Array.from({ length: Math.min(3, seeds.length) }, async () => {
      for (;;) {
        const state = db.prepare("SELECT status FROM import_jobs WHERE id=?").get(jobId) as { status: ImportJobStatus } | undefined
        if (state?.status !== "RUNNING") return
        const index = cursor++
        if (index >= seeds.length) return
        if (terminalItems.has(index)) continue
        try {
          updateItem(db, jobId, index, "RUNNING", "正在读取账号凭据")
          const imported = await (options.processItem ?? importSeed)(job.owner_user_id, jobId, index, seeds[index], db)
          const accountId = typeof imported === "string" ? imported : imported.accountId
          const accountCreated = typeof imported === "string" ? true : imported.accountCreated
          updateItem(db, jobId, index, "COMPLETED", "导入完成", accountId, undefined, accountCreated)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "导入失败"
          updateItem(db, jobId, index, "FAILED", "导入失败", null, message)
        }
      }
    })
    await Promise.all(workers)
    const latest = db.prepare("SELECT status,succeeded_items,failed_items FROM import_jobs WHERE id=?").get(jobId) as { status: ImportJobStatus; succeeded_items: number; failed_items: number }
    if (latest.status === "RUNNING") {
      const timestamp = nowIso()
      db.prepare("UPDATE import_jobs SET status='COMPLETED',current_step=?,completed_at=?,updated_at=? WHERE id=?")
        .run(latest.failed_items ? "导入完成，部分账号失败" : "全部导入完成", timestamp, timestamp, jobId)
    }
  } catch (cause) {
    const timestamp = nowIso()
    db.prepare("UPDATE import_jobs SET status='FAILED',error=?,current_step='任务异常终止',completed_at=?,updated_at=? WHERE id=?")
      .run(cause instanceof Error ? cause.message : "导入任务失败", timestamp, timestamp, jobId)
  } finally {
    activeJobs.delete(jobId)
    const latest = db.prepare("SELECT status FROM import_jobs WHERE id=?").get(jobId) as { status: ImportJobStatus } | undefined
    if (latest?.status === "QUEUED") void runImportJob(jobId, db, options)
  }
}


function recomputeJobProgress(db: AppDatabase, jobId: string, currentStep: string) {
  const timestamp = nowIso()
  const counts = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status IN ('COMPLETED','FAILED') THEN 1 ELSE 0 END) AS processed,
    SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS succeeded,
    SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed
    FROM import_job_items WHERE job_id=?`).get(jobId) as { total: number; processed: number; succeeded: number; failed: number }
  const allDone = Number(counts.processed || 0) >= Number(counts.total || 0) && Number(counts.total || 0) > 0
  if (allDone) {
    db.prepare("UPDATE import_jobs SET processed_items=?,succeeded_items=?,failed_items=?,status='COMPLETED',current_step=?,completed_at=COALESCE(completed_at,?),updated_at=?,error=NULL WHERE id=?")
      .run(counts.processed || 0, counts.succeeded || 0, counts.failed || 0, counts.failed ? "导入完成，部分账号失败" : "全部导入完成", timestamp, timestamp, jobId)
  } else {
    db.prepare("UPDATE import_jobs SET processed_items=?,succeeded_items=?,failed_items=?,status='RUNNING',current_step=?,completed_at=NULL,updated_at=?,error=NULL WHERE id=?")
      .run(counts.processed || 0, counts.succeeded || 0, counts.failed || 0, currentStep, timestamp, jobId)
  }
}

async function runSingleImportItem(jobId: string, itemIndex: number, seed: ImportSeed, db: AppDatabase = getDatabase()) {
  try {
    const job = db.prepare("SELECT owner_user_id FROM import_jobs WHERE id=?").get(jobId) as { owner_user_id: string } | undefined
    if (!job) return
    try {
      updateItem(db, jobId, itemIndex, "RUNNING", "正在重试导入")
      const imported = await importSeed(job.owner_user_id, jobId, itemIndex, seed, db)
      updateItem(db, jobId, itemIndex, "COMPLETED", "导入完成", imported.accountId, undefined, imported.accountCreated)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "导入失败"
      updateItem(db, jobId, itemIndex, "FAILED", "导入失败", null, message)
    } finally {
      recomputeJobProgress(db, jobId, "重试完成")
    }
  } catch {
    // DB may be closed in tests after the request returns.
  }
}

export function retryImportJobItem(ownerUserId: string, jobId: string, itemIndex: number, db: AppDatabase = getDatabase()) {
  const job = db.prepare("SELECT * FROM import_jobs WHERE id=? AND owner_user_id=?").get(jobId, ownerUserId) as ImportJobRow | undefined
  if (!job) throw new Error("导入任务不存在")
  if (job.rolled_back_at) throw new Error("该导入任务已撤销，不能再重试")
  const item = db.prepare("SELECT item_index,status FROM import_job_items WHERE job_id=? AND item_index=?").get(jobId, itemIndex) as { item_index: number; status: string } | undefined
  if (!item) throw new Error("导入项不存在")
  if (item.status !== "FAILED") throw new Error("仅支持重试失败的导入项")

  let seeds: ImportSeed[] = []
  try {
    seeds = JSON.parse(new SecretVault().decrypt(job.payload_ciphertext)) as ImportSeed[]
  } catch {
    throw new Error("原始导入凭据已不可用，无法重试")
  }
  const seed = seeds[itemIndex]
  if (!seed) throw new Error("找不到该导入项的原始凭据")

  const timestamp = nowIso()
  db.prepare("UPDATE import_job_items SET status='QUEUED',step=?,error=NULL,account_id=NULL,updated_at=? WHERE job_id=? AND item_index=?")
    .run("等待重试", timestamp, jobId, itemIndex)
  recomputeJobProgress(db, jobId, "等待重试失败项")

  // Prefer single-item retry so completed jobs and partially finished jobs both work.
  void runSingleImportItem(jobId, itemIndex, seed, db)
  return getImportJob(ownerUserId, jobId, db)!
}

export function pauseImportJob(ownerUserId: string, jobId: string, db: AppDatabase = getDatabase()) {
  const timestamp = nowIso()
  const changed = db.prepare(`UPDATE import_jobs SET status='PAUSED',current_step='暂停中，等待当前处理项完成',updated_at=?
    WHERE id=? AND owner_user_id=? AND status IN ('QUEUED','RUNNING') AND rolled_back_at IS NULL`).run(timestamp, jobId, ownerUserId).changes
  if (!changed) {
    const job = db.prepare("SELECT status FROM import_jobs WHERE id=? AND owner_user_id=?").get(jobId, ownerUserId) as { status: ImportJobStatus } | undefined
    if (!job) throw new Error("导入任务不存在")
    if (job.status === "PAUSED") throw new Error("导入任务已经暂停")
    throw new Error("仅支持暂停排队中或运行中的导入任务")
  }
  return getImportJob(ownerUserId, jobId, db)!
}

export function resumeImportJob(ownerUserId: string, jobId: string, db: AppDatabase = getDatabase(), options: ImportRunnerOptions = {}) {
  const timestamp = nowIso()
  const changed = db.prepare(`UPDATE import_jobs SET status='QUEUED',current_step='等待继续导入',updated_at=?
    WHERE id=? AND owner_user_id=? AND status='PAUSED' AND rolled_back_at IS NULL`).run(timestamp, jobId, ownerUserId).changes
  if (!changed) {
    const job = db.prepare("SELECT status FROM import_jobs WHERE id=? AND owner_user_id=?").get(jobId, ownerUserId) as { status: ImportJobStatus } | undefined
    if (!job) throw new Error("导入任务不存在")
    throw new Error("仅支持继续已暂停的导入任务")
  }
  void runImportJob(jobId, db, options)
  return getImportJob(ownerUserId, jobId, db)!
}

export interface RollbackImportJobResult {
  job: NonNullable<ReturnType<typeof getImportJob>>
  deleted: number
  skippedReused: number
  missing: number
}

export function rollbackImportJob(ownerUserId: string, jobId: string, db: AppDatabase = getDatabase()): RollbackImportJobResult {
  const job = db.prepare("SELECT * FROM import_jobs WHERE id=? AND owner_user_id=?").get(jobId, ownerUserId) as ImportJobRow | undefined
  if (!job) throw new Error("导入任务不存在")
  if (job.status === "QUEUED" || job.status === "RUNNING") throw new Error("导入任务仍在运行，暂时不能撤销")
  if (job.rolled_back_at) throw new Error("该导入任务已经撤销")

  const candidates = db.prepare(`SELECT DISTINCT i.account_id AS accountId
    FROM import_job_items i
    JOIN accounts a ON a.id=i.account_id AND a.owner_user_id=?
    WHERE i.job_id=? AND i.account_created=1 AND i.account_id IS NOT NULL`).all(ownerUserId, jobId) as { accountId: string }[]
  const accounts = new AccountRepository(ownerUserId, db)
  const result = { deleted: 0, skippedReused: 0, missing: 0 }

  db.transaction(() => {
    for (const candidate of candidates) {
      const laterReference = db.prepare(`SELECT 1
        FROM import_job_items i
        JOIN import_jobs j ON j.id=i.job_id
        WHERE i.account_id=? AND i.job_id<>? AND i.status='COMPLETED'
          AND j.owner_user_id=? AND j.created_at>? AND j.rolled_back_at IS NULL
        LIMIT 1`).get(candidate.accountId, jobId, ownerUserId, job.created_at)
      if (laterReference) {
        result.skippedReused += 1
      } else if (accounts.delete(candidate.accountId)) {
        result.deleted += 1
      } else {
        result.missing += 1
      }
    }

    const timestamp = nowIso()
    db.prepare(`UPDATE import_job_items
      SET step=CASE WHEN account_created=1 THEN '已撤销导入' ELSE step END,updated_at=?
      WHERE job_id=?`).run(timestamp, jobId)
    db.prepare(`UPDATE import_jobs SET rolled_back_at=?,rolled_back_accounts=?,current_step=?,updated_at=?
      WHERE id=? AND owner_user_id=?`).run(
        timestamp,
        result.deleted,
        result.skippedReused ? `已撤销，删除 ${result.deleted} 个账号，保留 ${result.skippedReused} 个后续复用账号` : `已撤销，删除 ${result.deleted} 个账号`,
        timestamp,
        jobId,
        ownerUserId,
      )
  }).immediate()

  return { job: getImportJob(ownerUserId, jobId, db)!, ...result }
}

export function startImportJobRunner(db: AppDatabase = getDatabase(), options: ImportRunnerOptions = {}): void {
  db.transaction(() => {
    db.prepare(`UPDATE import_job_items SET status='QUEUED',step='任务已暂停，等待继续',updated_at=?
      WHERE status='RUNNING' AND EXISTS (SELECT 1 FROM import_jobs j WHERE j.id=import_job_items.job_id AND j.status='PAUSED')`).run(nowIso())
    db.prepare("UPDATE import_jobs SET status='QUEUED',current_step='服务重启，等待恢复',updated_at=? WHERE status='RUNNING'").run(nowIso())
    db.prepare("UPDATE import_job_items SET status='QUEUED',step='等待恢复',updated_at=? WHERE status='RUNNING'").run(nowIso())
  })()
  const jobs = db.prepare("SELECT id FROM import_jobs WHERE status='QUEUED' ORDER BY created_at").all() as { id: string }[]
  for (const job of jobs) void runImportJob(job.id, db, options)
}
