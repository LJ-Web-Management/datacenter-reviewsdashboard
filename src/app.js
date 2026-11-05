import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import QRCode from 'qrcode';
import { config } from './runtime.js';
import { all, first, run, batch, stmt, audit, getSetting, ensureSchema, cleanup } from './db.js';
import {
  AppError, randomToken, safeEqual, verifyPassword, hashPassword, validatePassword,
  encrypt, decrypt, generateTotpSecret, verifyTotp, totpUri,
} from './crypto.js';
import {
  appUrl, body, clientIp, createSession, destroySession, loadSession, requireAuth, csrfProtect, originCheck,
  lockRemainingMs, recordLoginFailure, clearLoginFailures, rateLimited, createUser, ensureInitialAdmin,
} from './auth.js';
import {
  getAppSettings, updateAppSettings, getModelPricing, DEFAULT_PRICING, TONES, LENGTHS, openAIKeyStatus,
  saveOpenAIKey, clearOpenAIKey, getGoogleConnection, setGoogleConnection, isDemoMode, pendingByStars,
} from './settings.js';
import { brandTitle, renderPage } from './brand.js';
import { generateReply, MAX_REPLY_CHARS } from './openai.js';
import { serializeReview, getReview, draftReply, postReply, runSync } from './reviews.js';
import { getAnalytics } from './analytics.js';
import { seedDemoData, clearDemoData } from './demo.js';
import * as google from './google.js';

// ---------- one-time setup per instance ----------

let ready = null;
export function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await ensureSchema();
      await ensureInitialAdmin();
      if (await isDemoMode()) await seedDemoData();
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

