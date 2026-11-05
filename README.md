# datacentertraining.us — Review Replies

Google review auto-reply dashboard for **datacentertraining.us**. The logo, colours and demo data are in `brand/` (see [Branding](#branding)).

A secure admin panel that pulls your Google reviews, drafts a reply to each one with OpenAI, and posts the reply to Google once you approve it, or automatically for the star ratings you choose.

- **Reviews dashboard**: reviewer name, star rating, review text and an editable AI-drafted reply. Approve & post, regenerate, or skip.
- **Auto-approve**: pick which ratings (e.g. 4★ and 5★) get replied to automatically. Everything else waits for a person.
- **Analytics**: review volume, rating distribution, average rating over time, response rate, median time to reply, and how replies were handled.
- **OpenAI cost tracking**: every API call is logged with its token counts and an estimated cost. You get spend per day, week or month, cost per reply, month to date, a projected monthly spend, and a breakdown by model and by purpose.
- **Security**: PBKDF2-hashed passwords, optional TOTP two-factor auth, brute-force lockout, HttpOnly session cookies, CSRF tokens, origin checks, a strict Content-Security-Policy, secrets encrypted at rest (AES-256-GCM), and an activity log.
- **Team**: add or remove admin users.

It's built with [Hono](https://hono.dev) and a plain HTML/JS frontend. The same code runs in two places:

- **Cloudflare Workers + D1** (recommended): no server to manage, free `*.workers.dev` URL, and a Cron Trigger syncs every few minutes.
- **Node.js + SQLite**: on a laptop, VPS or Docker.

---

## Deploy to Cloudflare

Every push to `main` deploys automatically through GitHub Actions (`.github/workflows/deploy-cloudflare.yml`). One-time setup:

1. **Cloudflare API token.** Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Token* → use the **Edit Cloudflare Workers** template → *Add more* → **Account · D1 · Edit** → *Continue* → *Create Token*.
2. If you've never used Workers, open **Workers & Pages** in the Cloudflare dashboard once so it creates your `workers.dev` subdomain.
3. **GitHub secrets.** In this repo go to *Settings → Secrets and variables → Actions → New repository secret* and add:

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
   | `ADMIN_EMAIL` | your login email |
   | `ADMIN_PASSWORD` | your login password (12+ characters) |
   | `CLOUDFLARE_ACCOUNT_ID` | *optional:* only if the token can see more than one Cloudflare account |
   | `OPENAI_API_KEY` | *optional:* you can paste the key in the dashboard's Settings instead |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | *optional:* when you're ready to connect Google |

4. **Deploy:** *Actions → Deploy to Cloudflare → Run workflow* (or push any commit). The run's summary shows the live URL, e.g. `https://<repo-name>.<your-subdomain>.workers.dev`.

The deploy creates a D1 database named `<repo-name>-db`, generates an `APP_SECRET` (the encryption key, kept as a Worker secret), and creates your admin login on first visit. Re-running is safe.

To deploy from your own computer instead: `npx wrangler login`, then `npm run deploy:cloudflare` (set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in the environment the first time).

**Custom domain:** in Cloudflare → Workers & Pages → your Worker → *Settings → Domains & Routes → Add → Custom domain* (e.g. `reviews.yourdomain.com`), then use that address for the Google redirect URI.

**Limits on the free Workers plan:** each sync drafts up to 8 reviews and auto-posts up to 5 (the cron runs every 5 minutes, so a backlog clears quickly). Raise these with the `MAX_DRAFTS_PER_SYNC` / `MAX_AUTO_POSTS_PER_SYNC` variables on the paid plan. If sign-in ever fails with Cloudflare error 1102 (CPU limit), the Workers Paid plan ($5/month) removes it.

To try the Cloudflare version locally: `npm run dev:cloudflare` (uses a local D1 database; put variables in `.dev.vars`).

---

## Quick start (Node.js, local)

Requires **Node.js 20.12+**. This runs the app with a local SQLite file instead of Cloudflare.

```bash
npm install
cp .env.example .env        # then fill in OPENAI_API_KEY (or add it later in Settings)
npm run create-user         # creates your admin login (asks for email + password)
npm start
```

Open http://localhost:3000 and sign in. Until Google is connected you'll see **demo mode**: sample reviews you can use to try drafting, approving and auto-approve. Nothing is posted anywhere in demo mode.

Other commands:

| Command | What it does |
|---|---|
| `npm run create-user` | Add an admin user from the command line |
| `npm run reset-password` | Reset a password (add `-- --disable-2fa` if someone lost their authenticator) |
| `npm run dev` | Start with auto-restart on file changes |

---

## Connecting Google Business Profile

Google requires an approved API project to read and reply to reviews.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **Request access** to the Business Profile APIs with Google's [access request form](https://developers.google.com/my-business/content/prereqs#request-access). Approval can take a few days. Until it comes through, API calls fail with quota or permission errors.
3. Enable these APIs in the project:
   - *My Business Account Management API*
   - *My Business Business Information API*
   - *Google My Business API* (this is where the reviews endpoints live)
4. **OAuth consent screen**: set it up and add the scope `https://www.googleapis.com/auth/business.manage`. While the app is in "Testing", add your Google account as a test user.
5. **Credentials → Create OAuth client ID → Web application.** Add this authorized redirect URI:
   ```
   <APP_URL>/api/google/callback
   ```
   e.g. `https://reviews.yourdomain.com/api/google/callback`. The Settings page shows the exact value.
6. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart.
7. In the dashboard, go to **Settings → Connect Google account**, sign in with the account that manages your business, and choose the location.

The app then syncs reviews on the interval set in Settings (default every 15 minutes). On each sync it drafts replies for new reviews and posts the ones that match your auto-approve ratings. The demo reviews are removed automatically on the first sync.

---

## OpenAI and costs

- Set `OPENAI_API_KEY` in `.env`, or paste the key in **Settings → OpenAI**. A key saved in the UI is stored encrypted and is never sent back to the browser.
- The default model is `gpt-5-mini`. You can switch to any model your key can use.
- Each draft is one request of roughly 500 input and 150–300 output tokens, a fraction of a cent on mini models.
- Costs are estimated from token counts multiplied by the per-model prices in **Settings**. The defaults are built in; check them against [openai.com/api/pricing](https://openai.com/api/pricing) and adjust as needed. Your OpenAI invoice is the source of truth.
- To keep spend bounded, each sync drafts at most 25 reviews.

---

## Deploying on your own server (Node.js)

Run it anywhere that runs Node or Docker (a VPS, Render, Railway, Fly.io…). Requirements:

1. **HTTPS.** Set `APP_URL=https://…` and `NODE_ENV=production`. This turns on `Secure` cookies and HSTS.
2. **Behind a proxy or load balancer**, set `TRUST_PROXY=1` so rate limiting and logs see real client IPs.
3. **A persistent disk** mounted at `data/` (or `DATA_DIR`). It holds the SQLite database.
4. **Set `APP_SECRET`** (32+ random characters) and keep it safe. It encrypts the stored Google token and OpenAI key. If you lose it, you'll need to reconnect Google and re-enter the key.
5. Create the first user with `npm run create-user`. On hosts without a shell, set `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` for the first boot, then remove them.

Docker:

```bash
docker build -t review-replies .
docker run -d -p 3000:3000 --env-file .env -v review-data:/app/data review-replies
```

---

## Branding

Everything brand-specific lives in the `brand/` folder, so the same code can run under different brands:

| File | Purpose |
|---|---|
| `brand/brand.json` | `name`, `appName`, default `businessName` for AI replies, and the logo/favicon file names |
| `brand/theme.css` | Colour and font overrides (CSS custom properties for light and dark mode) |
| `brand/demo.json` | Sample reviews shown in demo mode (optional) |
| `brand/*.png`, `*.svg`, `*.ico`, `*.woff2` | Logo (`logo`, plus an optional `logoDark` for dark mode), favicon, fonts |

Only image, font and CSS files in `brand/` are served to browsers. The JSON files stay private. Restart the server after changing anything in `brand/`.

---

## Running on a Windows PC or laptop

The dashboard runs whenever the PC is on. While it's off or asleep, the site is down and syncing pauses. No reviews are lost: the next sync catches up.

**1. Install and set up** (PowerShell, in the project folder, e.g. `C:\reviews-dashboard`):

```powershell
winget install OpenJS.NodeJS.LTS      # or download Node.js 22 LTS from nodejs.org, then reopen the terminal
npm install
copy .env.example .env                # edit it (see step 3)
npm run create-user
```

**2. Start automatically at boot.** In an **Administrator** PowerShell, in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
```

This registers a scheduled task that starts the server at boot, before anyone logs in, and restarts it if it crashes. Logs go to `data\server.log`.

**3. Give it a public HTTPS address with Cloudflare Tunnel** (free; your domain must use Cloudflare DNS). No router port-forwarding is needed, and your home IP stays hidden.

1. Install it: `winget install --id Cloudflare.cloudflared`
2. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*) and pick Windows. Run the `cloudflared.exe service install <token>` command it shows, in an Administrator terminal. That installs a Windows service that also starts at boot.
3. Add a **public hostname**, e.g. `reviews.yourdomain.com` → service `HTTP` → URL `localhost:3000`.
4. In `.env`:
   ```
   APP_URL=https://reviews.yourdomain.com
   NODE_ENV=production
   HOST=127.0.0.1
   TRUST_PROXY=loopback
   ```
   `HOST=127.0.0.1` keeps the app off whatever Wi-Fi the laptop joins. Only the tunnel can reach it.
5. Use `https://reviews.yourdomain.com/api/google/callback` as the Google OAuth redirect URI.

No domain? Use [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) instead. Run `tailscale funnel --bg 3000`, which gives you a permanent `https://<pc-name>.<tailnet>.ts.net` URL, and use that as `APP_URL`.

**4. Stop the laptop from sleeping while plugged in** (Administrator PowerShell):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0   # closing the lid does nothing on AC power
powercfg /setactive SCHEME_CURRENT
```

**Day-to-day:**

| Task | Command (Administrator PowerShell) |
|---|---|
| Restart after updating the code or `.env` | `Stop-ScheduledTask ReviewsDashboard; taskkill /F /IM node.exe; Start-ScheduledTask ReviewsDashboard` (this stops every Node process on the PC) |
| Check it's running | open `http://localhost:3000/healthz`, or read `data\server.log` |
| Remove auto-start | `Unregister-ScheduledTask -TaskName ReviewsDashboard -Confirm:$false` |
| Back up | copy the `data` folder (it holds the database and, if `APP_SECRET` isn't set, the encryption key) |

---

## Security details

| Area | What's in place |
|---|---|
| Passwords | PBKDF2-SHA256 (100,000 iterations, the Workers maximum), 12+ characters, constant-time comparison; unknown emails still run a hash so timing doesn't reveal which accounts exist |
| Brute force | Per-email lockout after 5 failures (15 min, doubling), plus a per-IP rate limit on the login endpoint |
| 2FA | TOTP (Google Authenticator, 1Password, Authy…), with replay protection |
| Sessions | Random 256-bit tokens, stored hashed; `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS (`__Host-` prefix); 2-hour idle and 24-hour absolute timeout; a password change signs out other sessions |
| CSRF | Per-session token required on every state-changing request, plus Origin / `Sec-Fetch-Site` checks |
| Headers | Strict CSP (no inline scripts), `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy` |
| Secrets | Google refresh token and UI-saved OpenAI key encrypted with AES-256-GCM; the OpenAI key never reaches the browser |
| AI safety | Review text is passed as untrusted data, and the prompt forbids invented contact details, promises of compensation, and personal data |
| Posting | Atomic status lock, so a reply can't be posted twice |
| Audit | Sign-ins, failed sign-ins, replies, auto-posts and settings changes are logged and shown under *Team & security* |

---

## Project layout

```
src/
  app.js            Routes, security headers, setup (Hono, runs on Workers and Node)
  worker.js         Cloudflare Workers entry (HTTP + cron trigger)
  node.js           Node.js entry (SQLite file, timer-based sync)
  runtime.js        Config from env / Worker bindings
  db.js             Schema and D1-style query helpers
  sqlite-adapter.js Makes better-sqlite3 behave like D1 on Node
  crypto.js         WebCrypto: password hashing, encryption, TOTP
  auth.js           Sessions, CSRF, lockout, users
  openai.js         Reply generation and usage/cost logging
  google.js         OAuth and Business Profile API
  reviews.js        Sync, drafting, auto-approve, posting
  analytics.js      Analytics aggregation
  demo.js, brand.js Demo data and branding
public/             login.html, app.html (templates) and assets/ (app.js, charts.js, app.css)
brand/              Logo, colours, demo data for this deployment
scripts/            create-user.js, build-assets.mjs, cloudflare/deploy.mjs, windows/
wrangler.jsonc      Cloudflare Workers config
```
