import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { ensureMasterKey, getDatabasePath } from "./bootstrap"
import { initializeSystemSettings } from "./settings"

export type AppDatabase = Database.Database

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN', 'USER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
  password_hash TEXT NOT NULL,
  github_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS bootstrap_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  client_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_lookup_idx ON auth_rate_limits(scope, client_key_hash, created_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pool_type TEXT NOT NULL DEFAULT 'opencode-go',
  workspace_id TEXT NOT NULL UNIQUE,
  email TEXT,
  admin_state TEXT NOT NULL DEFAULT 'ENABLED',
  auth_state TEXT NOT NULL DEFAULT 'VALID',
  subscription_state TEXT NOT NULL DEFAULT 'INACTIVE',
  go_subscription_id TEXT,
  is_zen_subscribed INTEGER NOT NULL DEFAULT 0,
  zen_subscription_id TEXT,
  has_manage_subscription_button INTEGER NOT NULL DEFAULT 0,
  billing_guard TEXT NOT NULL DEFAULT 'UNVERIFIED',
  use_balance INTEGER,
  go_key_id TEXT NOT NULL,
  credential_source TEXT NOT NULL DEFAULT 'BROWSER_EXTENSION',
  extension_version TEXT,
  last_synced_at TEXT NOT NULL,
  auth_cookie_ciphertext TEXT NOT NULL,
  go_api_key_ciphertext TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  last_usage_check_at TEXT,
  next_usage_check_at TEXT NOT NULL,
  last_selected_at TEXT,
  last_request_at TEXT,
  last_success_at TEXT,
  last_limit_at TEXT,
  disabled_reason TEXT,
  disabled_at TEXT,
  last_error TEXT,
  external_id TEXT,
  max_concurrency INTEGER NOT NULL DEFAULT 4,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_owner_idx ON accounts(owner_user_id, ordinal, created_at);
CREATE INDEX IF NOT EXISTS accounts_usage_idx ON accounts(next_usage_check_at, admin_state, auth_state);

CREATE TABLE IF NOT EXISTS quota_windows (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  usage_percent REAL NOT NULL,
  reset_at TEXT,
  source TEXT NOT NULL DEFAULT 'DASHBOARD',
  limit_value INTEGER,
  remaining_value INTEGER,
  unit TEXT,
  observation_version INTEGER NOT NULL DEFAULT 1,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, account_id, kind)
);

