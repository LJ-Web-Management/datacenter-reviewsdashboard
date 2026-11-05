// Builds dist/: the static files Cloudflare serves directly (app CSS/JS and brand images/fonts).
// brand/*.json is deliberately NOT copied: it's bundled into the Worker instead and stays private.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const SERVABLE = /^[\w.-]+\.(png|svg|webp|ico|jpe?g|css|woff2?)$/i;

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public', 'assets'), path.join(OUT, 'assets'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'brand'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'brand'))) {
  if (SERVABLE.test(f)) fs.copyFileSync(path.join(ROOT, 'brand', f), path.join(OUT, 'brand', f));
}
fs.writeFileSync(path.join(OUT, '_headers'), ['/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: same-origin', '  X-Frame-Options: DENY', ''].join('\n'));
console.log('Built static assets into dist/');
