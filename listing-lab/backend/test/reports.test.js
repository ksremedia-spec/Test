/**
 * Listing Lab — customer problem reports (built 28 Aug 2026).
 *
 * The promises: a report files only against the reporter's OWN job; one report
 * per job (a retype is thanked, never duplicated); the owner's queue and its
 * resolve button live behind the board secret and nowhere else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import { CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';

const SECRET = 'whsec_test_reports';
const DIAG = 'test-diag-secret';
const SITE = 'https://listinglab.test';
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

function makeEnv(db) {
  return {
    DB: db, SITE_URL: SITE, STRIPE_WEBHOOK_SECRET: SECRET, DIAG_SECRET: DIAG,
    PIPELINE_SECRET: 'pipeline-shared-secret', PHOTOS: new TestR2(),
    PIPELINE: { idFromName: n => n, get: () => ({ fetch: async () => new Response('{}', { status: 202 }) }) },
  };
}
const post = (p, b, h = {}) => new Request(`${SITE}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...h },
  body: typeof b === 'string' ? b : JSON.stringify(b),
});
const get = (p, h = {}) => new Request(`${SITE}${p}`, { headers: h });

const enc = new TextEncoder();
async function stripeHeader(body, ts = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`));
  return `t=${ts},v1=${[...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
async function account(env, ctx, email) {
  const res = await worker.fetch(post('/api/signup', { email, password: 'a-strong-password-1' }), env, ctx);
  const { account } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const pack = CREDIT_PACKS.find(p => p.id === 'pack_30');
  const body = JSON.stringify({
    id: `evt_${email}`, type: CREDIT_GRANTING_EVENT,
    data: { object: { id: `cs_${email}`, payment_status: 'paid', amount_total: pack.priceCents, currency: 'usd',
                      metadata: { pack_id: 'pack_30', account_id: account.id } } },
  });
  await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  await ctx.settled();
  return { cookie, account };
}
async function startJob(env, ctx, cookie) {
  const { photoId } = await (await worker.fetch(new Request(`${SITE}/api/photos`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX,
  }), env, ctx)).json();
  const out = await (await worker.fetch(post('/api/transform', { photoId, transformation: 'declutter' }, { cookie }), env, ctx)).json();
  await ctx.settled();
  return out;
}

test('a report files against your own job, once; a retype is thanked, not duplicated', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await account(env, ctx, 'agent@example.com');
  const { jobId } = await startJob(env, ctx, cookie);

  const first = await worker.fetch(post('/api/report', { jobId, message: 'The couch blocks the fireplace.' }, { cookie }), env, ctx);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).alreadyReported, false);

  const again = await worker.fetch(post('/api/report', { jobId, message: 'Still not right!' }, { cookie }), env, ctx);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).alreadyReported, true);

  const list = await (await worker.fetch(get(`/internal/board/reports.json?s=${DIAG}`), env, ctx)).json();
  assert.equal(list.reports.length, 1, 'one report, not two');
  assert.match(list.reports[0].message, /fireplace/);
  assert.equal(list.reports[0].customer.email, 'agent@example.com');
  db.close();
});

test("you cannot report someone else's job, and empty messages bounce", async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const a = await account(env, ctx, 'first@example.com');
  const b = await account(env, ctx, 'second@example.com');
  const { jobId } = await startJob(env, ctx, a.cookie);

  const theft = await worker.fetch(post('/api/report', { jobId, message: 'not mine' }, { cookie: b.cookie }), env, ctx);
  assert.equal(theft.status, 404);

  const blank = await worker.fetch(post('/api/report', { jobId, message: '   ' }, { cookie: a.cookie }), env, ctx);
  assert.equal(blank.status, 400);
  db.close();
});

test('the owner queue is secret-gated and resolve closes a report', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await account(env, ctx, 'agent@example.com');
  const { jobId } = await startJob(env, ctx, cookie);
  await worker.fetch(post('/api/report', { jobId, message: 'Weird shadow on the rug.' }, { cookie }), env, ctx);

  assert.equal((await worker.fetch(get('/internal/board/reports.json'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board/reports?s=wrong'), env, ctx)).status, 404);

  const page = await worker.fetch(get(`/internal/board/reports?s=${DIAG}`), env, ctx);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Problem reports/);

  const { reports } = await (await worker.fetch(get(`/internal/board/reports.json?s=${DIAG}`), env, ctx)).json();
  const res = await worker.fetch(post(`/internal/board/reports/resolve?s=${DIAG}`, { id: reports[0].id }), env, ctx);
  assert.equal(res.status, 200);
  const after = await (await worker.fetch(get(`/internal/board/reports.json?s=${DIAG}`), env, ctx)).json();
  assert.equal(after.reports[0].status, 'resolved');

  // Resolving twice is a 404, not a silent success — the state never lies.
  const twice = await worker.fetch(post(`/internal/board/reports/resolve?s=${DIAG}`, { id: reports[0].id }), env, ctx);
  assert.equal(twice.status, 404);
  db.close();
});
