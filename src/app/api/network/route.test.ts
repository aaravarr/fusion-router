import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppDatabase } from "@/server/db"

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ id: "user-b" })),
  db: null as unknown as AppDatabase,
}))

vi.mock("../admin/_auth", () => ({ requireSession: mocks.requireSession }))
vi.mock("@/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/server/db")>("@/server/db")
  return { ...actual, getDatabase: () => mocks.db }
})

import { createDatabase } from "@/server/db"
import { invalidateMirrorCacheForOwner } from "@/server/api-fetch"
import { GET, PUT } from "./route"

function insertUser(db: AppDatabase, id: string, role: string) {
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, id, id, id, role, "ACTIVE", "h", new Date().toISOString(), new Date().toISOString())
}
function insertAccount(db: AppDatabase, id: string, owner: string, poolType: string) {
  const now = new Date().toISOString()
  db.prepare("INSERT INTO accounts(id,owner_user_id,name,pool_type,workspace_id,go_key_id,credential_source,last_synced_at,auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,billing_guard,next_usage_check_at,ordinal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, owner, id, poolType, "ws_" + id, "k", "PROVIDER_IMPORT", now, "x", "y", "ACTIVE", "VERIFIED_GO_ONLY", now, 0, now, now)
}

const group = (id: string, accountIds: string[] = []) => ({
  id, name: id, enabled: true, domains: ["api.example.com"], accountIds,
  mirrors: [{ id: "m", name: "M", url: "https://mirror.example.com/$host", enabled: true }],
  rules: [],
})

describe("/api/network", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockReturnValue({ id: "user-b" })
    mocks.db = createDatabase(":memory:")
    insertUser(mocks.db, "user-b", "USER")
    insertUser(mocks.db, "admin-1", "ADMIN")
    insertAccount(mocks.db, "acc-b", "user-b", "opencode-go")
    insertAccount(mocks.db, "acc-admin", "admin-1", "opencode-go")
    invalidateMirrorCacheForOwner("user-b")
  })

  function put(body: unknown): Request {
    return new Request("http://x/api/network", { method: "PUT", body: JSON.stringify(body) })
  }

  it("GET 只返回自己的组与账号", async () => {
    // 给 admin 也建一个组，验证隔离
    const now = new Date().toISOString()
    mocks.db.prepare("INSERT INTO user_mirror_groups(id,owner_user_id,name,enabled,domains_json,account_ids_json,mirrors_json,rules_json,request_rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("g-admin", "admin-1", "g-admin", 1, JSON.stringify(["api.example.com"]), JSON.stringify([]), JSON.stringify([{ id: "m", name: "M", url: "https://admin.example.com", enabled: true }]), JSON.stringify([]), null, now, now)

    const response = await GET(new Request("http://x/api/network"))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { groups: Array<{ id: string }>; accounts: Array<{ id: string }> }
    expect(payload.groups.map((g) => g.id)).toEqual([])
    expect(payload.accounts.map((a) => a.id)).toEqual(["acc-b"])
  })

  it("PUT 全量替换并即时生效", async () => {
    const response = await PUT(put({ groups: [group("g1", ["acc-b"])] }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { groups: Array<{ id: string; accountIds: string[] }> }
    expect(payload.groups.map((g) => g.id)).toEqual(["g1"])

    const get = await GET(new Request("http://x/api/network"))
    const getPayload = (await get.json()) as { groups: Array<{ id: string }> }
    expect(getPayload.groups.map((g) => g.id)).toEqual(["g1"])
  })

  it("accountIds 越权引用非本人账号返回 422", async () => {
    const response = await PUT(put({ groups: [group("g1", ["acc-admin"])] }))
    expect(response.status).toBe(422)
  })

  it("非法正则返回 400", async () => {
    const bad = { ...group("g1", []), rules: [{ id: "r", pattern: "(", mirrorId: "m", enabled: true }] }
    const response = await PUT(put({ groups: [bad] }))
    expect(response.status).toBe(400)
  })
})
