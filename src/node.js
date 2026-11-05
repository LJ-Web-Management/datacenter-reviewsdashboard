// Node.js entry (laptop / VPS / Docker): same app, SQLite file instead of D1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { setRuntime } from './runtime.js';
import { d1FromSqlite } from './sqlite-adapter.js';
import { SERVABLE_BRAND_FILE, brandTitle } from './brand.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const BRAND = path.join(ROOT, 'brand');

export function initNodeRuntime() {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // Keep the encryption key in a file next to (not inside) the database when APP_SECRET isn't set.
  if (!process.env.APP_SECRET) {
    const file = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(48).toString('base64url'), { mode: 0o600 });
      console.warn(`[config] APP_SECRET is not set, so one was generated at ${file}. Back it up with the database.`);
    }
    process.env.APP_SECRET = fs.readFileSync(file, 'utf8').trim();
  }

  const sqlite = new Database(path.join(dataDir, 'app.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  setRuntime({
    kind: 'node',
    db: d1FromSqlite(sqlite),
    env: process.env,
    templates: {
      login: fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8'),
      app: fs.readFileSync(path.join(PUBLIC, 'app.html'), 'utf8'),
    },
  });
  return sqlite;
}

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function fileResponse(c, file) {
  try {
    const data = fs.readFileSync(file);
    return c.body(data, 200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
  } catch {
    return c.text('Not found', 404);
  }
}

function mountStatic(app) {
  app.get('/assets/:file', (c) => {
    const name = c.req.param('file');
    if (!/^[\w.-]+$/.test(name)) return c.text('Not found', 404);
    return fileResponse(c, path.join(PUBLIC, 'assets', name));
  });
  app.get('/brand/:file', (c) => {
    const name = c.req.param('file');
    if (!SERVABLE_BRAND_FILE.test(name)) return c.text('Not found', 404); // never serve the JSON config
    return fileResponse(c, path.join(BRAND, name));
  });
}

// Start the server when run directly (npm start).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sqlite = initNodeRuntime();
  const { createApp, ensureReady, scheduledSync } = await import('./app.js');
  const app = createApp({ mountStatic });
  await ensureReady();

  const port = parseInt(process.env.PORT || '3000', 10);
  const hostname = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const server = serve({ fetch: app.fetch, port, hostname }, () => {
    console.log(`${brandTitle} running at ${process.env.APP_URL || `http://localhost:${port}`} (listening on ${hostname}:${port})`);
  });

  // Check every minute; runSync itself only syncs when the configured interval has passed.
  const tick = () => scheduledSync().catch((err) => console.error('[sync]', err));
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();

  const shutdown = () => {
    server.close(() => { sqlite.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
