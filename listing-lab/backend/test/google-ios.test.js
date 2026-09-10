/**
 * Listing Lab — Google sign-in from the iPhone app (10 Sep 2026).
 *
 * The app walks the website's own Google flow inside a sheet, with one
 * difference at the end: the callback hands it a one-time code on
 * /signin/return instead of a session cookie, and the app swaps the code for
 * a session at /api/auth/google/exchange, presenting the secret behind the
 * challenge it started with. These tests walk that trip end to end against
 * the real router and a real SQLite database, with Google's token endpoint
 * stubbed — the one thing that cannot be real here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TestD1, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';
import { hashToken } from '../src/auth.js';

const SITE = 'https://listinglab.test';
const CLIENT_ID = 'gid.apps.googleusercontent.com';
const here = dirname(fileURLToPath(import.meta.url));
const BOUNCE = "Google sign-in didn't finish — try again, or use email and password.";

function makeEnv(db, assetLog) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'gsec',
    ASSETS: { fetch: async (req) => { assetLog?.push(req.url); return new Response('<!doctype html>asset', { headers: { 'content-type': 'text/html' } }); } },
  };
}
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });
const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A verifier and its challenge, made the way the app makes them (RFC 7636). */
async function pkce(verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/**
 * An id_token as Google's token endpoint returns it. The callback reads the
 * claims without checking a signature, because the token came over TLS from
 * Google itself — so a bare header.payload.sig is enough here.
 */
function idToken(claims = {}) {
  const part = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  return `${part({ alg: 'RS256' })}.${part({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600,
    sub: '1234567890', email: 'agent@gmail.com', email_verified: true, name: 'Dana Agent', ...claims,
  })}.sig`;
}

function stubGoogle(claims) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ id_token: idToken(claims) }), { headers: { 'content-type': 'application/json' } });
    }
    return real(url, init);
  };
  return () => { globalThis.fetch = real; };
}

/** Step 1 as the app does it: start, keep the state cookie, read the state Google will echo. */
async function start(env, ctx, query = '') {
  const res = await worker.fetch(get(`/api/auth/google${query}`), env, ctx);
  assert.equal(res.status, 302, await res.text());
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const state = new URL(res.headers.get('location')).searchParams.get('state');
  return { res, cookie, state };
}

/** Step 2: Google sends the person back with a code. */
async function callback(env, ctx, { cookie, state }, claims = {}, query = `code=g_code&state=${state}`) {
  const restore = stubGoogle(claims);
  try { return await worker.fetch(get(`/api/auth/google/callback?${query}`, { cookie }), env, ctx); }
  finally { restore(); }
}

/** The whole app-side trip up to the code. */
async function codeFromApp(env, ctx, challenge, claims = {}) {
  const res = await callback(env, ctx, await start(env, ctx, `?platform=ios&challenge=${challenge}`), claims);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.pathname, '/signin/return', location.href);
  return { code: location.searchParams.get('code'), error: location.searchParams.get('error'), res };
}

const exchange = (env, ctx, code, verifier) => worker.fetch(post('/api/auth/google/exchange', { code, verifier }), env, ctx);

const count = (db, table) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/* ----------------------------------------------------------------- start */

test('the app starts with a challenge; the trip to Google is the website\'s, unchanged', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { challenge } = await pkce();
  const { res, cookie, state } = await start(env, ctx, `?platform=ios&challenge=${challenge}`);
  const to = new URL(res.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(to.searchParams.get('redirect_uri'), `${SITE}/api/auth/google/callback`, 'same callback as the website — nothing new to register with Google');
  assert.equal(to.searchParams.get('scope'), 'openid email profile');
  assert.match(state, /^[0-9a-f]{48}$/);
  assert.equal(cookie, `ll_gstate=${state}.ios.${challenge}`, 'the app and its challenge ride in the state cookie');

  // The website's start is exactly as before.
  const web = await start(env, ctx);
  assert.equal(web.cookie, `ll_gstate=${web.state}`);

  // The app cannot start without a challenge of the right shape.
  for (const bad of ['', '?platform=ios&challenge=short', `?platform=ios&challenge=${challenge}!`]) {
    const res = await worker.fetch(get(`/api/auth/google?platform=ios${bad.replace('?platform=ios', '')}`), env, ctx);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).error.code, 'CHALLENGE_REQUIRED');
  }
  db.close();
});

