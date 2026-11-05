#!/usr/bin/env node
// Deploys this dashboard to Cloudflare Workers + D1. Safe to run repeatedly.
//
//   Locally:  npx wrangler login   then   npm run deploy:cloudflare
//   CI:       the GitHub Action runs this with CLOUDFLARE_API_TOKEN set
//
// Environment (all optional except where noted):
//   CLOUDFLARE_API_TOKEN    required in CI (Workers Scripts:Edit + D1:Edit)
//   CLOUDFLARE_ACCOUNT_ID   needed only if the token can see more than one account
//   WORKER_NAME             defaults to the package.json name
//   ADMIN_EMAIL / ADMIN_PASSWORD   first admin login (used only while no users exist)
//   OPENAI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   stored as Worker secrets if given
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = process.env;
const inCI = !!env.CI;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  if (env.GITHUB_ACTIONS) console.log(`::error::${msg.replace(/\n/g, ' ')}`);
  process.exit(1);
}

if (inCI && !env.CLOUDFLARE_API_TOKEN && !env.WORKERS_CI) {
  const msg = 'Skipping Cloudflare deploy: add a CLOUDFLARE_API_TOKEN secret to this repository (see README → Deploy to Cloudflare).';
  console.log(env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const workerName = (env.WORKER_NAME || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 54);
const dbName = `${workerName}-db`;

if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12) fail('ADMIN_PASSWORD must be at least 12 characters.');
if ((env.ADMIN_EMAIL && !env.ADMIN_PASSWORD) || (!env.ADMIN_EMAIL && env.ADMIN_PASSWORD)) fail('Set both ADMIN_EMAIL and ADMIN_PASSWORD, or neither.');

function wrangler(args, { input, quiet = false } = {}) {
  const res = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    cwd: ROOT, encoding: 'utf8', input, env: { ...env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (!quiet) process.stdout.write(res.stdout || '');
  return { ok: res.status === 0, stdout: res.stdout || '', out };
}

function parseJson(text) {
  const start = text.search(/[[{]/);
  return JSON.parse(text.slice(start));
}

console.log(`→ Worker "${workerName}", D1 database "${dbName}"`);

const readBaseConfig = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

// DRY_RUN=1: build the production bundle without touching your Cloudflare account.
if (env.DRY_RUN) {
  const cfgPath = path.join(ROOT, 'wrangler.deploy.jsonc');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...readBaseConfig(), $schema: undefined, name: workerName }, null, 2));
  const res = wrangler(['deploy', '--dry-run', '--outdir', path.join(ROOT, '.wrangler', 'dry-run'), '-c', cfgPath]);
  process.exit(res.ok ? 0 : (console.error(res.out), 1));
}

// 1. D1 database (create once)
let list = wrangler(['d1', 'list', '--json'], { quiet: true });
if (!list.ok) fail(`Could not list D1 databases:\n${list.out}\nCheck the API token has "D1: Edit" and (if you have several accounts) set CLOUDFLARE_ACCOUNT_ID.`);
let db = parseJson(list.stdout).find((d) => d.name === dbName);
if (!db) {
  console.log(`→ Creating D1 database ${dbName}`);
  const created = wrangler(['d1', 'create', dbName]);
  if (!created.ok) fail(`Could not create the D1 database:\n${created.out}`);
  db = parseJson(wrangler(['d1', 'list', '--json'], { quiet: true }).stdout).find((d) => d.name === dbName);
  if (!db) fail('The D1 database was created but could not be found afterwards.');
}
console.log(`→ D1 database id ${db.uuid}`);

// 2. Deployment config (same as wrangler.jsonc, with this repo's name and database)
const base = readBaseConfig();
const deployCfg = {
  ...base,
  name: workerName,
  d1_databases: [{ binding: 'DB', database_name: dbName, database_id: db.uuid }],
};
delete deployCfg.$schema;
const cfgPath = path.join(ROOT, 'wrangler.deploy.jsonc');
fs.writeFileSync(cfgPath, JSON.stringify(deployCfg, null, 2));

// 3. Deploy
console.log('→ Deploying');
const dep = wrangler(['deploy', '-c', cfgPath]);
if (!dep.ok) {
  if (/workers\.dev subdomain/i.test(dep.out)) {
    fail('Your Cloudflare account has no workers.dev subdomain yet. Open dash.cloudflare.com → Workers & Pages once (it asks you to pick one), then run this again.');
  }
  fail(`Deploy failed:\n${dep.out}`);
}
const url = (dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];

// 4. Secrets: generate APP_SECRET once; pass through the optional ones
const existing = wrangler(['secret', 'list', '--format', 'json', '-c', cfgPath], { quiet: true });
// Never guess here: generating a new APP_SECRET would make the stored Google token / OpenAI key unreadable.
if (!existing.ok) fail(`Could not read the Worker's existing secrets:\n${existing.out}`);
const have = new Set(parseJson(existing.stdout).map((s) => s.name));
const secrets = {};
if (!have.has('APP_SECRET')) secrets.APP_SECRET = crypto.randomBytes(48).toString('base64url');
if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  secrets.INITIAL_ADMIN_EMAIL = env.ADMIN_EMAIL.trim().toLowerCase();
  secrets.INITIAL_ADMIN_PASSWORD = env.ADMIN_PASSWORD;
}
for (const k of ['OPENAI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) if (env[k]) secrets[k] = env[k];
if (Object.keys(secrets).length) {
  console.log(`→ Setting secrets: ${Object.keys(secrets).join(', ')}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rra-'));
  const file = path.join(tmp, 'secrets.json');
  fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  try {
    const res = wrangler(['secret', 'bulk', file, '-c', cfgPath], { quiet: true });
    if (!res.ok) fail(`Setting secrets failed:\n${res.out.replace(/"[^"]{20,}"/g, '"***"')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (!have.has('INITIAL_ADMIN_EMAIL') && !secrets.INITIAL_ADMIN_EMAIL) {
  console.log('! No admin login configured yet: set ADMIN_EMAIL and ADMIN_PASSWORD (GitHub secrets) and deploy again.');
}

console.log(`\n✔ Live at ${url || '(see the deploy output above)'}\n`);
if (env.GITHUB_STEP_SUMMARY && url) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Deployed\n\n${url}\n`);
if (env.GITHUB_OUTPUT && url) fs.appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
