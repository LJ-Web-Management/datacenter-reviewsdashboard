#!/usr/bin/env node
// Node hosting only. Create an admin user, or reset a password:
//   npm run create-user   |   npm run reset-password   (add -- --disable-2fa to also turn off 2FA)
// On Cloudflare, the first admin comes from the INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD secrets.
import readline from 'node:readline';
import { initNodeRuntime } from '../src/node.js';

const sqlite = initNodeRuntime();
const { ensureSchema, first, run, audit } = await import('../src/db.js');
const { createUser } = await import('../src/auth.js');
const { hashPassword, validatePassword, normalizeEmail } = await import('../src/crypto.js');
await ensureSchema();

const args = process.argv.slice(2);
const reset = args.includes('--reset');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const email = normalizeEmail(args.includes('--email') ? args[args.indexOf('--email') + 1] : await ask('Email: '));
if (!email) { console.error('Invalid email.'); process.exit(1); }
const password = await ask('Password (min 12 characters): ', { hidden: true });
const problem = validatePassword(password);
if (problem) { console.error(problem); process.exit(1); }
if ((await ask('Repeat password: ', { hidden: true })) !== password) { console.error('Passwords do not match.'); process.exit(1); }

if (reset) {
  const user = await first('SELECT id FROM users WHERE email = ?', email);
  if (!user) { console.error('No user with that email.'); process.exit(1); }
  const disable2fa = args.includes('--disable-2fa');
  await run(`UPDATE users SET password_hash = ?${disable2fa ? ', totp_enabled = 0, totp_secret_enc = NULL' : ''} WHERE id = ?`, await hashPassword(password), user.id);
  await run('DELETE FROM sessions WHERE user_id = ?', user.id);
  await run('DELETE FROM login_throttle WHERE email = ?', email);
  await audit({ id: user.id, email }, 'password_reset_cli', disable2fa ? '2FA disabled' : null);
  console.log(`Password reset for ${email}.${disable2fa ? ' Two-factor auth was turned off.' : ''} All sessions were signed out.`);
} else {
  await createUser(email, password);
  console.log(`Created user ${email}.`);
}
sqlite.close();
