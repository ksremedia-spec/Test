/**
 * Listing Lab — accounts, passwords and sessions.
 *
 * Everything here uses Web Crypto, which exists in both Cloudflare Workers and
 * Node, so the same code runs in production and in the tests.
 *
 * TWO RULES THAT DRIVE THE DESIGN
 *
 * 1. A stolen database must not be a stolen account. Passwords are stored as a
 *    PBKDF2 hash with a per-account random salt, never the password. Session
 *    cookies are stored as a SHA-256 hash, never the cookie — so a leaked backup
 *    contains nothing anyone can sign in with.
 *
 * 2. Sign-in must not reveal who has an account. A wrong password and an unknown
 *    email return the same message and take the same time, so the form cannot be
 *    used to harvest which of an agent's addresses are registered.
 */

/**
 * PBKDF2 rounds.
 *
 * 100,000 is not a preference — it is the ceiling. Cloudflare Workers refuse
 * anything higher outright:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * Found the hard way, on the first real sign-up against the deployed Worker.
 * If that cap is ever lifted, raise this: `needsRehash()` already upgrades every
 * stored password on its owner's next sign-in, so nobody gets locked out.
 */
export const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;

/** How long a signed-in session lasts. Agents work a listing over days, not minutes. */
export const SESSION_TTL_DAYS = 30;

const enc = new TextEncoder();

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Cryptographically random id. Used for account ids, job ids and session tokens. */
export function randomId(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, KEY_BITS);
  return toHex(bits);
}

/**
 * Hash a password for storage.
 * The stored string carries its own parameters, so iterations can be raised later
 * without invalidating everyone's existing password.
 */
export async function hashPassword(password, opts = {}) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new AuthError('WEAK_PASSWORD', 'Use at least 8 characters.');
  }
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toHex(salt)}$${hash}`;
}

/**
 * Check a password against a stored hash.
 * Returns false rather than throwing on a malformed record — a corrupt row must
 * not become a way in.
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000) return false;
  if (!/^[0-9a-f]+$/.test(parts[2]) || !/^[0-9a-f]+$/.test(parts[3])) return false;
  const computed = await pbkdf2(password, fromHex(parts[2]), iterations);
  return timingSafeEqual(computed, parts[3]);
}

/** True when a stored hash was made with fewer rounds than we now use. */
export function needsRehash(stored, iterations = PBKDF2_ITERATIONS) {
  const parts = String(stored || '').split('$');
  return parts[0] !== 'pbkdf2' || Number(parts[1]) < iterations;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A new session: the token goes in the cookie, only its hash is stored.
 * The token is never recoverable from the database, so it cannot leak from there.
 */
export async function newSession(accountId, opts = {}) {
  const token = randomId(32);
  const now = opts.now ? new Date(opts.now) : new Date();
  const expires = new Date(now.getTime() + (opts.ttlDays ?? SESSION_TTL_DAYS) * 86_400_000);
  return {
    token,
    record: {
      token_hash: await hashToken(token),
      account_id: accountId,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    },
  };
}

export async function hashToken(token) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(token)));
}

/** Normalise an email for storage and lookup. Agents type inconsistently. */
export function normaliseEmail(email) {
  if (typeof email !== 'string') throw new AuthError('INVALID_EMAIL', 'Enter an email address.');
  const trimmed = email.trim().toLowerCase();
  // Deliberately permissive on shape: the confirmation email is the real check,
  // and a clever regex mostly rejects addresses that turn out to be valid.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(trimmed)) {
    throw new AuthError('INVALID_EMAIL', 'That does not look like an email address.');
  }
  // But NEVER accept HTML/quote metacharacters. A real address never contains
  // them, and they are the raw material for injecting markup wherever an email
  // is later displayed (the owner dashboard, notification emails). This is a
  // defense-in-depth backstop to output escaping, not a replacement for it.
  // (Security review, 31 Aug 2026.)
  if (/[<>"'`\\]/.test(trimmed)) {
    throw new AuthError('INVALID_EMAIL', 'That does not look like an email address.');
  }
  return trimmed;
}

/** The Set-Cookie value for a session. */
export function sessionCookie(token, { ttlDays = SESSION_TTL_DAYS, secure = true } = {}) {
  const attrs = [
    `ll_session=${token}`,
    'Path=/',
    'HttpOnly',                   // JavaScript cannot read it, so an XSS bug cannot steal it
    'SameSite=Lax',               // not sent on cross-site POSTs, which blocks basic CSRF
    `Max-Age=${ttlDays * 86_400}`,
  ];
  if (secure) attrs.push('Secure'); // HTTPS only
  return attrs.join('; ');
}

export function clearedSessionCookie({ secure = true } = {}) {
  const attrs = ['ll_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Pull our session token out of a Cookie header. */
export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'll_session') {
      const v = part.slice(eq + 1).trim();
      return v.length ? v : null;
    }
  }
  return null;
}

export function isExpired(session, now = new Date()) {
  if (!session?.expires_at) return true;
  const expires = new Date(session.expires_at).getTime();
  // An unparseable date gives NaN, and every comparison against NaN is false —
  // so the obvious `expires <= now` would call a corrupt row NOT expired and let
  // that session live forever. Anything we cannot read is expired.
  if (!Number.isFinite(expires)) return true;
  return expires <= now.getTime();
}