CREATE TABLE IF NOT EXISTS routing_state (
  owner_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  current_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  cursor_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_leases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_leases_active_idx ON route_leases(owner_user_id, account_id, expires_at, completed_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_models_json TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS gateway_requests (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  model TEXT,
  status INTEGER,
  outcome TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS gateway_requests_owner_idx ON gateway_requests(owner_user_id, started_at);
CREATE INDEX IF NOT EXISTS gateway_requests_time_idx ON gateway_requests(owner_user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS gateway_attempts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES gateway_requests(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL,
  status INTEGER,
  decision TEXT,
  error_type TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS gateway_attempts_request_idx ON gateway_attempts(request_id);

CREATE TABLE IF NOT EXISTS request_bodies (
  request_id TEXT PRIMARY KEY REFERENCES gateway_requests(id) ON DELETE CASCADE,
  request_body_json TEXT,
  response_body_json TEXT,
  request_headers_json TEXT,
  request_truncated INTEGER NOT NULL DEFAULT 0,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  has_request INTEGER NOT NULL DEFAULT 0,
  has_response INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  request_id TEXT REFERENCES gateway_requests(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_owner_created_idx ON events(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pool_preferences (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pool_type TEXT NOT NULL,
  preferred_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, pool_type)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pool_type TEXT NOT NULL,
  credential_data_ciphertext TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id)
);
CREATE INDEX IF NOT EXISTS provider_credentials_owner_idx ON provider_credentials(owner_user_id);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pool_type TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  total_items INTEGER NOT NULL DEFAULT 0,
  processed_items INTEGER NOT NULL DEFAULT 0,
  succeeded_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  error TEXT,
  payload_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  rolled_back_at TEXT,
  rolled_back_accounts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS import_jobs_owner_created_idx ON import_jobs(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  account_created INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, item_index)
);
CREATE INDEX IF NOT EXISTS import_job_items_job_idx ON import_job_items(job_id, item_index);

CREATE TABLE IF NOT EXISTS model_routing (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_pattern TEXT NOT NULL,
  pool_type_priority TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_routing_owner_idx ON model_routing(owner_user_id, enabled);

CREATE TABLE IF NOT EXISTS provider_model_cache (
  pool_type TEXT PRIMARY KEY,
  models_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'DEFAULT',
  account_id TEXT,
  error TEXT,
  fetched_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_providers (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  interface_type TEXT NOT NULL CHECK(interface_type IN ('chat', 'responses')),
  models_json TEXT,
  balance_config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, name)
);
CREATE INDEX IF NOT EXISTS custom_providers_owner_idx ON custom_providers(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS model_pricing_cache (
  id TEXT PRIMARY KEY,
  models_json TEXT NOT NULL,
  fetched_at TEXT,
  updated_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS response_conversations (
  id TEXT PRIMARY KEY,
  continuity_key TEXT NOT NULL UNIQUE,
  opaque_items_json TEXT NOT NULL DEFAULT '[]',
  messages_json TEXT NOT NULL DEFAULT '[]',
  preferred_mode TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS response_conversations_updated_idx ON response_conversations(updated_at DESC);
`

export function createDatabase(filename: string): AppDatabase {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true })
  const db = new Database(filename)
  resetLegacyAccountDomain(db)
  db.exec(schema)
  ensureCurrentAccountColumns(db)
  ensurePoolTypeColumn(db)
  db.exec("CREATE INDEX IF NOT EXISTS accounts_pool_type_idx ON accounts(owner_user_id, pool_type, admin_state)")
  ensureCurrentGatewayRequestColumns(db)
  ensureCurrentApiKeyColumns(db)
  ensureUserColumns(db)
  ensureCurrentQuotaColumns(db)
  ensureResponseConversationColumns(db)
  ensureCurrentImportJobColumns(db)
  db.exec("CREATE INDEX IF NOT EXISTS accounts_provider_external_idx ON accounts(owner_user_id, pool_type, external_id)")
  return db
}

function ensurePoolTypeColumn(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("pool_type")) db.exec("ALTER TABLE accounts ADD COLUMN pool_type TEXT NOT NULL DEFAULT 'opencode-go'")
}

function ensureCurrentAccountColumns(db: AppDatabase): void {
  const existing = new Set((db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((column) => column.name))
  const additions = [
    ["go_subscription_id", "TEXT"],
    ["is_zen_subscribed", "INTEGER NOT NULL DEFAULT 0"],
    ["zen_subscription_id", "TEXT"],
    ["has_manage_subscription_button", "INTEGER NOT NULL DEFAULT 0"],
    ["disabled_reason", "TEXT"],
    ["disabled_at", "TEXT"],
    ["last_error", "TEXT"],
    ["external_id", "TEXT"],
  ] as const
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`)
  }
}

function ensureCurrentQuotaColumns(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(quota_windows)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("limit_value")) db.exec("ALTER TABLE quota_windows ADD COLUMN limit_value INTEGER")
  if (!cols.has("remaining_value")) db.exec("ALTER TABLE quota_windows ADD COLUMN remaining_value INTEGER")
  if (!cols.has("unit")) db.exec("ALTER TABLE quota_windows ADD COLUMN unit TEXT")
}

function ensureCurrentApiKeyColumns(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("key_ciphertext")) db.exec("ALTER TABLE api_keys ADD COLUMN key_ciphertext TEXT")
}

function ensureUserColumns(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("github_id")) db.exec("ALTER TABLE users ADD COLUMN github_id TEXT")
}

function ensureResponseConversationColumns(db: AppDatabase): void {
  // Table may already exist from older builds without messages_json.
  db.exec(`CREATE TABLE IF NOT EXISTS response_conversations (
    id TEXT PRIMARY KEY,
    continuity_key TEXT NOT NULL UNIQUE,
    opaque_items_json TEXT NOT NULL DEFAULT '[]',
    messages_json TEXT NOT NULL DEFAULT '[]',
    preferred_mode TEXT,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  const cols = new Set((db.prepare("PRAGMA table_info(response_conversations)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("messages_json")) db.exec("ALTER TABLE response_conversations ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]'")
  if (!cols.has("opaque_items_json")) db.exec("ALTER TABLE response_conversations ADD COLUMN opaque_items_json TEXT NOT NULL DEFAULT '[]'")
  if (!cols.has("preferred_mode")) db.exec("ALTER TABLE response_conversations ADD COLUMN preferred_mode TEXT")
  db.exec("CREATE INDEX IF NOT EXISTS response_conversations_updated_idx ON response_conversations(updated_at DESC)")
}
function ensureCurrentGatewayRequestColumns(db: AppDatabase): void {
  const requestCols = new Set((db.prepare("PRAGMA table_info(gateway_requests)").all() as { name: string }[]).map((column) => column.name))
  const requestAdditions = [
    ["stream", "INTEGER NOT NULL DEFAULT 0"],
    ["api_key_prefix", "TEXT"],
    ["account_id", "TEXT"],
    ["account_name", "TEXT"],
    ["ok", "INTEGER NOT NULL DEFAULT 0"],
    ["latency_ms", "INTEGER"],
    ["local_prep_ms", "INTEGER"],
    ["first_token_ms", "INTEGER"],
    ["error", "TEXT"],
    ["client", "TEXT"],
    ["user_agent", "TEXT"],
    ["origin", "TEXT"],
    ["request_size_bytes", "INTEGER"],
    ["response_size_bytes", "INTEGER"],
    ["prompt_tokens", "INTEGER"],
    ["completion_tokens", "INTEGER"],
    ["total_tokens", "INTEGER"],
    ["cached_tokens", "INTEGER"],
    ["reasoning_tokens", "INTEGER"],
    ["text_tokens", "INTEGER"],
    ["image_tokens", "INTEGER"],
    ["audio_tokens", "INTEGER"],
    ["inbound_endpoint", "TEXT"],
    ["upstream_endpoint", "TEXT"],
    ["process_mode", "TEXT"],
    ["route_mode", "TEXT"],
    ["route_reason", "TEXT"],
    ["converted", "INTEGER NOT NULL DEFAULT 0"],
    ["transform_summary", "TEXT"],
  ] as const
  for (const [name, definition] of requestAdditions) {
    if (!requestCols.has(name)) db.exec(`ALTER TABLE gateway_requests ADD COLUMN ${name} ${definition}`)
  }
  const attemptCols = new Set((db.prepare("PRAGMA table_info(gateway_attempts)").all() as { name: string }[]).map((column) => column.name))
  const attemptAdditions = [
    ["latency_ms", "INTEGER"],
    ["error_message", "TEXT"],
    ["account_name", "TEXT"],
  ] as const
  for (const [name, definition] of attemptAdditions) {
    if (!attemptCols.has(name)) db.exec(`ALTER TABLE gateway_attempts ADD COLUMN ${name} ${definition}`)
  }
}

function ensureCurrentImportJobColumns(db: AppDatabase): void {
  const jobColumns = new Set((db.prepare("PRAGMA table_info(import_jobs)").all() as { name: string }[]).map((column) => column.name))
  if (!jobColumns.has("rolled_back_at")) db.exec("ALTER TABLE import_jobs ADD COLUMN rolled_back_at TEXT")
  if (!jobColumns.has("rolled_back_accounts")) db.exec("ALTER TABLE import_jobs ADD COLUMN rolled_back_accounts INTEGER NOT NULL DEFAULT 0")

  const itemColumns = new Set((db.prepare("PRAGMA table_info(import_job_items)").all() as { name: string }[]).map((column) => column.name))
  if (!itemColumns.has("account_created")) {
    db.exec("ALTER TABLE import_job_items ADD COLUMN account_created INTEGER NOT NULL DEFAULT 0")
    db.exec(`UPDATE import_job_items SET account_created=1
      WHERE account_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM import_jobs j JOIN accounts a ON a.id=import_job_items.account_id
        WHERE j.id=import_job_items.job_id
          AND a.owner_user_id=j.owner_user_id
          AND a.created_at>=COALESCE(j.started_at,j.created_at)
          AND a.created_at<=COALESCE(j.completed_at,j.updated_at)
      )`)
  }
}

function resetLegacyAccountDomain(db: AppDatabase): void {
  const columns = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]
  if (!columns.length || columns.some((column) => column.name === "auth_cookie_ciphertext")) return
  db.pragma("foreign_keys = OFF")
  try {
    db.transaction(() => {
      for (const table of ["gateway_attempts", "events", "route_leases", "quota_windows", "routing_state", "oauth_attempts", "accounts"]) {
        db.exec(`DROP TABLE IF EXISTS ${table}`)
      }
    }).immediate()
  } finally {
    db.pragma("foreign_keys = ON")
  }
}

const CURRENT_ACCOUNT_SCHEMA_VERSION = 9
const globalDatabase = globalThis as typeof globalThis & {
  __opencodeApiDb?: AppDatabase
  __opencodeApiAccountSchemaVersion?: number
}

export function getDatabase(): AppDatabase {
  if (!globalDatabase.__opencodeApiDb) {
    ensureMasterKey()
    const db = createDatabase(getDatabasePath())
    initializeSystemSettings(db)
    globalDatabase.__opencodeApiDb = db
  }
  // Next.js dev HMR keeps the database connection on globalThis. Re-run additive
  // migrations once per schema version so a code reload cannot leave that live
  // connection on the previous table shape.
  if (globalDatabase.__opencodeApiAccountSchemaVersion !== CURRENT_ACCOUNT_SCHEMA_VERSION) {
    globalDatabase.__opencodeApiDb.exec(schema)
    ensureCurrentAccountColumns(globalDatabase.__opencodeApiDb)
    ensurePoolTypeColumn(globalDatabase.__opencodeApiDb)
    ensureCurrentGatewayRequestColumns(globalDatabase.__opencodeApiDb)
    ensureCurrentQuotaColumns(globalDatabase.__opencodeApiDb)
    ensureResponseConversationColumns(globalDatabase.__opencodeApiDb)
    ensureCurrentImportJobColumns(globalDatabase.__opencodeApiDb)
    globalDatabase.__opencodeApiDb.exec("CREATE INDEX IF NOT EXISTS accounts_provider_external_idx ON accounts(owner_user_id, pool_type, external_id)")
    globalDatabase.__opencodeApiAccountSchemaVersion = CURRENT_ACCOUNT_SCHEMA_VERSION
  }
  return globalDatabase.__opencodeApiDb
}
