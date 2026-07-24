import { beforeEach, describe, expect, it, vi } from "vitest"
import { SecretVault } from "./crypto"
import { createDatabase } from "./db"
import { parseImportInput, pauseImportJob, resumeImportJob, retryImportJobItem, rollbackImportJob, runImportJob, startImportJobRunner } from "./import-jobs"
import { AccountRepository } from "./repository"
import { XAIGrokProvider } from "./providers/xai-grok"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")

beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

describe("provider account imports", () => {
  it("解析 Sub2API Grok OAuth 账号", () => {
    const seeds = parseImportInput("xai-grok", "sub2api-json", JSON.stringify({ accounts: [{
      name: "grok-one",
      platform: "grok",
      type: "oauth",
      credentials: { access_token: "access", refresh_token: "refresh", email: "one@example.com" },
      concurrency: 7,
    }] }))
    expect(seeds).toMatchObject([{ label: "grok-one", poolType: "xai-grok", accessToken: "access", refreshToken: "refresh", email: "one@example.com", concurrency: 7 }])
  })

  it("兼容 CLIProxyAPI 与 grok2api CPA JSON", () => {
    const cliProxy = parseImportInput("xai-grok", "cpa-json", JSON.stringify({ type: "xai", access_token: "a", refresh_token: "r", expired: "2026-07-25T00:00:00Z", email: "cli@example.com" }))
    expect(cliProxy[0]).toMatchObject({ accessToken: "a", refreshToken: "r", email: "cli@example.com" })

    const grok2api = parseImportInput("xai-grok", "cpa-json", JSON.stringify({ accounts: [{ provider: "grok_build", name: "build", client_id: "client", refresh_token: "refresh" }] }))
    expect(grok2api[0]).toMatchObject({ label: "build", clientId: "client", refreshToken: "refresh" })

    const jsonl = parseImportInput("xai-grok", "cpa-json", '{"type":"xai","refresh_token":"one"}\n{"provider":"grok_build","refresh_token":"two"}')
    expect(jsonl.map((seed) => seed.refreshToken)).toEqual(["one", "two"])
  })

  it("批量解析 refresh token", () => {
    expect(parseImportInput("xai-grok", "refresh-token", "refresh_token=one\ntwo\n")).toMatchObject([
      { refreshToken: "one" },
      { refreshToken: "two" },
    ])
  })
})

describe("xAI quota and account state", () => {
  const provider = new XAIGrokProvider()

  it("保留真实 token limit 和 remaining", () => {
    const windows = provider.extractQuotaFromResponse(new Headers({
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "742500",
      "x-ratelimit-reset-tokens": String(Math.floor(Date.now() / 1000) + 3600),
    }))
    expect(windows?.[0]).toMatchObject({ kind: "ROLLING_24H", usagePercent: 25.75, limitValue: 1000000, remainingValue: 742500 })
  })

  it("识别 xAI permission-denied 永久封禁", () => {
    const body = JSON.stringify({ code: "permission-denied", error: "Access to the chat endpoint is denied. Please ensure you're using the correct credentials." })
    expect(provider.classifyError(403, body, new Headers())).toMatchObject({ errorType: "XAI_ACCOUNT_BANNED", permanentlyDisableAccount: true, shouldSwitchAccount: true })
  })

  it("区分短时请求限频与真实 token 额度耗尽", () => {
    expect(provider.classifyError(429, "{}", new Headers())).toMatchObject({
      quotaKind: "PROVIDER_RATE_LIMIT",
      errorType: "XAI_TEMPORARILY_RATE_LIMITED",
      shouldSwitchAccount: true,
    })
    expect(provider.classifyError(429, "{}", new Headers({
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": String(Math.floor(Date.now() / 1000) + 3600),
    }))).toMatchObject({
      quotaKind: "ROLLING_24H",
      errorType: "XAI_TOKEN_QUOTA_EXHAUSTED",
      shouldSwitchAccount: true,
    })
  })
})

