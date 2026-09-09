/**
 * Listing Lab — account security tests.
 *
 * The shape of these: what an attacker gets if they steal the database, and what
 * the sign-in form gives away to someone probing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, needsRehash, randomId,
  newSession, hashToken, normaliseEmail, sessionCookie, clearedSessionCookie,
  readSessionCookie, isExpired, AuthError, PBKDF2_ITERATIONS, SESSION_TTL_DAYS,
} from '../src/auth.js';

// Tests use a low round count so they run fast; production uses PBKDF2_ITERATIONS.
const FAST = { iterations: 1000 };
const throwsCode = (fn, code) => assert.rejects(fn, err => (assert.equal(err.code, code), true));
const throwsCodeSync = (fn, code) => assert.throws(fn, err => (assert.equal(err.code, code), true));

/* ------------------------------------------------------------------ passwords */

test('the stored record never contains the password', async () => {
  const stored = await hashPassword('correct horse battery staple', FAST);
  assert.ok(!stored.includes('correct'));
  assert.ok(!stored.includes('horse'));
  assert.match(stored, /^pbkdf2\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test('the right password verifies, a wrong one does not', async () => {
  const stored = await hashPassword('listinglab2026!', FAST);
  assert.equal(await verifyPassword('listinglab2026!', stored), true);
  assert.equal(await verifyPassword('listinglab2026', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('two accounts with the same password get different stored records', async () => {
  // Without a per-account salt, one cracked password cracks every account that
  // shares it, and identical records reveal who shares a password.
  const a = await hashPassword('samepassword', FAST);
  const b = await hashPassword('samepassword', FAST);
  assert.notEqual(a, b, 'the salts must differ');
  assert.equal(await verifyPassword('samepassword', a), true);
  assert.equal(await verifyPassword('samepassword', b), true);
});

test('a short password is refused before it is ever stored', async () => {
  await throwsCode(() => hashPassword('short12', FAST), 'WEAK_PASSWORD');
  await throwsCode(() => hashPassword('', FAST), 'WEAK_PASSWORD');
});

test('a corrupt or tampered stored record is a refusal, not a way in', async () => {
  for (const bad of ['', 'plaintext', 'pbkdf2$$$', 'pbkdf2$1$aa$bb', 'md5$1000$aa$bb', null, undefined, 42]) {
    assert.equal(await verifyPassword('anything', bad), false);
  }
});

test('rounds can be raised later without locking anyone out', async () => {
  const old = await hashPassword('mypassword1', { iterations: 1000 });
  assert.equal(await verifyPassword('mypassword1', old), true, 'old record still works');
  assert.equal(needsRehash(old), true, 'and is flagged for upgrade on next sign-in');
  const fresh = await hashPassword('mypassword1', { iterations: PBKDF2_ITERATIONS });
  assert.equal(needsRehash(fresh), false);
});

/* ------------------------------------------------------------------- sessions */

test('the database stores a hash of the session cookie, never the cookie', async () => {
  const { token, record } = await newSession('acct_1');
  assert.notEqual(record.token_hash, token);
  assert.match(record.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(record.token_hash, await hashToken(token), 'the hash must be reproducible from the cookie');
  assert.equal(record.account_id, 'acct_1');
});

test('a stolen backup cannot be turned back into a working cookie', async () => {
  const { token, record } = await newSession('acct_1');
  // The only way from the stored hash back to the token is guessing a 256-bit value.
  assert.equal(token.length, 64);
  assert.ok(!record.token_hash.includes(token));
});

test('two sessions are never the same', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add((await newSession('acct_1')).token);
  assert.equal(seen.size, 200);
});

test('a session expires, and an expired one is not accepted', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const { record } = await newSession('acct_1', { now, ttlDays: SESSION_TTL_DAYS });
  assert.equal(isExpired(record, now), false);
  assert.equal(isExpired(record, new Date('2026-09-01T12:00:00Z')), false);
  assert.equal(isExpired(record, new Date('2026-10-01T12:00:00Z')), true);
});

test('a missing or malformed session is treated as expired', () => {
  assert.equal(isExpired(null), true);
  assert.equal(isExpired({}), true);
  assert.equal(isExpired({ expires_at: 'nonsense' }), true);
});

/* -------------------------------------------------------------------- cookies */

test('the session cookie is locked down', () => {
  const c = sessionCookie('abc123');
  assert.match(c, /HttpOnly/);   // script cannot read it, so an XSS bug cannot steal it
  assert.match(c, /Secure/);     // HTTPS only
  assert.match(c, /SameSite=Lax/); // not sent on cross-site POSTs
  assert.match(c, /Max-Age=2592000/);
});

test('signing out actually clears the cookie', () => {
  const c = clearedSessionCookie();
  assert.match(c, /ll_session=;/);
  assert.match(c, /Max-Age=0/);
});

test('the session token is read back out of a real cookie header', () => {
  assert.equal(readSessionCookie('ll_session=abc123'), 'abc123');
  assert.equal(readSessionCookie('other=1; ll_session=abc123; another=2'), 'abc123');
  assert.equal(readSessionCookie('  ll_session = abc123 '), 'abc123');
  assert.equal(readSessionCookie('other=1'), null);
  assert.equal(readSessionCookie('ll_session='), null);
  assert.equal(readSessionCookie(null), null);
  assert.equal(readSessionCookie(undefined), null);
});

test('a cookie whose name merely contains ours is not mistaken for it', () => {
  assert.equal(readSessionCookie('not_ll_session=evil'), null);
  assert.equal(readSessionCookie('ll_session_x=evil'), null);
});

/* --------------------------------------------------------------------- emails */

test('agents type inconsistently, so emails are normalised', () => {
  assert.equal(normaliseEmail('  Kyle@Example.COM '), 'kyle@example.com');
  assert.equal(normaliseEmail('a.b+tag@sub.example.co.uk'), 'a.b+tag@sub.example.co.uk');
});

test('an obvious non-address is refused', () => {
  for (const bad of ['', 'kyle', 'kyle@', '@example.com', 'kyle@example', 'a b@example.com', null, 42]) {
    throwsCodeSync(() => normaliseEmail(bad), 'INVALID_EMAIL');
  }
});

test('an email carrying HTML/quote metacharacters is refused (dashboard XSS guard)', () => {
  // Security review, 31 Aug 2026: a booby-trapped signup email was the raw
  // material for script injection on the owner dashboard. A real address never
  // contains these, so the address gate refuses them outright — the backstop
  // to output escaping on every page that shows an email.
  for (const evil of [
    '</script><script>alert(1)</script>@x.co',
    'a<svg/onload=alert(1)>@x.co',
    'a"onmouseover="alert(1)@x.co',
    "a'or'1@x.co",
    'a`x`@x.co',
    'a\\x@x.co',
  ]) {
    throwsCodeSync(() => normaliseEmail(evil), 'INVALID_EMAIL');
  }
});

/* ------------------------------------------------------------------------ ids */

test('ids are random and do not collide', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(randomId());
  assert.equal(seen.size, 2000);
  assert.match(randomId(), /^[0-9a-f]{32}$/);
});