/** Called by the cron trigger (Workers) or a timer (Node). */
export async function scheduledSync() {
  await ensureReady();
  await cleanup();
  return runSync();
}

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https://*.googleusercontent.com",
  "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function createApp({ mountStatic } = {}) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err.isAppError) return c.json({ error: err.message, ...err.extra }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server.' }, 500);
  });

  // Security headers on everything the app renders.
  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('Content-Security-Policy', CSP + (new URL(c.req.url).protocol === 'https:' ? '; upgrade-insecure-requests' : ''));
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'same-origin');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (new URL(appUrl(c)).protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  mountStatic?.(app); // Node serves /assets and /brand itself; on Cloudflare they're static assets

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('*', async (c, next) => {
    await ensureReady();
    await next();
  });

  app.get('/login', async (c) => {
    if (await loadSession(c)) return c.redirect('/');
    c.header('Cache-Control', 'no-store');
    return c.html(renderPage('login'));
  });

  app.get('/', async (c) => {
    if (!(await loadSession(c))) return c.redirect('/login');
    c.header('Cache-Control', 'no-store');
    return c.html(renderPage('app'));
  });

  // ================= API =================
  const api = new Hono();
  api.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  api.use('*', bodyLimit({ maxSize: 100 * 1024, onError: (c) => c.json({ error: 'Request is too large.' }, 413) }));
  api.use('*', originCheck);

  // ---------- login (public) ----------
  api.post('/auth/login', async (c) => {
    const ip = clientIp(c);
    if (await rateLimited(`login:${ip}`, 20, 15 * 60_000)) {
      return c.json({ error: 'Too many sign-in attempts from this network. Try again in 15 minutes.' }, 429);
    }
    const b = await body(c);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(b.password || '').slice(0, 256);
    const code = String(b.code || '');
    if (!email || !password) throw new AppError('Enter your email and password.');

    const locked = await lockRemainingMs(email);
    if (locked) {
      await audit(null, 'login_blocked', email, ip);
      return c.json({ error: `Too many failed attempts. Try again in ${Math.ceil(locked / 60_000)} minute(s).` }, 429);
    }

    const user = await first('SELECT * FROM users WHERE email = ?', email);
    // Unknown emails are still checked against a dummy hash, so timing doesn't reveal which accounts exist.
    const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash());
    if (!user || !ok) {
      await recordLoginFailure(email);
      await audit(null, 'login_failed', email, ip);
      return c.json({ error: 'Incorrect email or password.' }, 401);
    }
    if (user.totp_enabled) {
      if (!code.trim()) return c.json({ totpRequired: true, error: 'Enter the 6-digit code from your authenticator app.' }, 401);
      const step = await verifyTotp(await decrypt(user.totp_secret_enc), code, user.totp_last_step);
      if (step === null) {
        await recordLoginFailure(email);
        await audit(user, 'login_failed', 'invalid 2FA code', ip);
        return c.json({ totpRequired: true, error: 'That code is incorrect or has expired.' }, 401);
      }
      await run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    }
    await clearLoginFailures(email);
    await destroySession(c); // never reuse a pre-login session
    await createSession(c, user.id);
    await run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
    await audit(user, 'login', null, ip);
    return c.json({ ok: true });
  });

  // Everything else needs a signed-in user; non-GET requests also need the CSRF header.
  api.use('*', requireAuth, csrfProtect);

  api.post('/auth/logout', async (c) => {
    await audit(c.get('user'), 'logout', null, clientIp(c));
    await destroySession(c);
    return c.json({ ok: true });
  });

  api.get('/auth/me', (c) => c.json({ user: c.get('user'), csrfToken: c.get('session').csrf_token }));

  // ---------- own account ----------
  api.post('/account/password', async (c) => {
    const { currentPassword, newPassword } = await body(c);
    const me = c.get('user');
    const user = await first('SELECT * FROM users WHERE id = ?', me.id);
    if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) throw new AppError('Your current password is incorrect.');
    const problem = validatePassword(newPassword);
    if (problem) throw new AppError(problem);
    await run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(newPassword), user.id);
    await run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, c.get('session').token_hash);
    await audit(me, 'password_changed', null, clientIp(c));
    return c.json({ ok: true });
  });

  api.post('/account/2fa/setup', async (c) => {
    const me = c.get('user');
    if (me.totpEnabled) throw new AppError('Two-factor authentication is already on.');
    const secret = generateTotpSecret();
    await run('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?', await encrypt(secret), me.id);
    const uri = totpUri(secret, me.email, brandTitle);
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220 });
    return c.json({ secret, uri, qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
  });

  api.post('/account/2fa/enable', async (c) => {
    const me = c.get('user');
    const user = await first('SELECT * FROM users WHERE id = ?', me.id);
    if (!user.totp_secret_enc) throw new AppError('Start the setup first.');
    const step = await verifyTotp(await decrypt(user.totp_secret_enc), (await body(c)).code, 0);
    if (step === null) throw new AppError("That code is incorrect. Check your phone's clock and try the newest code.");
    await run('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?', step, user.id);
    await audit(me, '2fa_enabled', null, clientIp(c));
    return c.json({ ok: true });
  });

  api.post('/account/2fa/disable', async (c) => {
    const me = c.get('user');
    const user = await first('SELECT * FROM users WHERE id = ?', me.id);
    if (!(await verifyPassword(String((await body(c)).password || ''), user.password_hash))) throw new AppError('Incorrect password.');
    await run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?', user.id);
    await audit(me, '2fa_disabled', null, clientIp(c));
    return c.json({ ok: true });
  });

  // ---------- team ----------
  api.get('/users', async (c) => {
    const me = c.get('user');
    const users = await all('SELECT id, email, totp_enabled, created_at, last_login_at FROM users ORDER BY created_at');
    return c.json({ users: users.map((u) => ({ id: u.id, email: u.email, totpEnabled: !!u.totp_enabled, createdAt: u.created_at, lastLoginAt: u.last_login_at, isYou: u.id === me.id })) });
  });

  api.post('/users', async (c) => {
    const b = await body(c);
    return c.json({ user: await createUser(b.email, b.password, c.get('user')) }, 201);
  });

  api.delete('/users/:id', async (c) => {
    const me = c.get('user');
    const id = Number(c.req.param('id'));
    if (id === me.id) throw new AppError("You can't remove your own account.");
    const target = await first('SELECT email FROM users WHERE id = ?', id);
    if (!target) throw new AppError('User not found.', 404);
    await batch([stmt('DELETE FROM sessions WHERE user_id = ?', id), stmt('DELETE FROM users WHERE id = ?', id)]);
    await audit(me, 'user_removed', target.email, clientIp(c));
    return c.json({ ok: true });
  });

  api.get('/activity', async (c) => {
    const rows = await all('SELECT created_at, user_email, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT 100');
    return c.json({ activity: rows.map((r) => ({ at: r.created_at, user: r.user_email, action: r.action, detail: r.detail, ip: r.ip })) });
  });

  // ---------- reviews ----------
  const STATUS_FILTERS = { pending: "'pending','failed','posting'", posted: "'posted'", replied: "'replied'", skipped: "'skipped'" };
  const loadReview = async (c) => {
    const review = await getReview(Number(c.req.param('id')));
    if (!review) throw new AppError('Review not found.', 404);
    return review;
  };

  api.get('/reviews', async (c) => {
    const q = c.req.query();
    const status = STATUS_FILTERS[q.status] ? q.status : q.status === 'all' ? 'all' : 'pending';
    const where = [];
    const params = [];
    if (status !== 'all') where.push(`r.status IN (${STATUS_FILTERS[status]})`);
    const stars = String(q.stars || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
    if (stars.length) {
      where.push(`r.star_rating IN (${stars.map(() => '?').join(',')})`);
      params.push(...stars);
    }
    const term = String(q.q || '').trim().slice(0, 100);
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push("(r.comment LIKE ? ESCAPE '\\' OR r.reviewer_name LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await all(`SELECT r.*, u.email AS posted_by_email FROM reviews r LEFT JOIN users u ON u.id = r.posted_by
                            ${whereSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = (await first(`SELECT COUNT(*) AS n FROM reviews r ${whereSql}`, ...params)).n;
    const counts = { pending: 0, posted: 0, replied: 0, skipped: 0, all: 0 };
    for (const row of await all('SELECT status, COUNT(*) AS n FROM reviews GROUP BY status')) {
      counts.all += row.n;
      if (['pending', 'failed', 'posting'].includes(row.status)) counts.pending += row.n;
      else if (counts[row.status] !== undefined) counts[row.status] += row.n;
    }
    return c.json({ reviews: rows.map(serializeReview), total, counts, limit, offset });
  });

  api.post('/reviews/:id/generate', async (c) => {
    const review = await loadReview(c);
    if (!['pending', 'failed'].includes(review.status)) throw new AppError('This review already has a reply.', 409);
    await draftReply(review, review.suggested_reply ? 'regenerate' : 'draft');
    return c.json({ review: serializeReview(await getReview(review.id)) });
  });

  api.patch('/reviews/:id', async (c) => {
    const review = await loadReview(c);
    if (!['pending', 'failed'].includes(review.status)) throw new AppError('This review already has a reply.', 409);
    const text = String((await body(c)).suggestedReply ?? '').slice(0, MAX_REPLY_CHARS);
    await run('UPDATE reviews SET suggested_reply = ? WHERE id = ?', text, review.id);
    return c.json({ review: serializeReview(await getReview(review.id)) });
  });

  api.post('/reviews/:id/approve', async (c) => {
    const review = await loadReview(c);
    const b = await body(c);
    const updated = await postReply(review.id, b.reply ?? review.suggested_reply, { user: c.get('user') });
    return c.json({ review: serializeReview(updated) });
  });

  api.post('/reviews/:id/skip', async (c) => {
    const review = await loadReview(c);
    const res = await run(`UPDATE reviews SET status = 'skipped' WHERE id = ? AND status IN ('pending', 'failed')`, review.id);
    if (!res.changes) throw new AppError('Only reviews awaiting a reply can be skipped.', 409);
    await audit(c.get('user'), 'review_skipped', `${review.star_rating}★ review by ${review.reviewer_name}`);
    return c.json({ review: serializeReview(await getReview(review.id)) });
  });

  api.post('/reviews/:id/restore', async (c) => {
    const review = await loadReview(c);
    const res = await run(`UPDATE reviews SET status = 'pending', error = NULL WHERE id = ? AND status IN ('skipped', 'failed')`, review.id);
    if (!res.changes) throw new AppError('Only skipped or failed reviews can be moved back.', 409);
    return c.json({ review: serializeReview(await getReview(review.id)) });
  });

  api.post('/sync', async (c) => c.json({ summary: await runSync({ manual: true, user: c.get('user') }) }));

  // ---------- status & settings ----------
  const googleStatus = async (c) => {
    const g = await getGoogleConnection();
    return {
      configured: google.isGoogleConfigured(),
      connected: !!g?.refreshTokenEnc,
      needsReconnect: !!g?.needsReconnect,
      email: g?.email || null,
      locationName: g?.locationName || null,
      locationTitle: g?.locationTitle || null,
      redirectUri: google.redirectUri(appUrl(c)),
    };
  };

  api.get('/status', async (c) => {
    const s = await getAppSettings();
    const pending = (await first(`SELECT COUNT(*) AS n FROM reviews WHERE status IN ('pending', 'failed')`)).n;
    return c.json({
      demoMode: await isDemoMode(),
      businessName: s.businessName,
      google: await googleStatus(c),
      openai: { ...(await openAIKeyStatus()), model: s.openaiModel },
      autoApprove: s.autoApprove,
      pendingCount: pending,
      lastSync: await getSetting('lastSync', null),
    });
  });

  const settingsPayload = async (c) => {
    const s = await getAppSettings();
    return {
      settings: {
        businessName: s.businessName, tone: s.tone, replyLength: s.replyLength, signature: s.signature,
        customInstructions: s.customInstructions, autoDraft: s.autoDraft, autoApprove: s.autoApprove,
        syncIntervalMinutes: s.syncIntervalMinutes, openaiModel: s.openaiModel, modelPricing: getModelPricing(s.openaiModel, s),
      },
      options: {
        tones: Object.keys(TONES), lengths: Object.keys(LENGTHS), models: Object.keys(DEFAULT_PRICING),
        defaultPricing: DEFAULT_PRICING, savedPricing: s.pricing,
      },
      openai: await openAIKeyStatus(),
      google: await googleStatus(c),
      pendingByStars: await pendingByStars(),
    };
  };

  api.get('/settings', async (c) => c.json(await settingsPayload(c)));

  api.put('/settings', async (c) => {
    const me = c.get('user');
    const before = await getAppSettings();
    const after = await updateAppSettings(await body(c));
    const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) await audit(me, 'settings_changed', changed.join(', '));
    if (JSON.stringify(before.autoApprove) !== JSON.stringify(after.autoApprove)) {
      await audit(me, 'auto_approve_changed', after.autoApprove.enabled ? `on for ${after.autoApprove.stars.join(', ')}★` : 'off');
    }
    return c.json(await settingsPayload(c));
  });

  api.put('/settings/openai-key', async (c) => {
    if (config().openaiApiKey) throw new AppError('The key is set by the OPENAI_API_KEY secret. Change it there.');
    await saveOpenAIKey((await body(c)).apiKey);
    await audit(c.get('user'), 'openai_key_saved');
    return c.json(await settingsPayload(c));
  });

  api.delete('/settings/openai-key', async (c) => {
    await clearOpenAIKey();
    await audit(c.get('user'), 'openai_key_removed');
    return c.json(await settingsPayload(c));
  });

  api.post('/settings/preview', async (c) => {
    const b = await body(c);
    const stars = Math.min(Math.max(parseInt(b.stars, 10) || 5, 1), 5);
    const overrides = {};
    for (const k of ['businessName', 'tone', 'replyLength', 'signature', 'customInstructions', 'openaiModel']) {
      if (typeof b[k] === 'string') overrides[k] = b[k].slice(0, k === 'customInstructions' ? 2000 : 120);
    }
    if (overrides.tone && !TONES[overrides.tone]) delete overrides.tone;
    if (overrides.replyLength && !LENGTHS[overrides.replyLength]) delete overrides.replyLength;
    if (overrides.openaiModel && !/^[A-Za-z0-9._:-]+$/.test(overrides.openaiModel)) delete overrides.openaiModel;
    const reply = await generateReply(
      { reviewer_name: String(b.reviewerName || 'Alex Morgan').slice(0, 80), star_rating: stars, comment: String(b.comment || '').slice(0, 2000) },
      { purpose: 'preview', overrides },
    );
    return c.json({ reply });
  });

  // ---------- Google Business Profile ----------
  api.get('/google/connect', async (c) => {
    if (!google.isGoogleConfigured()) throw new AppError('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README).');
    const state = randomToken(24);
    await run('UPDATE sessions SET oauth_state = ? WHERE token_hash = ?', state, c.get('session').token_hash);
    return c.redirect(google.authUrl(state, appUrl(c)));
  });

  api.get('/google/callback', async (c) => {
    const session = c.get('session');
    const expected = session.oauth_state;
    await run('UPDATE sessions SET oauth_state = NULL WHERE token_hash = ?', session.token_hash);
    const q = c.req.query();
    if (!expected || !safeEqual(String(q.state || ''), expected)) return c.redirect('/#settings?google=state_error');
    if (q.error || !q.code) return c.redirect('/#settings?google=denied');
    try {
      const { refreshTokenEnc, email } = await google.exchangeCode(String(q.code), appUrl(c));
      const prev = (await getGoogleConnection()) || {};
      await setGoogleConnection({
        refreshTokenEnc, email, connectedAt: Date.now(),
        ...(prev.email === email ? { accountName: prev.accountName, locationName: prev.locationName, locationTitle: prev.locationTitle, watermark: prev.watermark } : {}),
      });
      await audit(c.get('user'), 'google_connected', email);
      return c.redirect('/#settings?google=connected');
    } catch (err) {
      console.error('[google] OAuth callback failed:', err.message);
      return c.redirect('/#settings?google=error');
    }
  });

  api.get('/google/locations', async (c) => {
    if (!(await getGoogleConnection())?.refreshTokenEnc) throw new AppError('Connect Google first.');
    return c.json({ locations: await google.listLocations() });
  });

  api.post('/google/location', async (c) => {
    const conn = await getGoogleConnection();
    if (!conn?.refreshTokenEnc) throw new AppError('Connect Google first.');
    const { accountName, locationName } = await body(c);
    const match = (await google.listLocations()).find((l) => l.accountName === accountName && l.locationName === locationName);
    if (!match) throw new AppError('That location is not available on the connected Google account.');
    const switching = conn.locationName && conn.locationName !== match.locationName;
    if (switching) await run("DELETE FROM reviews WHERE source = 'google'");
    await setGoogleConnection({ ...conn, accountName: match.accountName, locationName: match.locationName, locationTitle: match.title, watermark: switching ? 0 : conn.watermark || 0 });
    await clearDemoData();
    await audit(c.get('user'), 'google_location_selected', match.title);
    const summary = await runSync({ manual: true, user: c.get('user') });
    return c.json({ google: await googleStatus(c), summary });
  });

  api.post('/google/disconnect', async (c) => {
    await google.revoke();
    await setGoogleConnection(null);
    await audit(c.get('user'), 'google_disconnected');
    return c.json({ google: await googleStatus(c) });
  });

  // ---------- analytics ----------
  api.get('/analytics', async (c) => c.json(await getAnalytics({ range: String(c.req.query('range') || '30'), tzOffset: c.req.query('tz') })));

  api.all('*', (c) => c.json({ error: 'Not found' }, 404));

  app.route('/api', api);
  app.notFound((c) => c.redirect('/'));
  return app;
}

let dummy = null;
function dummyHash() {
  if (!dummy) dummy = hashPassword('dummy-password-for-timing-only');
  return dummy;
}