/* -------------------------------------------------------------- callback */

test('a first Google sign-in from the app creates the account and hands back a code, not a session', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { challenge } = await pkce();
  const { code, res } = await codeFromApp(env, ctx, challenge);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.ok(!/ll_session=/.test(res.headers.get('set-cookie') || ''), 'no session cookie is set in the sheet');
  assert.match(res.headers.get('set-cookie'), /^ll_gstate=; Max-Age=0/, 'the state cookie is cleared');

  const store = new Store(db);
  const account = await store.accountByEmail('agent@gmail.com');
  assert.equal(account.password_hash, '$google-only$');
  assert.equal(account.name, 'Dana Agent');
  assert.equal(count(db, 'sessions'), 0, 'no session until the app exchanges the code');
  assert.equal(count(db, 'app_signins'), 1);
  const row = db.db.prepare('SELECT * FROM app_signins').get();
  assert.equal(row.code_hash, await hashToken(code), 'stored hashed, like a session token');
  assert.equal(row.account_id, account.id);
  assert.equal(row.challenge, challenge);
  assert.ok(new Date(row.expires_at) - new Date(row.created_at) === 5 * 60 * 1000, 'five minutes to use it');
  db.close();
});

test('the code and the verifier together make a session; the code works exactly once', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { verifier, challenge } = await pkce();
  const { code } = await codeFromApp(env, ctx, challenge);

  const res = await exchange(env, ctx, code, verifier);
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.account.email, 'agent@gmail.com');
  assert.equal(out.account.password_hash, undefined);
  assert.match(out.session, /^[0-9a-f]{64}$/, 'the session token is in the JSON for the native app');
  assert.match(res.headers.get('set-cookie'), new RegExp(`^ll_session=${out.session};`), 'and the same token is the cookie');

  // The native app sends the token as a Cookie header itself.
  const me = await worker.fetch(get('/api/me', { cookie: `ll_session=${out.session}` }), env, ctx);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).account.id, out.account.id);

  assert.equal(count(db, 'app_signins'), 0, 'the code is gone');
  const again = await exchange(env, ctx, code, verifier);
  assert.equal(again.status, 401);
  assert.deepEqual((await again.json()).error, { code: 'GOOGLE_CODE', message: BOUNCE });
  assert.equal(count(db, 'sessions'), 1);
  db.close();
});

test('the wrong verifier is refused, and burns the code', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { verifier, challenge } = await pkce();
  const { code } = await codeFromApp(env, ctx, challenge);
  const other = await pkce();

  const wrong = await exchange(env, ctx, code, other.verifier);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'GOOGLE_CODE');
  assert.equal(count(db, 'app_signins'), 0, 'one guess is all a code allows');
  const right = await exchange(env, ctx, code, verifier);
  assert.equal(right.status, 401, 'too late — the code was spent on the wrong guess');
  assert.equal(count(db, 'sessions'), 0);
  db.close();
});

test('an expired code, a made-up code, and rubbish are all the same refusal', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { verifier, challenge } = await pkce();
  const store = new Store(db);
  const account = await store.createAccount({ id: 'acct_g', email: 'g@example.com', passwordHash: '$google-only$', at: '2026-09-01T00:00:00Z' });
  const code = 'ab'.repeat(32);
  await store.putAppSignin({
    code_hash: await hashToken(code), account_id: account.id, challenge,
    created_at: '2026-09-10T00:00:00Z', expires_at: '2026-09-10T00:05:00Z',   // long gone
  });
  const expired = await exchange(env, ctx, code, verifier);
  assert.equal(expired.status, 401);
  assert.equal(count(db, 'app_signins'), 0);

  const unknown = await exchange(env, ctx, 'cd'.repeat(32), verifier);
  assert.equal(unknown.status, 401);
  for (const [c, v] of [['', verifier], [code, ''], ['not-hex', verifier], [code, 'too short'], [null, null]]) {
    const res = await exchange(env, ctx, c, v);
    assert.equal(res.status, 401, `${c} / ${v}`);
    assert.equal((await res.json()).error.message, BOUNCE);
  }
  assert.equal(count(db, 'sessions'), 0);
  db.close();
});

