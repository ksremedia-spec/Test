/**
 * Listing Lab — Sign in with Apple (the iOS app, 9 Sep 2026).
 *
 * The identity token is a JWS from Apple. The tests mint their own RSA key,
 * publish it as a JWKS the way Apple does (stubbing fetch for the one URL),
 * and sign tokens with it — so every check the verifier makes is exercised
 * against a real signature, not a mocked "verified: true".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';
import {
  verifyAppleIdentityToken, resetAppleKeyCache, AppleVerificationError,
  APPLE_ISSUER, APPLE_JWKS_URL, APP_BUNDLE_ID,
} from '../src/apple.js';

const SITE = 'https://listinglab.test';
// The route verifies against the real clock, so the tokens are minted against it too.
const NOW = Date.now();

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = obj => b64url(enc.encode(JSON.stringify(obj)));

/** A signing key pair plus the JWKS Apple would publish for it. */
async function makeSigner(kid = 'kid-1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: pub.n, e: pub.e };
  const sign = async (claims, header = { alg: 'RS256', kid }) => {
    const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, sign, keys: [jwk] };
}

const claimsFor = (over = {}) => ({
  iss: APPLE_ISSUER,
  aud: APP_BUNDLE_ID,
  exp: Math.floor(NOW / 1000) + 600,
  iat: Math.floor(NOW / 1000),
  sub: '001234.abcdef.5678',
  email: 'agent@privaterelay.appleid.com',
  email_verified: 'true',
  is_private_email: 'true',
  ...over,
});

