import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './runtime.js';
import { first, run, audit } from './db.js';
import { AppError, sha256, randomToken, safeEqual, hashPassword, normalizeEmail, validatePassword } from './crypto.js';

// ---------- request helpers ----------

export function appUrl(c) {
  return config().appUrl || new URL(c.req.url).origin;
}

export function isSecure(c) {
  return appUrl(c).startsWith('https://');
}

export function cookieName(c) {
  return isSecure(c) ? '__Host-rra_sid' : 'rra_sid';
}

export function clientIp(c) {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;
  if (config().trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  return c.env?.incoming?.socket?.remoteAddress || '';
}

/** Parse a JSON body; an empty body is {}. */
export async function body(c) {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new AppError('Invalid JSON body.', 400);
  }
}

// ---------- sessions ----------

export async function createSession(c, userId) {
  const token = randomToken(32);
  const now = Date.now();
  const maxMs = config().sessionMaxHours * 3_600_000;
  await run(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  await sha256(token), userId, randomToken(24), now, now, now + maxMs, clientIp(c), String(c.req.header('user-agent') || '').slice(0, 300));
  setCookie(c, cookieName(c), token, {
    httpOnly: true,
    secure: isSecure(c),
    // "Lax" (not "Strict") so the cookie survives the redirect back from Google's sign-in screen.
    // Cross-site POSTs are still blocked, and every state-changing request also needs the CSRF header.
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(maxMs / 1000),
  });
}

export async function destroySession(c) {
  const token = getCookie(c, cookieName(c));
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
  deleteCookie(c, cookieName(c), { path: '/', secure: isSecure(c), httpOnly: true, sameSite: 'Lax' });
}

export async function loadSession(c) {
  if (c.get('sessionLoaded')) return c.get('session');
  c.set('sessionLoaded', true);
  c.set('session', null);
  const token = getCookie(c, cookieName(c));
  if (!token || token.length > 128) return null;
  const hash = await sha256(token);
  const row = await first(`SELECT s.*, u.email, u.totp_enabled FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ?`, hash);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || row.last_seen_at + config().sessionIdleMinutes * 60_000 < now) {
    await run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  if (now - row.last_seen_at > 60_000) await run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, hash);
  c.set('session', row);
  c.set('user', { id: row.user_id, email: row.email, totpEnabled: !!row.totp_enabled });
  return row;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function requireAuth(c, next) {
  if (!(await loadSession(c))) return c.json({ error: 'Your session has expired. Please sign in again.' }, 401);
  await next();
}

/** Every state-changing request must echo the per-session CSRF token in a header. */
export async function csrfProtect(c, next) {
  if (!SAFE.has(c.req.method)) {
    const session = await loadSession(c);
    const header = c.req.header('x-csrf-token');
    if (!session || !header || !safeEqual(header, session.csrf_token)) {
      return c.json({ error: 'Security check failed. Reload the page and try again.' }, 403);
    }
  }
  await next();
}

/** Reject state-changing requests that come from another site. */
export async function originCheck(c, next) {
  if (!SAFE.has(c.req.method)) {
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Cross-site request blocked.' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* invalid */ }
      const allowed = new Set([new URL(c.req.url).host, c.req.header('host'), config().appUrl ? new URL(config().appUrl).host : null]);
      if (!host || !allowed.has(host)) return c.json({ error: 'Cross-site request blocked.' }, 403);
    }
  }
  await next();
}

// ---------- brute-force protection ----------

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export async function lockRemainingMs(email) {
  const row = await first('SELECT locked_until FROM login_throttle WHERE email = ?', email);
  const remaining = row ? row.locked_until - Date.now() : 0;
  return remaining > 0 ? remaining : 0;
}

export async function recordLoginFailure(email) {
  const now = Date.now();
  const row = await first('SELECT failures, last_failure FROM login_throttle WHERE email = ?', email);
  const failures = row && now - row.last_failure < 86_400_000 ? row.failures + 1 : 1;
  // Lock for 15 min after 5 failures, doubling for each further batch of 5 (capped at 24h).
  const lockedUntil = failures % MAX_FAILURES === 0 ? now + Math.min(LOCK_MS * 2 ** (failures / MAX_FAILURES - 1), 86_400_000) : 0;
  await run(`INSERT INTO login_throttle (email, failures, last_failure, locked_until) VALUES (?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, last_failure = excluded.last_failure,
             locked_until = MAX(login_throttle.locked_until, excluded.locked_until)`, email, failures, now, lockedUntil);
}

export async function clearLoginFailures(email) {
  await run('DELETE FROM login_throttle WHERE email = ?', email);
}

/** Simple fixed-window rate limit stored in the database (works across Worker instances). */
export async function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  await run(`INSERT INTO ip_throttle (key, count, window_start) VALUES (?, 1, ?)
             ON CONFLICT(key) DO UPDATE SET
               count = CASE WHEN ip_throttle.window_start < ? THEN 1 ELSE ip_throttle.count + 1 END,
               window_start = CASE WHEN ip_throttle.window_start < ? THEN excluded.window_start ELSE ip_throttle.window_start END`,
  key, now, now - windowMs, now - windowMs);
  const row = await first('SELECT count FROM ip_throttle WHERE key = ?', key);
  return (row?.count || 0) > limit;
}

// ---------- users ----------

export async function createUser(emailInput, password, actor = null) {
  const email = normalizeEmail(emailInput);
  if (!email) throw new AppError('Enter a valid email address.');
  const problem = validatePassword(password);
  if (problem) throw new AppError(problem);
  if (await first('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new AppError('A user with that email already exists.', 409);
  const res = await run('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)', email, await hashPassword(password), Date.now());
  await audit(actor, 'user_created', email);
  return { id: Number(res.last_row_id), email };
}

export async function ensureInitialAdmin() {
  const row = await first('SELECT COUNT(*) AS n FROM users');
  if (row.n > 0) return;
  const { initialAdminEmail, initialAdminPassword } = config();
  if (initialAdminEmail && initialAdminPassword) {
    try {
      await createUser(initialAdminEmail, initialAdminPassword);
      console.log(`[auth] Created the first admin user: ${initialAdminEmail}`);
    } catch (err) {
      // Don't take the whole site down over a bad first-admin secret; just report it.
      console.error(`[auth] Could not create the first admin (${initialAdminEmail}): ${err.message}`);
    }
  } else {
    console.log('[auth] No users yet. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD (or run npm run create-user on Node).');
  }
}