test('the same Google account signs into the same account from the app as from the website', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  // First from the website.
  const web = await callback(env, ctx, await start(env, ctx));
  assert.equal(web.status, 302);
  assert.equal(new URL(web.headers.get('location')).pathname, '/app');
  const webCookies = web.headers.getSetCookie ? web.headers.getSetCookie() : [web.headers.get('set-cookie')];
  assert.ok(webCookies.some(c => /^ll_session=[0-9a-f]{64};/.test(c)), 'the website still gets its cookie');

  // Then from the app.
  const { verifier, challenge } = await pkce();
  const { code } = await codeFromApp(env, ctx, challenge);
  const out = await (await exchange(env, ctx, code, verifier)).json();
  assert.equal(out.account.email, 'agent@gmail.com');
  assert.equal(count(db, 'accounts'), 1, 'one account, two doors');
  assert.equal(count(db, 'sessions'), 2, 'each sign-in is its own session');
  db.close();
});

test('NO SILENT MERGE holds for the app too, and its failures land on /signin/return', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  await worker.fetch(post('/api/signup', { email: 'agent@gmail.com', password: 'password-one-two' }), env, ctx);
  const { challenge } = await pkce();

  const merged = await codeFromApp(env, ctx, challenge);
  assert.equal(merged.error, 'google_password_account');
  assert.equal(merged.code, null);
  assert.equal(count(db, 'app_signins'), 0);
  assert.equal(count(db, 'sessions'), 1, 'only the signup session exists');

  // The person pressed Cancel on Google's page: no code comes back.
  const denied = await callback(env, ctx, await start(env, ctx, `?platform=ios&challenge=${challenge}`), {}, 'state=whatever');
  assert.equal(new URL(denied.headers.get('location')).search, '?error=state_mismatch');
  const started = await start(env, ctx, `?platform=ios&challenge=${challenge}`);
  const cancelled = await callback(env, ctx, started, {}, `state=${started.state}`);
  assert.equal(new URL(cancelled.headers.get('location')).pathname, '/signin/return');
  assert.equal(new URL(cancelled.headers.get('location')).search, '?error=google_denied');

  // The website's own failures still land on /app, as before.
  const web = await callback(env, ctx, await start(env, ctx));
  assert.equal(web.headers.get('location'), `${SITE}/app?auth_error=google_password_account`);
  db.close();
});

/* ------------------------------------------------------- the hand-back page */

test('/signin/return serves the hand-back page with whatever the callback appended', async () => {
  const db = new TestD1(); const assets = []; const env = makeEnv(db, assets); const ctx = testCtx();
  const res = await worker.fetch(get('/signin/return?code=abc'), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(assets[0], `${SITE}/signin-return.html?code=abc`);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self' 'unsafe-inline'/, 'the inline hand-off script is allowed by the page CSP');
  db.close();
});

test('the hand-back page opens the app with the code or the error', () => {
  const html = readFileSync(join(here, '..', 'web', 'signin-return.html'), 'utf8');
  assert.match(html, /Returning you to the app…/);
  assert.match(html, /location\.href = target/);
  assert.match(html, /'listinglab:\/\/signin\?' \+ \(code \? 'code=' \+ code : 'error=' \+ error\)/);
  assert.match(html, />Open Listing Lab</);
  assert.match(html, /You can also just switch back to the app\./);
  assert.match(html, /name="robots" content="noindex"/);
});

/* ------------------------------------------------------------- rate limit */

test('the exchange is rate-limited like sign-in', async () => {
  const db = new TestD1(); const ctx = testCtx();
  let allowed = 1;
  const env = { ...makeEnv(db), LIMIT_AUTH: { limit: async () => ({ success: allowed-- > 0 }) } };
  const attempt = () => worker.fetch(post('/api/auth/google/exchange', { code: 'x', verifier: 'y' }, { 'cf-connecting-ip': '203.0.113.9' }), env, ctx);
  assert.notEqual((await attempt()).status, 429);
  const second = await attempt();
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '60');
  db.close();
});
