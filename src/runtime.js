// Runtime holder: the same app code runs on Cloudflare Workers (D1 + env bindings)
// and on Node.js (better-sqlite3 + process.env). The entry point calls setRuntime() first.

let rt = { db: null, env: {}, templates: {}, kind: 'unknown' };
let cfg = null;

export function setRuntime(next) {
  if (next.db !== rt.db || next.env !== rt.env) cfg = null;
  rt = { ...rt, ...next };
}

export function getDb() {
  if (!rt.db) throw new Error('Database is not initialised.');
  return rt.db;
}

export function runtimeKind() {
  return rt.kind;
}

export function template(name) {
  return rt.templates[name];
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function config() {
  if (cfg) return cfg;
  const env = rt.env || {};
  const workers = rt.kind === 'workers';
  cfg = Object.freeze({
    // Public URL. On Cloudflare it can be left empty: the request's own origin is used.
    appUrl: String(env.APP_URL || '').replace(/\/+$/, ''),
    appSecret: env.APP_SECRET && String(env.APP_SECRET).length >= 32 ? String(env.APP_SECRET) : null,
    trustProxy: bool(env.TRUST_PROXY, false),
    sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 120),
    sessionMaxHours: int(env.SESSION_MAX_HOURS, 24),
    // Cloudflare Workers caps PBKDF2 at 100,000 iterations.
    passwordIterations: Math.min(Math.max(int(env.PASSWORD_HASH_ITERATIONS, 100_000), 10_000), workers ? 100_000 : 1_000_000),

    openaiApiKey: String(env.OPENAI_API_KEY || '').trim(),
    openaiModel: env.OPENAI_MODEL || 'gpt-5-mini',
    openaiBaseUrl: String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),

    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',

    demoMode: bool(env.DEMO_MODE, true),
    initialAdminEmail: String(env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase(),
    initialAdminPassword: env.INITIAL_ADMIN_PASSWORD || '',

    // Per-sync caps keep each run inside Cloudflare's per-invocation limits (and bound OpenAI spend).
    maxDraftsPerSync: int(env.MAX_DRAFTS_PER_SYNC, workers ? 8 : 25),
    maxAutoPostsPerSync: int(env.MAX_AUTO_POSTS_PER_SYNC, workers ? 5 : 50),
    maxReviewPages: int(env.MAX_REVIEW_PAGES, workers ? 8 : 20),
  });
  return cfg;
}
