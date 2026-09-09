/**
 * Listing Lab — the owner's dashboard and its two switches.
 *
 * The switches are the part that must never lie: the dashboard promises the
 * customer a specific sentence when something is paused, and promises the owner
 * that pausing generation stops spend. These tests pin both promises to the
 * real routes with the real database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, testCtx } from './helpers/d1.js';
import worker, { sweepRetries, watchBudget } from '../src/worker.js';
import { Store } from '../src/store.js';

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

test('the board is a 404 without the secret, a page with it', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  assert.equal((await worker.fetch(get('/internal/board'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board?s=wrong'), env, ctx)).status, 404);
  const ok = await worker.fetch(get(`/internal/board?s=${SECRET}`), env, ctx);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /Listing Lab dashboard/);
  // The mock data is gone and real (empty-state) data is injected.
  assert.ok(!html.includes('__ADMIN_DATA__'), 'data token filled');
  assert.ok(!html.includes('S. Bennett'), 'no invented customers survive');
});

test('pausing sales closes the store with the promised sentence, and reopening works', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const cookie = await signedUp(env, ctx);

  const flip = (key, value) => worker.fetch(post(`/internal/board/flags?s=${SECRET}`, { key, value }), env, ctx);
  assert.equal((await flip('salesPaused', true)).status, 200);

  const closed = await worker.fetch(post('/api/checkout', { packId: 'pack_10' }, { cookie }), env, ctx);
  assert.equal(closed.status, 503);
  const body = await closed.json();
  assert.equal(body.error.message, 'Credit sales are temporarily paused — existing credits work normally.');

  assert.equal((await flip('salesPaused', false)).status, 200);
  // Reopened: the request now gets past the switch (it will fail later at
  // Stripe with our fake key, which is fine — 502, not 503).
  const reopened = await worker.fetch(post('/api/checkout', { packId: 'pack_10' }, { cookie }), env, ctx);
  assert.notEqual(reopened.status, 503);
});

test('pausing generation refuses new jobs with the promised sentence and holds the sweep', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const cookie = await signedUp(env, ctx);
  const store = new Store(db);
  await store.setFlag('genPaused', true);

  const refused = await worker.fetch(post('/api/transform', { photoId: 'p1', transformation: 'declutter' }, { cookie }), env, ctx);
  assert.equal(refused.status, 503);
  const body = await refused.json();
  assert.equal(body.error.message, 'AI generation is temporarily paused. Your credits are safe and never expire.');

  const swept = await sweepRetries(env, store);
  assert.deepEqual(swept, { paused: true }, 'the queue spends nothing while paused');

  await store.setFlag('genPaused', false);
  const after = await worker.fetch(post('/api/transform', { photoId: 'p1', transformation: 'declutter' }, { cookie }), env, ctx);
  assert.notEqual(after.status, 503, 'resumed: the switch no longer answers');
});

test('an unknown flag is refused — the board offers exactly two switches', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(post(`/internal/board/flags?s=${SECRET}`, { key: 'somethingElse', value: true }), env, ctx);
  assert.equal(res.status, 400);
});

test('the deliveries page and its image proxy live behind the same secret', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  env.PHOTOS = { get: async () => null };
  assert.equal((await worker.fetch(get('/internal/board/deliveries'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board/img?key=x'), env, ctx)).status, 404,
    'the image proxy must never serve a photo without the secret');
  const ok = await worker.fetch(get(`/internal/board/deliveries?s=${SECRET}`), env, ctx);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /No customer deliveries yet/);
});

test('the budget watcher raises each alarm once and re-arms on a new budget', async () => {
  // Kyle, 31 Aug 2026: "I can automatically get an email when credits are
  // running low — this is something that I would like to have before
  // production anyway." The watcher reads REAL metered spend (founder jobs
  // included — Google bills those too), emails at 75% and 90%, and never
  // nags twice at the same level.
  const db = new TestD1(); const env = makeEnv(db);
  const store = new Store(db);
  const sent = [];
  env.SUPPORT_EMAIL = { send: async (msg) => sent.push(msg) };
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').bind('a1', 'x@y.z', now).run();
  await db.prepare('INSERT INTO listings (id, account_id, address, created_at) VALUES (?, ?, ?, ?)').bind('l1', 'a1', '1 St', now).run();
  await db.prepare('INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES (?, ?, ?, ?, ?)').bind('p1', 'l1', 'a1', 'k', now).run();
  const spend = (id, usd) => db.prepare(
    `INSERT INTO jobs (id, account_id, photo_id, transformation, status, cost_usd, created_at)
     VALUES (?, 'a1', 'p1', 'declutter', 'delivered', ?, ?)`).bind(id, usd, now).run();
  await store.setSetting('budgetUsd', '10');
  await store.setSetting('budgetSince', '2026-01-01');

  // Freeze the hourly gate open.
  const realMinutes = Date.prototype.getUTCMinutes;
  Date.prototype.getUTCMinutes = function () { return 7; };
  try {
    await spend('j1', 5.0);                       // 50% — quiet
    let out = await watchBudget(env, store);
    assert.equal(sent.length, 0, 'below 75% nothing is sent');
    await spend('j2', 3.0);                       // 80% — the 75% alarm
    out = await watchBudget(env, store);
    assert.equal(out.alertSent, 75);
    assert.equal(sent.length, 1);
    await watchBudget(env, store);
    assert.equal(sent.length, 1, 'the same level never fires twice');
    await spend('j3', 1.5);                       // 95% — the 90% alarm
    out = await watchBudget(env, store);
    assert.equal(out.alertSent, 90);
    assert.equal(sent.length, 2);
    // Top-up: a new budget re-arms both levels.
    await store.setSetting('budgetUsd', '100');
    await store.setSetting('budgetAlerted', '0');
    out = await watchBudget(env, store);
    assert.equal(sent.length, 2, 'under the new budget, quiet again');
  } finally {
    Date.prototype.getUTCMinutes = realMinutes;
  }
  db.close();
});

test('job cost accumulates across retries and is not overwritten by the last attempt', async () => {
  // Reliability review, 31 Aug 2026: a job that outaged and retried spent real
  // Google money on every attempt, but finishJob overwrote cost_usd with only
  // the final attempt's figure — so the budget meter undercounted exactly when
  // spend spiked. Cost now accumulates: each park adds that attempt's spend, and
  // the final finish adds the last attempt's spend, giving the true total.
  const db = new TestD1();
  const store = new Store(db);
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').bind('a', 'a@b.c', now).run();
  await db.prepare('INSERT INTO listings (id, account_id, address, created_at) VALUES (?, ?, ?, ?)').bind('l', 'a', '1 St', now).run();
  await db.prepare('INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES (?, ?, ?, ?, ?)').bind('p', 'l', 'a', 'k', now).run();
  await db.prepare(`INSERT INTO jobs (id, account_id, photo_id, transformation, status, attempts_allowed, created_at)
                    VALUES ('j', 'a', 'p', 'staging', 'queued', 3, ?)`).bind(now).run();

  // Two outage attempts, each spending real money, then a successful delivery.
  await store.parkJobForRetry({ jobId: 'j', retryAfter: now, attemptCostUsd: 0.30 });
  // A duplicate report of the same parked attempt must NOT double-add.
  await store.parkJobForRetry({ jobId: 'j', retryAfter: now, attemptCostUsd: 0.30 });
  // Clear retry_after so the next park is a fresh attempt (as a redispatch would).
  await db.prepare("UPDATE jobs SET retry_after = NULL WHERE id = 'j'").run();
  await store.parkJobForRetry({ jobId: 'j', retryAfter: now, attemptCostUsd: 0.25 });
  await db.prepare("UPDATE jobs SET retry_after = NULL WHERE id = 'j'").run();
  const fin = await store.finishJob({ jobId: 'j', status: 'delivered', resultKey: 'r', costUsd: 0.70, at: now });
  assert.equal(fin.changed, true);

  const row = await db.prepare("SELECT cost_usd FROM jobs WHERE id = 'j'").first();
  assert.ok(Math.abs(row.cost_usd - 1.25) < 1e-9,
    `expected 0.30 + 0.25 + 0.70 = 1.25, got ${row.cost_usd}`);

  // A second finish (late duplicate callback) is a no-op — no double cost.
  const again = await store.finishJob({ jobId: 'j', status: 'delivered', resultKey: 'r', costUsd: 0.70, at: now });
  assert.equal(again.changed, false, 'an already-finished job is not finished twice');
  const row2 = await db.prepare("SELECT cost_usd FROM jobs WHERE id = 'j'").first();
  assert.ok(Math.abs(row2.cost_usd - 1.25) < 1e-9, 'cost unchanged by the duplicate finish');
  db.close();
});

test('boardMetrics returns sane empty-state numbers on a fresh database', async () => {
  const db = new TestD1();
  const store = new Store(db);
  const m = await store.boardMetrics();
  assert.equal(m.weeks.length, 12);
  assert.equal(m.perTransformation.declutter.length, 12);
  assert.equal(m.creditsSold, 0);
  assert.equal(m.revenueCents, 0);
  assert.equal(m.passRate, null, 'no jobs yet means no rate, not a fake 100');
  assert.deepEqual(m.failures, []);
});

test('internal accounts are invisible to every board statistic', async () => {
  // The scenario this pins: the owner keeps ~75 founder test jobs on his own
  // accounts (his choice at the wipe), and the pass rate the dashboard shows
  // must be measured on customers only. Flagging the account (migration 007)
  // must remove its jobs, credits, spend, failures, audit rows, and the
  // account itself from the board — while a customer's numbers stay put.
  const db = new TestD1();
  const store = new Store(db);
  const now = new Date().toISOString();
  const seed = async (id, email, internal) => {
    await db.prepare('INSERT INTO accounts (id, email, created_at, internal) VALUES (?, ?, ?, ?)')
      .bind(id, email, now, internal ? 1 : 0).run();
    await db.prepare('INSERT INTO listings (id, account_id, address, created_at) VALUES (?, ?, ?, ?)')
      .bind('l-' + id, id, id + ' St', now).run();
    await db.prepare('INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('p-' + id, 'l-' + id, id, 'orig/' + id, now).run();
  };
  await seed('cust', 'agent@example.com', false);
  await seed('own', 'kyle@horizonhomemedia.com', true);

  // The customer: one delivered job and one rejected job → 50% pass rate.
  // The owner: three rejected founder tests that must not drag the rate down.
  let n = 0;
  const job = (acct, status, cost) =>
    db.prepare(`INSERT INTO jobs (id, account_id, photo_id, transformation, status, cost_usd, created_at)
                VALUES (?, ?, ?, 'declutter', ?, ?, ?)`)
      .bind('j' + (++n), acct, 'p-' + acct, status, cost, now).run();
  await job('cust', 'delivered', 0.40);
  await job('cust', 'rejected', 0.40);
  for (let i = 0; i < 3; i++) await job('own', 'rejected', 9.99);

  await db.prepare(`INSERT INTO ledger_entries (key, account_id, type, delta, pack_id, at)
                    VALUES ('k1', 'cust', 'purchase', 10, 'pack_10', ?), ('k2', 'own', 'purchase', 75, 'pack_75', ?)`)
    .bind(now, now).run();

  const m = await store.boardMetrics();
  assert.equal(m.passRate, 50, 'pass rate is the CUSTOMER rate, untouched by founder tests');
  assert.equal(m.rejected, 1, 'the three founder rejects do not exist on the board');
  assert.equal(m.creditsSold, 10, 'the owner topping up his own account is not a sale');
  assert.equal(m.revenueCents, 1999);
  assert.equal(+m.realCostUsd.toFixed(2), 0.80, 'founder AI burn is not customer cost');
  assert.ok(m.customers.every(c => c.email !== 'kyle@horizonhomemedia.com'),
    'the owner is not listed as his own customer');
  assert.ok(m.failures.every(f => !String(f.address).startsWith('own')),
    'founder rejects stay out of the failures feed');
  assert.equal(m.audit.length, 2, 'the audit trail shows customer jobs only');
});
