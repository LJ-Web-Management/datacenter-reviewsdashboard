// Database access. Uses Cloudflare D1's async API; on Node a better-sqlite3 adapter provides the same API.
import { getDb } from './runtime.js';
import { randomToken, setSecretProvider } from './crypto.js';

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  oauth_state TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_throttle (
  email TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  last_failure INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ip_throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  reviewer_name TEXT,
  reviewer_photo TEXT,
  star_rating INTEGER,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  status TEXT NOT NULL,
  suggested_reply TEXT,
  drafted_at INTEGER,
  reply_text TEXT,
  reply_at INTEGER,
  auto_approved INTEGER NOT NULL DEFAULT 0,
  posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  error TEXT,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  review_id INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  success INTEGER NOT NULL,
  error TEXT,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage(created_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  user_id INTEGER,
  user_email TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)
`;

const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

/** Prepared statement, for use in db.batch([...]). */
export function stmt(sql, ...params) {
  return getDb().prepare(sql).bind(...clean(params));
}

export async function all(sql, ...params) {
  return (await stmt(sql, ...params).all()).results || [];
}

export async function first(sql, ...params) {
  return (await stmt(sql, ...params).first()) ?? null;
}

/** Returns { changes, last_row_id }. */
export async function run(sql, ...params) {
  const res = await stmt(sql, ...params).run();
  return { changes: res.meta?.changes ?? 0, last_row_id: res.meta?.last_row_id ?? null };
}

/** Runs several statements atomically. */
export async function batch(statements) {
  return getDb().batch(statements);
}

export async function ensureSchema() {
  try {
    const row = await first("SELECT value FROM settings WHERE key = 'schema_version'");
    if (row && Number(JSON.parse(row.value)) >= SCHEMA_VERSION) return;
  } catch {
    /* tables don't exist yet */
  }
  const statements = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => getDb().prepare(s));
  // v2: replace em/en dashes in unposted drafts and demo replies (house style: hyphens only).
  const dash = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col}, ' \u2014 ', ' - '), '\u2014 ', '- '), '\u2014', ' - '), '\u2013', '-')`;
  statements.push(getDb().prepare(`UPDATE reviews SET suggested_reply = ${dash('suggested_reply')} WHERE status IN ('pending', 'failed') AND suggested_reply IS NOT NULL`));
  statements.push(getDb().prepare(`UPDATE reviews SET reply_text = ${dash('reply_text')}, suggested_reply = ${dash('suggested_reply')} WHERE source = 'demo'`));
  statements.push(getDb().prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(SCHEMA_VERSION)));
  await batch(statements);
}

// ---------- settings ----------

export async function getSetting(key, fallback = null) {
  const row = await first('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  if (value === undefined || value === null) {
    await run('DELETE FROM settings WHERE key = ?', key);
    return;
  }
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export async function audit(user, action, detail = null, ip = null) {
  await run('INSERT INTO audit_log (created_at, user_id, user_email, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    Date.now(), user?.id ?? null, user?.email ?? null, action, detail, ip);
}

/** A lock shared by every Worker instance (so two syncs never overlap). */
export async function acquireLock(name, ttlMs) {
  const now = Date.now();
  const res = await run(`INSERT INTO locks (name, until) VALUES (?, ?)
                         ON CONFLICT(name) DO UPDATE SET until = excluded.until WHERE locks.until < ?`, name, now + ttlMs, now);
  return res.changes > 0;
}

export async function releaseLock(name) {
  await run('DELETE FROM locks WHERE name = ?', name);
}

export async function cleanup() {
  const now = Date.now();
  await batch([
    stmt('DELETE FROM sessions WHERE expires_at < ?', now),
    stmt('DELETE FROM login_throttle WHERE last_failure < ? AND locked_until < ?', now - 86_400_000, now),
    stmt('DELETE FROM ip_throttle WHERE window_start < ?', now - 3_600_000),
    stmt('DELETE FROM audit_log WHERE created_at < ?', now - 365 * 86_400_000),
  ]);
}

// If APP_SECRET isn't configured, generate one once and keep it in the database.
// Setting APP_SECRET as a Worker secret / env var is better: it keeps the key apart from the data.
setSecretProvider(async () => {
  const existing = await getSetting('generatedAppSecret');
  if (existing) return existing;
  const secret = randomToken(48);
  await run("INSERT INTO settings (key, value) VALUES ('generatedAppSecret', ?) ON CONFLICT(key) DO NOTHING", JSON.stringify(secret));
  return (await getSetting('generatedAppSecret')) || secret;
});
