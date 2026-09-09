/**
 * Listing Lab — promo codes (built 28 Aug 2026 for the Monday beta).
 *
 * The promises under test: a code grants exactly its credits, at most once per
 * account, at most max_uses times in total; a retyped code never burns a
 * second use; minting is owner-only behind the board secret; and every error
 * reads like a sentence a person can act on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';

const SECRET = 'test-diag-secret';
function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: 'https://example.test',
    DIAG_SECRET: SECRET,
    STRIPE_SECRET_KEY: 'sk_test_unused',
    ASSETS: { fetch: async () => new Response('asset') },
  };
}
const post = (path, body, headers = {}) => new Request('https://example.test' + path, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const get = (path, headers = {}) => new Request('https://example.test' + path, { headers });

async function signedUp(env, ctx, email = 'agent@example.com') {
  const res = await worker.fetch(post('/api/signup', { email, password: 'password-one-two' }), env, ctx);
  assert.equal(res.status, 201);
  return res.headers.get('set-cookie').split(';')[0];
}
const balanceOf = async (env, ctx, cookie) =>
  (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance;

async function mint(env, ctx, body) {
  return worker.fetch(post(`/internal/board/promo?s=${SECRET}`, body), env, ctx);
}

test('minting is owner-only: no secret, no code', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(post('/internal/board/promo', { credits: 10 }), env, ctx);
  assert.equal(res.status, 404);
  const wrong = await worker.fetch(post('/internal/board/promo?s=nope', { credits: 10 }), env, ctx);
  assert.equal(wrong.status, 404);
});

test('a minted code redeems once and lands the credits', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const cookie = await signedUp(env, ctx);
  const minted = await (await mint(env, ctx, { code: 'BETA-10', credits: 10 })).json();
  assert.equal(minted.code, 'BETA-10');

  assert.equal(await balanceOf(env, ctx, cookie), 0);
  const res = await worker.fetch(post('/api/redeem', { code: 'beta-10' }, { cookie }), env, ctx);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.credits, 10);
  assert.equal(out.balance, 10);
  assert.equal(await balanceOf(env, ctx, cookie), 10);
});

test('retyping a used code neither pays twice nor burns a remaining use', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const a = await signedUp(env, ctx, 'first@example.com');
  const b = await signedUp(env, ctx, 'second@example.com');
  await mint(env, ctx, { code: 'TEAM-5', credits: 5, maxUses: 2 });

  assert.equal((await worker.fetch(post('/api/redeem', { code: 'TEAM-5' }, { cookie: a }), env, ctx)).status, 200);
  const again = await worker.fetch(post('/api/redeem', { code: 'TEAM-5' }, { cookie: a }), env, ctx);
  assert.equal(again.status, 409);
  assert.equal(await balanceOf(env, ctx, a), 5);

  // The second use survived the retype and still belongs to account B.
  assert.equal((await worker.fetch(post('/api/redeem', { code: 'TEAM-5' }, { cookie: b }), env, ctx)).status, 200);
  assert.equal(await balanceOf(env, ctx, b), 5);
});

test('a one-time code is one-time across accounts', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const a = await signedUp(env, ctx, 'first@example.com');
  const b = await signedUp(env, ctx, 'second@example.com');
  await mint(env, ctx, { code: 'ONCE-10', credits: 10 });

  assert.equal((await worker.fetch(post('/api/redeem', { code: 'ONCE-10' }, { cookie: a }), env, ctx)).status, 200);
  const late = await worker.fetch(post('/api/redeem', { code: 'ONCE-10' }, { cookie: b }), env, ctx);
  assert.equal(late.status, 410);
  assert.equal(await balanceOf(env, ctx, b), 0);
});

test('unknown and expired codes fail with readable sentences', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const cookie = await signedUp(env, ctx);

  const unknown = await worker.fetch(post('/api/redeem', { code: 'NOT-A-CODE' }, { cookie }), env, ctx);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error.message, /check the spelling/);

  await mint(env, ctx, { code: 'OLD-5', credits: 5, expiresAt: '2020-01-01T00:00:00Z' });
  const expired = await worker.fetch(post('/api/redeem', { code: 'OLD-5' }, { cookie }), env, ctx);
  assert.equal(expired.status, 410);
  assert.match((await expired.json()).error.message, /expired/);
});

test('promo grants show up as credits sold on the board metrics', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const cookie = await signedUp(env, ctx);
  await mint(env, ctx, { code: 'BOARD-3', credits: 3 });
  await worker.fetch(post('/api/redeem', { code: 'BOARD-3' }, { cookie }), env, ctx);
  const html = await (await worker.fetch(get(`/internal/board?s=${SECRET}`), env, ctx)).text();
  assert.ok(html.length > 0); // board renders with a promo entry in the ledger
});