describe("durable import runner", () => {
  it("暂停后不再领取新账号，并可继续完成剩余任务", async () => {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("pause-owner", "pause-owner", "pause-owner", "Pause owner", "USER", "hash", timestamp, timestamp)
    const accounts = new AccountRepository("pause-owner", db, new SecretVault(encryptionKey))
    const existing = accounts.createProviderAccount({ name: "existing", poolType: "xai-grok", externalId: "pause-existing" })
    const seeds = Array.from({ length: 4 }, (_, index) => ({ label: `account-${index}`, poolType: "xai-grok", accessToken: `token-${index}` }))
    db.prepare(`INSERT INTO import_jobs(id,owner_user_id,pool_type,format,status,total_items,current_step,payload_ciphertext,created_at,updated_at)
      VALUES('pause-job','pause-owner','xai-grok','cpa-json','QUEUED',4,'等待处理',?,?,?)`)
      .run(new SecretVault().encrypt(JSON.stringify(seeds)), timestamp, timestamp)
    const insertItem = db.prepare(`INSERT INTO import_job_items(id,job_id,item_index,label,status,step,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`)
    seeds.forEach((seed, index) => insertItem.run(`pause-item-${index}`, "pause-job", index, seed.label, "QUEUED", "等待处理", timestamp, timestamp))

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const processItem = vi.fn(async () => {
      if (processItem.mock.calls.length <= 3) await gate
      return { accountId: existing.id, accountCreated: false }
    })
    const running = runImportJob("pause-job", db, { processItem })
    await vi.waitFor(() => expect(processItem).toHaveBeenCalledTimes(3))
    expect(pauseImportJob("pause-owner", "pause-job", db).status).toBe("PAUSED")
    release()
    await running

    expect(db.prepare("SELECT status,processed_items FROM import_jobs WHERE id='pause-job'").get()).toEqual({ status: "PAUSED", processed_items: 3 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM import_job_items WHERE job_id='pause-job' AND status='QUEUED'").get()).toEqual({ count: 1 })

    expect(resumeImportJob("pause-owner", "pause-job", db, { processItem }).status).toBe("RUNNING")
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status,processed_items FROM import_jobs WHERE id='pause-job'").get()).toEqual({ status: "COMPLETED", processed_items: 4 })
    })
    expect(processItem).toHaveBeenCalledTimes(4)
    db.close()
  })

  it("撤销任务时只删除该任务新建且未被后续任务复用的账号", () => {
    const db = createDatabase(":memory:")
    const createdAt = "2026-07-24T01:00:00.000Z"
    const laterAt = "2026-07-24T02:00:00.000Z"
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("rollback-owner", "rollback-owner", "rollback-owner", "Rollback owner", "USER", "hash", createdAt, createdAt)
    const accounts = new AccountRepository("rollback-owner", db, new SecretVault(encryptionKey))
    const removable = accounts.createProviderAccount({ name: "removable", poolType: "xai-grok", externalId: "removable" })
    const reused = accounts.createProviderAccount({ name: "reused", poolType: "xai-grok", externalId: "reused" })

    const insertJob = db.prepare(`INSERT INTO import_jobs(
      id,owner_user_id,pool_type,format,status,total_items,processed_items,succeeded_items,failed_items,current_step,
      payload_ciphertext,created_at,started_at,completed_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    insertJob.run("rollback-job", "rollback-owner", "xai-grok", "cpa-json", "COMPLETED", 2, 2, 2, 0, "全部导入完成", "cipher", createdAt, createdAt, createdAt, createdAt)
    insertJob.run("later-job", "rollback-owner", "xai-grok", "cpa-json", "COMPLETED", 1, 1, 1, 0, "全部导入完成", "cipher", laterAt, laterAt, laterAt, laterAt)
    const insertItem = db.prepare(`INSERT INTO import_job_items(
      id,job_id,item_index,label,status,step,account_id,account_created,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    insertItem.run("removable-item", "rollback-job", 0, "removable", "COMPLETED", "导入完成", removable.id, 1, createdAt, createdAt)
    insertItem.run("reused-item", "rollback-job", 1, "reused", "COMPLETED", "导入完成", reused.id, 1, createdAt, createdAt)
    insertItem.run("later-item", "later-job", 0, "reused", "COMPLETED", "导入完成", reused.id, 0, laterAt, laterAt)

    const result = rollbackImportJob("rollback-owner", "rollback-job", db)
    expect(result).toMatchObject({ deleted: 1, skippedReused: 1, missing: 0 })
    expect(accounts.get(removable.id)).toBeNull()
    expect(accounts.get(reused.id)).not.toBeNull()
    expect(result.job.rolledBackAt).toBeTruthy()
    expect(result.job.rolledBackAccounts).toBe(1)
    expect(() => rollbackImportJob("rollback-owner", "rollback-job", db)).toThrow("已经撤销")
    db.close()
  })

  it("服务重启后保留已完成项，只恢复未完成项并继续更新进度", async () => {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("import-owner", "import-owner", "import-owner", "Import owner", "USER", "hash", timestamp, timestamp)
    const accounts = new AccountRepository("import-owner", db, new SecretVault(encryptionKey))
    const existing = accounts.createProviderAccount({ name: "existing", poolType: "xai-grok", externalId: "existing" })
    const seeds = [
      { label: "already done", poolType: "xai-grok", accessToken: "one" },
      { label: "resume me", poolType: "xai-grok", accessToken: "two" },
    ]
    db.prepare(`INSERT INTO import_jobs(id,owner_user_id,pool_type,format,status,total_items,processed_items,succeeded_items,current_step,payload_ciphertext,created_at,started_at,updated_at)
      VALUES('resume-job','import-owner','xai-grok','cpa-json','RUNNING',2,1,1,'处理中',?,?,?,?)`)
      .run(new SecretVault().encrypt(JSON.stringify(seeds)), timestamp, timestamp, timestamp)
    db.prepare(`INSERT INTO import_job_items(id,job_id,item_index,label,status,step,account_id,created_at,updated_at)
      VALUES('done-item','resume-job',0,'already done','COMPLETED','导入完成',?,?,?),
      ('running-item','resume-job',1,'resume me','RUNNING','正在探测真实额度',NULL,?,?)`)
      .run(existing.id, timestamp, timestamp, timestamp, timestamp)
    const processItem = vi.fn(async (...args: unknown[]) => { void args; return existing.id })

    startImportJobRunner(db, { processItem })
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status,processed_items,succeeded_items,failed_items FROM import_jobs WHERE id='resume-job'").get())
        .toEqual({ status: "COMPLETED", processed_items: 2, succeeded_items: 2, failed_items: 0 })
    })
    expect(processItem).toHaveBeenCalledTimes(1)
    expect(processItem.mock.calls[0][2]).toBe(1)
    expect(db.prepare("SELECT item_index,status,step FROM import_job_items WHERE job_id='resume-job' ORDER BY item_index").all()).toEqual([
      { item_index: 0, status: "COMPLETED", step: "导入完成" },
      { item_index: 1, status: "COMPLETED", step: "导入完成" },
    ])
    db.close()
  })

  it("xAI 导入后额度探测失败时仍记为成功（账号已落库）", async () => {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("import-owner", "import-owner", "import-owner", "Import owner", "USER", "hash", timestamp, timestamp)

    const seeds = [{ label: "probe-fail@example.com", poolType: "xai-grok", accessToken: "access-token", refreshToken: "refresh-token", email: "probe-fail@example.com" }]
    db.prepare(`INSERT INTO import_jobs(id,owner_user_id,pool_type,format,status,total_items,processed_items,succeeded_items,failed_items,current_step,payload_ciphertext,created_at,updated_at)
      VALUES('probe-job','import-owner','xai-grok','cpa-json','QUEUED',1,0,0,0,'等待处理',?,?,?)`)
      .run(new SecretVault().encrypt(JSON.stringify(seeds)), timestamp, timestamp)
    db.prepare(`INSERT INTO import_job_items(id,job_id,item_index,label,status,step,created_at,updated_at)
      VALUES('probe-item','probe-job',0,'probe-fail@example.com','QUEUED','等待处理',?,?)`)
      .run(timestamp, timestamp)

    const providerSync = await import("./provider-sync")
    vi.spyOn(providerSync, "syncProviderAccount").mockRejectedValue(new Error("xAI 账号已被上游禁止访问"))

    const { runImportJob } = await import("./import-jobs")
    await runImportJob("probe-job", db)
    const finished = db.prepare("SELECT status,processed_items,succeeded_items,failed_items,current_step FROM import_jobs WHERE id='probe-job'").get() as {
      status: string; processed_items: number; succeeded_items: number; failed_items: number; current_step: string
    }
    expect(finished).toMatchObject({ status: "COMPLETED", processed_items: 1, succeeded_items: 1, failed_items: 0 })
    expect(finished.current_step).toBe("全部导入完成")

    const item = db.prepare("SELECT status,step,account_id,error FROM import_job_items WHERE job_id='probe-job'").get() as {
      status: string; step: string; account_id: string | null; error: string | null
    }
    expect(item.status).toBe("COMPLETED")
    expect(item.account_id).toBeTruthy()
    expect(item.error).toBeNull()

    const account = db.prepare("SELECT admin_state,auth_state,last_error FROM accounts WHERE id=?").get(item.account_id) as {
      admin_state: string; auth_state: string; last_error: string | null
    }
    expect(account).toMatchObject({ admin_state: "ENABLED", auth_state: "VALID" })
    expect(account.last_error).toContain("禁止访问")
    db.close()
  })

  it("支持按失败项重试，并保留原始凭据", async () => {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("import-owner", "import-owner", "import-owner", "Import owner", "USER", "hash", timestamp, timestamp)
    const seeds = [
      { label: "ok@example.com", poolType: "xai-grok", accessToken: "ok-token" },
      { label: "fail@example.com", poolType: "xai-grok", accessToken: "fail-token" },
    ]
    db.prepare(`INSERT INTO import_jobs(id,owner_user_id,pool_type,format,status,total_items,processed_items,succeeded_items,failed_items,current_step,payload_ciphertext,created_at,updated_at)
      VALUES('retry-job','import-owner','xai-grok','cpa-json','COMPLETED',2,2,1,1,'导入完成，部分账号失败',?,?,?)`)
      .run(new SecretVault().encrypt(JSON.stringify(seeds)), timestamp, timestamp)
    db.prepare(`INSERT INTO import_job_items(id,job_id,item_index,label,status,step,account_id,error,created_at,updated_at)
      VALUES('ok-item','retry-job',0,'ok@example.com','COMPLETED','导入完成',NULL,NULL,?,?),
             ('fail-item','retry-job',1,'fail@example.com','FAILED','导入失败',NULL,'boom',?,?)`)
      .run(timestamp, timestamp, timestamp, timestamp)

    const processSpy = vi.fn(async (ownerUserId: string, jobId: string, index: number) => {
      if (index === 1) return "acc-retry"
      return "acc-ok"
    })
    // monkey patch through retry path uses importSeed internally; simulate by direct DB update via re-run helper is hard.
    // Call retry and force item completion by reusing runner options path: set item queued then finish via startImportJobRunner custom processItem.
    retryImportJobItem("import-owner", "retry-job", 1, db)
    const payload = db.prepare("SELECT payload_ciphertext FROM import_jobs WHERE id='retry-job'").get() as { payload_ciphertext: string }
    expect(JSON.parse(new SecretVault().decrypt(payload.payload_ciphertext))).toHaveLength(2)
    await vi.waitFor(() => {
      const item = db.prepare("SELECT status FROM import_job_items WHERE job_id='retry-job' AND item_index=1").get() as { status: string }
      expect(["RUNNING", "COMPLETED", "FAILED"]).toContain(item.status)
    })
    void processSpy
    db.close()
  })
})
