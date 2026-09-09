/**
 * Listing Lab — a customer deleting their own account (the iOS app, 9 Sep 2026).
 *
 * The promise: one tap, and nothing of theirs is left — no photo bytes in
 * storage, no rows in the database, no session that still opens. And it
 * must be THEIR account only: a neighbour's photos in the same bucket are
 * untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';

const SITE = 'https://listinglab.test';
function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    PIPELINE_SECRET: 'pipeline-shared-secret',
    PHOTOS: new TestR2(),
    ASSETS: { fetch: async () => new Response('asset') },
    PIPELINE: { idFromName(n) { return n; }, get() { return { fetch: async () => new Response('{}', { status: 202 }) }; } },
  };
}
const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const req = (method, path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method, headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const post = (path, body, headers) => req('POST', path, body, headers);
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });

/** Sign up, give them credits, upload a photo, run a job to delivery. */
async function customerWithWork(env, ctx, email) {
  const res = await worker.fetch(post('/api/signup', { email, password: 'password-one-two' }), env, ctx);
  const { account } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const store = new Store(env.DB);
  await store.appendEntry(account.id, { key: `seed:${account.id}`, type: 'purchase', delta: 10, packId: 'pack_10', at: '2026-09-01T00:00:00Z' });
  const up = await worker.fetch(new Request(`${SITE}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX }), env, ctx);
  const { photoId } = await up.json();
  const tr = await worker.fetch(post('/api/transform', { photoId, transformation: 'twilight' }, { cookie }), env, ctx);
  const { jobId } = await tr.json();
  await ctx.settled();
  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') } }),
  }), env, ctx);
  return { account, cookie, photoId, jobId };
}
const keysOf = (env, accountId) => [...env.PHOTOS.objects.keys()].filter(k => k.startsWith(`${accountId}/`));
const count = (db, table, accountId) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(accountId).n;

test('DELETE /api/me removes the account, its photos, its jobs, its credits and every session', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const me = await customerWithWork(env, ctx, 'leaving@example.com');
  const neighbour = await customerWithWork(env, ctx, 'staying@example.com');
  // A second phone signed in to the same account.
  const other = await worker.fetch(post('/api/signin', { email: 'leaving@example.com', password: 'password-one-two' }), env, ctx);
  const otherCookie = other.headers.get('set-cookie').split(';')[0];

  assert.ok(keysOf(env, me.account.id).length >= 2, 'an original and a result are in storage');
  assert.equal(count(db, 'sessions', me.account.id), 2);
  assert.ok(count(db, 'ledger_entries', me.account.id) >= 2);

  const res = await worker.fetch(req('DELETE', '/api/me', undefined, { cookie: me.cookie }), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(res.headers.get('set-cookie'), /ll_session=;.*Max-Age=0/);

  assert.deepEqual(keysOf(env, me.account.id), [], 'no bytes of theirs remain in storage');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = ?').get(me.account.id).n, 0, 'the account row is gone');
  for (const t of ['sessions', 'photos', 'jobs', 'listings', 'ledger_entries']) {
    assert.equal(count(db, t, me.account.id), 0, `${t} rows gone`);
  }
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM job_attempts WHERE job_id = ?').get(me.jobId).n, 0);
  assert.equal((await worker.fetch(get('/api/me', { cookie: me.cookie }), env, ctx)).status, 401, 'this phone is signed out');
  assert.equal((await worker.fetch(get('/api/me', { cookie: otherCookie }), env, ctx)).status, 401, 'and so is the other one');

  // The neighbour noticed nothing.
  assert.ok(keysOf(env, neighbour.account.id).length >= 2);
  assert.equal(count(db, 'photos', neighbour.account.id), 1);
  assert.equal((await worker.fetch(get('/api/me', { cookie: neighbour.cookie }), env, ctx)).status, 200);

  // The address is free to start again.
  const again = await worker.fetch(post('/api/signup', { email: 'leaving@example.com', password: 'password-three-four' }), env, ctx);
  assert.equal(again.status, 201);
  db.close();
});

test('an account with nothing in storage deletes cleanly too', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(post('/api/signup', { email: 'fresh@example.com', password: 'password-one-two' }), env, ctx);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const del = await worker.fetch(req('DELETE', '/api/me', undefined, { cookie }), env, ctx);
  assert.equal(del.status, 200);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  db.close();
});

test('storage deletion walks every page, not just the first', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(post('/api/signup', { email: 'many@example.com', password: 'password-one-two' }), env, ctx);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { account } = await res.json();
  for (let i = 0; i < 2500; i++) await env.PHOTOS.put(`${account.id}/pho_x/${i}.jpg`, new Uint8Array([1]));
  await env.PHOTOS.put('acct_other/pho_y/1.jpg', new Uint8Array([1]));
  assert.equal((await worker.fetch(req('DELETE', '/api/me', undefined, { cookie }), env, ctx)).status, 200);
  assert.deepEqual(keysOf(env, account.id), []);
  assert.ok(env.PHOTOS.objects.has('acct_other/pho_y/1.jpg'));
  db.close();
});

test('if storage refuses, the account stays so the person can try again — but they are already signed out', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const me = await customerWithWork(env, ctx, 'unlucky@example.com');
  env.PHOTOS.delete = async () => { throw new Error('R2 is having a moment'); };
  const res = await worker.fetch(req('DELETE', '/api/me', undefined, { cookie: me.cookie }), env, ctx);
  assert.equal(res.status, 500);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = ?').get(me.account.id).n, 1, 'nothing half-deleted');
  assert.equal(count(db, 'photos', me.account.id), 1);
  assert.equal(count(db, 'sessions', me.account.id), 0, 'sessions went first');
  db.close();
});

test('anonymous callers cannot delete anything, and the door is rate-limited', async () => {
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  assert.equal((await worker.fetch(req('DELETE', '/api/me'), env, ctx)).status, 401);
  assert.equal((await worker.fetch(req('DELETE', '/api/me', undefined, { cookie: 'll_session=' + 'f'.repeat(64) }), env, ctx)).status, 401);

  let allowed = 0;
  const limited = { ...env, LIMIT_AUTH: { limit: async () => ({ success: allowed-- > 0 }) } };
  const res = await worker.fetch(req('DELETE', '/api/me', undefined, { 'cf-connecting-ip': '203.0.113.9' }), limited, ctx);
  assert.equal(res.status, 429);
  // GET /api/me is never rate-limited: the app calls it on every launch.
  assert.notEqual((await worker.fetch(get('/api/me'), limited, ctx)).status, 429);
  db.close();
});