/** Stub fetch so the JWKS URL answers with our keys; count the fetches. */
function stubAppleKeys(keys) {
  const real = globalThis.fetch;
  const calls = { n: 0 };
  globalThis.fetch = async (url, init) => {
    if (String(url) === APPLE_JWKS_URL) { calls.n++; return new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } }); }
    return real(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const refuses = (fn, code) => assert.rejects(fn, err => {
  assert.ok(err instanceof AppleVerificationError, `expected AppleVerificationError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
  return true;
});

/* ------------------------------------------------------------ the verifier */

test('a token Apple signed for our app verifies, and its claims come back', async () => {
  const s = await makeSigner();
  const out = await verifyAppleIdentityToken(await s.sign(claimsFor()), { keys: s.keys, now: NOW });
  assert.equal(out.sub, '001234.abcdef.5678');
  assert.equal(out.email, 'agent@privaterelay.appleid.com');
  assert.equal(out.emailVerified, true, '"true" as a string counts');
});

test('a token signed by a key Apple does not publish is refused', async () => {
  const apple = await makeSigner('kid-1');
  const forger = await makeSigner('kid-1');   // same kid, different key
  await refuses(async () => verifyAppleIdentityToken(await forger.sign(claimsFor()), { keys: apple.keys, now: NOW }), 'APPLE_TOKEN_SIGNATURE');
});

test('a token naming an unknown key id is refused', async () => {
  const s = await makeSigner('kid-1');
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor(), { alg: 'RS256', kid: 'kid-9' }), { keys: s.keys, now: NOW }), 'APPLE_KEY_UNKNOWN');
});

test('the algorithm a token claims for itself is not trusted', async () => {
  const s = await makeSigner();
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor(), { alg: 'none', kid: 'kid-1' }), { keys: s.keys, now: NOW }), 'APPLE_TOKEN_ALG');
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor(), { alg: 'HS256', kid: 'kid-1' }), { keys: s.keys, now: NOW }), 'APPLE_TOKEN_ALG');
});

test('issuer, audience and expiry are each checked', async () => {
  const s = await makeSigner();
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor({ iss: 'https://accounts.google.com' })), { keys: s.keys, now: NOW }), 'APPLE_TOKEN_ISSUER');
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor({ aud: 'com.example.otherapp' })), { keys: s.keys, now: NOW }), 'APPLE_TOKEN_AUDIENCE');
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor({ exp: Math.floor(NOW / 1000) - 1 })), { keys: s.keys, now: NOW }), 'APPLE_TOKEN_EXPIRED');
  await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor({ sub: '' })), { keys: s.keys, now: NOW }), 'APPLE_TOKEN_MALFORMED');
});

test('garbage is refused as malformed, not thrown as a crash', async () => {
  const s = await makeSigner();
  for (const bad of ['', 'abc', 'a.b', 'a.b.c', null, 42]) {
    await refuses(() => verifyAppleIdentityToken(bad, { keys: s.keys, now: NOW }), 'APPLE_TOKEN_MALFORMED');
  }
});

test("Apple's keys are fetched once and cached; an unknown kid refetches once (rotation)", async () => {
  resetAppleKeyCache();
  const s1 = await makeSigner('kid-1');
  const stub = stubAppleKeys(s1.keys);
  try {
    await verifyAppleIdentityToken(await s1.sign(claimsFor()), { now: NOW });
    await verifyAppleIdentityToken(await s1.sign(claimsFor()), { now: NOW });
    assert.equal(stub.calls.n, 1, 'one fetch for two verifications');

    // Apple rotates: the cache is fresh but does not know the new kid.
    const s2 = await makeSigner('kid-2');
    globalThis.fetch = async (url) => new Response(JSON.stringify({ keys: [...s1.keys, ...s2.keys] }));
    await verifyAppleIdentityToken(await s2.sign(claimsFor()), { now: NOW });

    // A kid nobody publishes is refused without hammering Apple on every call.
    await refuses(async () => verifyAppleIdentityToken(await s2.sign(claimsFor(), { alg: 'RS256', kid: 'kid-3' }), { now: NOW }), 'APPLE_KEY_UNKNOWN');
  } finally { stub.restore(); resetAppleKeyCache(); }
});

test("when Apple's key endpoint is down the answer is 'unreachable', not 'forged'", async () => {
  resetAppleKeyCache();
  const s = await makeSigner();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  try {
    await refuses(async () => verifyAppleIdentityToken(await s.sign(claimsFor()), { now: NOW }), 'APPLE_KEYS_UNREACHABLE');
  } finally { globalThis.fetch = real; resetAppleKeyCache(); }
});

/* -------------------------------------------------------------- the route */

function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    ASSETS: { fetch: async () => new Response('asset') },
  };
}
const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });

/** Run `fn` with Apple's key endpoint answering with `keys`. */
async function withApple(keys, fn) {
  resetAppleKeyCache();
  const stub = stubAppleKeys(keys);
  try { return await fn(); } finally { stub.restore(); resetAppleKeyCache(); }
}

test('first Apple sign-in creates the account and hands the app a session two ways', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const s = await makeSigner();
  await withApple(s.keys, async () => {
    const res = await worker.fetch(post('/api/auth/apple', {
      identityToken: await s.sign(claimsFor()),
      authorizationCode: 'c_abc',
      user: { email: 'agent@privaterelay.appleid.com', name: { givenName: 'Dana', familyName: 'Agent' } },
    }), env, ctx);
    const out = await res.json();
    assert.equal(res.status, 201, JSON.stringify(out));
    assert.equal(out.account.email, 'agent@privaterelay.appleid.com');
    assert.equal(out.account.name, 'Dana Agent');
    assert.equal(out.account.password_hash, undefined);
    assert.match(out.session, /^[0-9a-f]{64}$/, 'the session token is in the JSON for the native app');
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`^ll_session=${out.session};`), 'and the same token is the cookie');
    assert.match(setCookie, /HttpOnly/);

    // The native app sends the token as a Cookie header itself.
    const me = await worker.fetch(get('/api/me', { cookie: `ll_session=${out.session}` }), env, ctx);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).account.id, out.account.id);

    const row = await new Store(db).accountById(out.account.id);
    assert.equal(row.apple_sub, '001234.abcdef.5678');
    assert.equal(row.password_hash, '$apple-only$');
  });
  db.close();
});

test('the same Apple user signs into the same account, even when the email changes', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const s = await makeSigner();
  await withApple(s.keys, async () => {
    const first = await (await worker.fetch(post('/api/auth/apple', { identityToken: await s.sign(claimsFor()) }), env, ctx)).json();
    // Apple only sends name/email on the first sign-in; later tokens may carry a different relay address or none.
    const again = await worker.fetch(post('/api/auth/apple', { identityToken: await s.sign(claimsFor({ email: undefined, email_verified: undefined })) }), env, ctx);
    assert.equal(again.status, 200);
    const out = await again.json();
    assert.equal(out.account.id, first.account.id, 'looked up by Apple sub, not by email');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2, 'each sign-in is its own session');
  });
  db.close();
});

test('NO SILENT MERGE: an Apple sign-in never enters a password account or a Google account by address', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const s = await makeSigner();
  await worker.fetch(post('/api/signup', { email: 'kyle@example.com', password: 'password-one-two' }), env, ctx);
  const store = new Store(db);
  await store.createAccount({ id: 'acct_g', email: 'g@example.com', passwordHash: '$google-only$', at: '2026-09-01T00:00:00Z' });

  await withApple(s.keys, async () => {
    const pw = await worker.fetch(post('/api/auth/apple', { identityToken: await s.sign(claimsFor({ sub: 'sub-a', email: 'Kyle@Example.com' })) }), env, ctx);
    assert.equal(pw.status, 409);
    const pwOut = await pw.json();
    assert.equal(pwOut.error.code, 'APPLE_PASSWORD_ACCOUNT');
    assert.equal(pwOut.error.message, 'That email already has a password account — sign in with your password.');

    const g = await worker.fetch(post('/api/auth/apple', { identityToken: await s.sign(claimsFor({ sub: 'sub-b', email: 'g@example.com' })) }), env, ctx);
    assert.equal(g.status, 409);
    assert.equal((await g.json()).error.code, 'APPLE_GOOGLE_ACCOUNT');

    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2, 'nothing was created');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'and only the signup session exists');
  });
  db.close();
});

test('the password form tells Apple and Google accounts which door to use', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const s = await makeSigner();
  await withApple(s.keys, async () => {
    await worker.fetch(post('/api/auth/apple', { identityToken: await s.sign(claimsFor({ email: 'a@example.com' })) }), env, ctx);
  });
  await new Store(db).createAccount({ id: 'acct_g', email: 'g@example.com', passwordHash: '$google-only$', at: '2026-09-01T00:00:00Z' });

  const apple = await worker.fetch(post('/api/signin', { email: 'a@example.com', password: 'anything-at-all' }), env, ctx);
  assert.equal(apple.status, 401);
  assert.deepEqual((await apple.json()).error, { code: 'APPLE_ACCOUNT', message: 'That email signed up with Apple — use Sign in with Apple.' });

  const google = await worker.fetch(post('/api/signin', { email: 'g@example.com', password: 'anything-at-all' }), env, ctx);
  assert.equal(google.status, 401);
  assert.deepEqual((await google.json()).error, { code: 'GOOGLE_ACCOUNT', message: 'That email signed up with Google — sign in with Google.' });

  // A plain password account and an unknown address still get the one answer.
  await worker.fetch(post('/api/signup', { email: 'p@example.com', password: 'password-one-two' }), env, ctx);
  const wrong = await worker.fetch(post('/api/signin', { email: 'p@example.com', password: 'not-it-at-all' }), env, ctx);
  const unknown = await worker.fetch(post('/api/signin', { email: 'nobody@example.com', password: 'not-it-at-all' }), env, ctx);
  assert.deepEqual(await wrong.json(), await unknown.json());
  db.close();
});

test('a forged or stale token is a 401, and a missing one a 400', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const apple = await makeSigner('kid-1');
  const forger = await makeSigner('kid-1');
  await withApple(apple.keys, async () => {
    const forged = await worker.fetch(post('/api/auth/apple', { identityToken: await forger.sign(claimsFor()) }), env, ctx);
    assert.equal(forged.status, 401);
    assert.equal((await forged.json()).error.code, 'APPLE_TOKEN');
    const empty = await worker.fetch(post('/api/auth/apple', { authorizationCode: 'x' }), env, ctx);
    assert.equal(empty.status, 400);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  });
  db.close();
});

test('Apple sign-in without a shared email cannot create an account', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const s = await makeSigner();
  await withApple(s.keys, async () => {
    const res = await worker.fetch(post('/api/auth/apple', { identityToken: await s.sign(claimsFor({ email: undefined, email_verified: undefined })) }), env, ctx);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'APPLE_EMAIL');
  });
  db.close();
});

test('Apple sign-in is rate-limited like sign-in', async () => {
  const db = new TestD1(); const ctx = testCtx();
  let allowed = 1;
  const env = { ...makeEnv(db), LIMIT_AUTH: { limit: async () => ({ success: allowed-- > 0 }) } };
  const attempt = () => worker.fetch(post('/api/auth/apple', { identityToken: 'nope' }, { 'cf-connecting-ip': '203.0.113.9' }), env, ctx);
  assert.notEqual((await attempt()).status, 429);
  const second = await attempt();
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '60');
  db.close();
});
