// Cloudflare Workers entry: HTTP requests + the cron trigger that syncs reviews.
import { setRuntime } from './runtime.js';
import { createApp, scheduledSync } from './app.js';
import loginHtml from '../public/login.html';
import appHtml from '../public/app.html';

const app = createApp();
const templates = { login: loginHtml, app: appHtml };

function init(env) {
  if (!env.DB) throw new Error('D1 binding "DB" is missing. See wrangler.jsonc.');
  setRuntime({ kind: 'workers', db: env.DB, env, templates });
}

export default {
  async fetch(request, env, ctx) {
    init(env);
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    init(env);
    ctx.waitUntil(scheduledSync().catch((err) => console.error('[cron] sync failed:', err)));
  },
};
