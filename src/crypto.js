// Security primitives built on WebCrypto, so they behave the same on Cloudflare Workers and Node.js.
import { config } from './runtime.js';

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export class AppError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.isAppError = true;
    this.extra = extra;
  }
}

// ---------- encoding ----------

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(bytes = 32) {
  return b64url(randomBytes(bytes));
}

export async function sha256(value) {
  const d = new Uint8Array(await subtle.digest('SHA-256', te.encode(value)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- encryption at rest (AES-256-GCM, key derived from APP_SECRET with HKDF) ----------

let keyPromise = null;
let secretProvider = null;

/** db.js registers a fallback that generates and stores a secret if APP_SECRET isn't set. */
export function setSecretProvider(fn) {
  secretProvider = fn;
  keyPromise = null;
}

async function encKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const secret = config().appSecret || (await secretProvider());
      const base = await subtle.importKey('raw', te.encode(secret), 'HKDF', false, ['deriveKey']);
      return subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: te.encode('review-reply-admin'), info: te.encode('token-encryption') },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
    })().catch((e) => { keyPromise = null; throw e; });
  }
  return keyPromise;
}

export async function encrypt(plaintext) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await encKey(), te.encode(String(plaintext))));
  return `v2:${b64url(iv)}:${b64url(ct)}`;
}

export async function decrypt(payload) {
  if (!payload) return null;
  const [version, iv, ct] = String(payload).split(':');
  if (version !== 'v2') throw new Error('Unknown ciphertext version');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await encKey(), fromB64url(ct));
  return td.decode(pt);
}

// ---------- passwords (PBKDF2-SHA256) ----------

async function pbkdf2(password, salt, iterations) {
  const key = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const iterations = config().passwordIterations;
  const salt = randomBytes(16);
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, iter, salt, hash] = String(stored).split('$');
    if (algo !== 'pbkdf2-sha256') return false;
    const actual = await pbkdf2(password, fromB64url(salt), Number(iter));
    return safeEqual(b64url(actual), hash);
  } catch {
    return false;
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 256) return 'Password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Password is too simple.';
  return null;
}

export function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

// ---------- TOTP (RFC 6238) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(keyBytes, counter) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 2 ** 32));
  msg.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await subtle.sign('HMAC', key, msg.buffer));
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

/** Returns the matched time-step (stored to block replays), or null. */
export async function verifyTotp(secret, code, lastUsedStep = 0) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  for (const drift of [0, -1, 1]) {
    const s = step + drift;
    if (s <= lastUsedStep) continue;
    if (safeEqual(await hotp(key, s), clean)) return s;
  }
  return null;
}

export function totpUri(secret, email, issuer) {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
