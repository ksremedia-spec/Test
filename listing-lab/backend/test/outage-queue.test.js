/**
 * Listing Lab — waiting out someone else's outage.
 *
 * WHY THIS FILE EXISTS
 * On 26 Aug 2026 Google's image model spent over an hour answering every single
 * request with 500 — "gemini-3-pro-image is currently experiencing high demand".
 * It is served from a shared pool; the error is capacity, not quota, so it lands
 * on everybody at once and no paid tier buys past it.
 *
 * The old behaviour was to fail the job, hand the credit back, and show the
 * agent "That one did not finish". Kyle, seeing it: *"We can't be giving it to
 * client."* He is right. The condition resolves itself in minutes; the only
 * thing that made it a customer-visible failure was us giving up on it.
 *
 * So an outage is no longer an outcome. The job is parked, retried, and finished
 * when Google comes back. What these tests hold is the part that has to be exact:
 * the credit is never taken for work that has not happened, the job never
 * silently disappears, and the waiting is bounded — a model that never returns
 * must still end in an honest refund rather than a job that retries forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { sweepRetries } from '../src/worker.js';
import { Store } from '../src/store.js';
import { TRANSFORMATION_COST } from '../src/ledger.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import { CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';
import { readFileSync } from 'node:fs';

const SECRET = 'whsec_test_outage';
const SITE = 'https://listinglab.test';

function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_WEBHOOK_SECRET: SECRET,
    PIPELINE_SECRET: 'pipeline-shared-secret',
    PHOTOS: new TestR2(),
    PIPELINE: {
      dispatched: [],
      idFromName(n) { return n; },
      get() {
        const self = this;
        return { fetch: async (_u, init) => { self.dispatched.push(JSON.parse(init.body)); return new Response('{}', { status: 202 }); } };
      },
    },
  };
}

const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });

const enc = new TextEncoder();
async function stripeHeader(body, ts = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`));
  return `t=${ts},v1=${[...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A signed-in account with 30 credits and one uploaded photo, ready to transform. */
async function ready(env, ctx) {
  const res = await worker.fetch(post('/api/signup', {
    email: 'kyle@horizonhomemedia.test', password: 'a-strong-password-1',
  }), env, ctx);
  const { account } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const pack = CREDIT_PACKS.find(p => p.id === 'pack_30');
  const body = JSON.stringify({
    id: 'evt_outage', type: CREDIT_GRANTING_EVENT,
    data: { object: { id: 'cs_outage', payment_status: 'paid', amount_total: pack.priceCents, currency: 'usd',
                      metadata: { pack_id: 'pack_30', account_id: account.id } } },
  });
  await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  await ctx.settled();

  const { photoId } = await (await worker.fetch(
    new Request(`${SITE}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX }),
    env, ctx)).json();
  const started = await (await worker.fetch(
    post('/api/transform', { photoId, transformation: 'declutter' }, { cookie }), env, ctx)).json();
  await ctx.settled();
  return { cookie, account, photoId, jobId: started.jobId };
}

const outageReport = (jobId, attempt = 1) => new Request(`${SITE}/internal/jobs/${jobId}/result`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
  body: JSON.stringify({
    jobId, outcome: 'error', upstreamDown: true, attemptsUsed: attempt,
    error: 'Gemini 500: {"error":{"message":"gemini-3-pro-image is currently experiencing high demand"}}',
    note: 'The image service is busy right now. Your photo is still queued and we are trying again — nothing has been charged.',
  }),
});

const balanceOf = async (env, ctx, cookie) =>
  (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance;

const statusOf = async (env, ctx, cookie, jobId) =>
  (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();

test('an outage parks the job instead of failing it', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);

  const res = await worker.fetch(outageReport(jobId), env, ctx);
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.parked, true);

  const row = db.db.prepare('SELECT status, finished_at, retry_after, outage_retries FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.finished_at, null, 'a job waiting on Google has not finished');
  assert.equal(row.status, 'queued', 'it is back in the queue, which is what it is');
  assert.equal(row.outage_retries, 1);
  assert.ok(row.retry_after, 'and it knows when to try again');

  const status = await statusOf(env, ctx, cookie, jobId);
  assert.equal(status.waitingOnUpstream, true, 'the agent is told it is still going, not that it broke');
  assert.notEqual(status.status, 'failed');
});

test('nothing is charged and nothing is refunded while it waits', async () => {
  // The credit was taken when the job started and stays taken — this is work
  // that is going to happen. Refunding mid-wait and re-charging later would
  // show the agent a balance that bounces for no reason they can see.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  await worker.fetch(outageReport(jobId), env, ctx);
  assert.equal(await balanceOf(env, ctx, cookie), before, 'the balance does not move while waiting');

  const entries = db.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE job_id = ?').get(jobId);
  assert.equal(entries.c, 1, 'one debit, no refund, no second debit');
});

test('the sweep picks the job back up and hands it to the pipeline again', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await ready(env, ctx);
  env.PIPELINE.dispatched.length = 0;

  await worker.fetch(outageReport(jobId), env, ctx);

  // Not yet due — the sweep must leave it alone.
  assert.equal((await sweepRetries(env, new Store(db))).claimed, 0);
  assert.equal(env.PIPELINE.dispatched.length, 0);

  // Due now.
  db.db.prepare("UPDATE jobs SET retry_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(jobId);
  const swept = await sweepRetries(env, new Store(db));
  assert.equal(swept.claimed, 1);
  assert.equal(env.PIPELINE.dispatched.length, 1, 'the job went back to the container');
  assert.equal(env.PIPELINE.dispatched[0].jobId, jobId);
  assert.ok(env.PIPELINE.dispatched[0].originalUrl, 'with the original photo, exactly as the first time');
});

test('the sweep claims a job once, however many times it runs', async () => {
  // The sweep runs every minute and a dispatch is not instant. Two sweeps
  // overlapping must not send the same job to two containers and pay Google twice.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await ready(env, ctx);
  await worker.fetch(outageReport(jobId), env, ctx);
  db.db.prepare("UPDATE jobs SET retry_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(jobId);
  env.PIPELINE.dispatched.length = 0;

  const [a, b] = [await sweepRetries(env, new Store(db)), await sweepRetries(env, new Store(db))];
  assert.equal(a.claimed + b.claimed, 1, 'claimed exactly once');
  assert.equal(env.PIPELINE.dispatched.length, 1);
});

test('the same dead attempt reported twice does not burn two retries', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await ready(env, ctx);
  await worker.fetch(outageReport(jobId), env, ctx);
  const second = await (await worker.fetch(outageReport(jobId), env, ctx)).json();
  assert.equal(second.alreadyParked, true);
  const row = db.db.prepare('SELECT outage_retries FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.outage_retries, 1, 'one outage, one retry spent');
});

test('the waiting is bounded — a model that never comes back still ends honestly', async () => {
  // The one thing worse than a failure is a job that never resolves. After the
  // window, it fails properly and the credits come back.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  // Stand at the edge of the window, then report one more outage.
  db.db.prepare('UPDATE jobs SET outage_retries = 20 WHERE id = ?').run(jobId);
  await worker.fetch(outageReport(jobId), env, ctx);

  const row = db.db.prepare('SELECT status, finished_at FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'failed');
  assert.ok(row.finished_at, 'it is finished, not left waiting forever');

  const status = await statusOf(env, ctx, cookie, jobId);
  assert.match(status.note, /could not get this one through/);
  assert.ok(!/compliance/i.test(status.note), 'an outage is never reported as a compliance failure');
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter, 'and the credits come back');
});

test('a normal failure is unaffected — it still fails and refunds at once', async () => {
  // The retry queue is for Google being busy and nothing else. A photo that
  // genuinely cannot be processed must not be retried twenty times.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'error', upstreamDown: false, error: 'could not fetch the original photo: 404' }),
  }), env, ctx);

  const row = db.db.prepare('SELECT status, outage_retries FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'failed');
  assert.equal(row.outage_retries, 0, 'never entered the retry queue');
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter);
});

test('a rejection is unaffected — the compliance promise still pays out immediately', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'rejected', note: 'No result passed our compliance checks.' }),
  }), env, ctx);

  const row = db.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'rejected');
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter);
});

test('a delivered job that arrives after a wait is delivered normally', async () => {
  // The point of the whole exercise: Google comes back, the retry succeeds, and
  // the agent gets their photograph as though nothing had happened.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);

  await worker.fetch(outageReport(jobId), env, ctx);
  db.db.prepare("UPDATE jobs SET retry_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(jobId);
  await sweepRetries(env, new Store(db));

  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa('jpeg') } }),
  }), env, ctx);

  const status = await statusOf(env, ctx, cookie, jobId);
  assert.equal(status.status, 'delivered');
  assert.ok(status.resultUrl);
  assert.equal(status.waitingOnUpstream, false, 'no longer waiting once it is in their hands');
});

test('the cron is configured, or the queue is a queue nothing drains', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[triggers\]/, 'no trigger means parked jobs sit forever');
  assert.match(toml, /crons\s*=\s*\[\s*"\* \* \* \* \*"\s*\]/, 'every minute');
  assert.equal(typeof worker.scheduled, 'function', 'and the Worker must export a handler for it');
});


test('a job that says nothing at all is revived, not left spent', async () => {
  // Everything reports back — delivered, rejected, outage, even the container's
  // own hard kill. Silence means the instance went away mid-render, which is
  // exactly what a deploy does. Seen live on 26 Aug 2026: a declutter sat at
  // 'queued' for twenty minutes with the credit spent and nothing to show.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  env.PIPELINE.dispatched.length = 0;

  // A job that is WORKING has a pulse: dispatched five minutes ago, last beat
  // a minute ago — left alone, however long the render takes.
  const fiveAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ?, heartbeat_at = ? WHERE id = ?').run(fiveAgo, fiveAgo, minuteAgo, jobId);
  assert.equal((await sweepRetries(env, new Store(db))).revived, 0, 'a job still working is left alone');

  // Fresh silence with no pulse yet is still the hand-off in progress — one
  // minute old, nothing has had time to beat. Left alone.
  const oneAgo = new Date(Date.now() - 60 * 1000).toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ?, heartbeat_at = NULL WHERE id = ?').run(oneAgo, oneAgo, jobId);
  assert.equal((await sweepRetries(env, new Store(db))).revived, 0, 'a fresh hand-off is left alone');

  // Five minutes and never a single beat is not a slow job — every container
  // beats the instant a run starts. That hand-off died (9 Sep 2026: Kyle's
  // twilight sat "waiting to start" for 12 minutes under the old rule).
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ?, heartbeat_at = NULL WHERE id = ?').run(fiveAgo, fiveAgo, jobId);
  const early = await sweepRetries(env, new Store(db));
  assert.equal(early.revived, 1, 'a job that never pulsed is revived after two minutes');
  assert.equal(env.PIPELINE.dispatched.length, 1, 'and handed off again');
  env.PIPELINE.dispatched.length = 0;
  db.db.prepare('UPDATE jobs SET retry_after = NULL, last_dispatch_at = ? WHERE id = ?').run(fiveAgo, jobId);

  // Thirteen minutes of silence is not work in progress — past the 12-minute
  // staleness line but still inside the 15-minute give-up, so it is revived.
  const longAgo = new Date(Date.now() - 13 * 60 * 1000).toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ? WHERE id = ?').run(longAgo, longAgo, jobId);
  const swept = await sweepRetries(env, new Store(db));
  assert.equal(swept.revived, 1, 'revived');
  assert.equal(swept.claimed, 1, 'and dispatched in the same pass');
  assert.equal(env.PIPELINE.dispatched.length, 1, 'the job is running again');

  const status = await statusOf(env, ctx, cookie, jobId);
  assert.ok(!status.note, 'and the agent was never told it failed');
});

test('a job nothing can save ends honestly rather than being swept forever', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ? WHERE id = ?').run(hourAgo, hourAgo, jobId);
  const out = await sweepRetries(env, new Store(db));
  // Since 3 Sep 2026 the wait cutoff runs first and catches it as timedOut;
  // the silent-job path's own give-up remains behind it.
  assert.equal(out.timedOut + out.abandoned, 1);

  const row = db.db.prepare('SELECT status, finished_at FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'failed');
  assert.ok(row.finished_at);
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter, 'the credits come back');

  // And it is gone from the sweep for good.
  const again = await sweepRetries(env, new Store(db));
  assert.equal(again.abandoned + again.timedOut, 0);
});

test('reviving a lost job does not double-dispatch it', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await ready(env, ctx);
  const longAgo = new Date(Date.now() - 13 * 60 * 1000).toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ? WHERE id = ?').run(longAgo, longAgo, jobId);
  env.PIPELINE.dispatched.length = 0;

  await sweepRetries(env, new Store(db));           // revives and dispatches it
  await sweepRetries(env, new Store(db));           // must not do either again
  await sweepRetries(env, new Store(db));
  assert.equal(env.PIPELINE.dispatched.length, 1, 'one dispatch, one Google bill');
});


test('a run killed on our side is retried, not blamed on the photo', async () => {
  // Live on 26 Aug 2026: a deploy rolled a new image out underneath a twilight
  // and the container process was killed four words into "Building structure
  // manifest". `pipeline exited null` — no exit code, just gone. The agent was
  // told something went wrong while producing their photo. Nothing had gone
  // wrong with their photo; it had not been looked at yet.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({
      jobId, outcome: 'error', upstreamDown: false, retryable: true,
      error: 'pipeline exited null: — Source 2048x1365; rendering at 2K\n— Building structure manifest…\n',
      note: 'That run was interrupted on our side. Your photo is still queued and we are running it again — nothing has been charged.',
    }),
  }), env, ctx);

  const row = db.db.prepare('SELECT status, finished_at, retry_after FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.finished_at, null, 'not finished — it never ran');
  assert.ok(row.retry_after, 'queued to run again');
  assert.equal(await balanceOf(env, ctx, cookie), before, 'and nothing refunded, because nothing is over');

  // Sooner than an outage: there is nothing to wait for, the run just did not happen.
  assert.ok(Date.parse(row.retry_after) - Date.now() < 30_000, 'retried promptly, not in ninety seconds');
});

test('the container and the Worker agree on what is worth retrying', () => {
  // Two lists that drift apart means either a job that retries a hopeless case
  // twenty times, or one that gives up on something that would have worked.
  const src = readFileSync(new URL('../container/server.js', import.meta.url), 'utf8');
  assert.match(src, /const RETRYABLE = new RegExp\(UPSTREAM_DOWN\.source \+/,
    'RETRYABLE must be built FROM the outage pattern, so widening one widens both');
  assert.match(src, /pipeline exited null/, 'a killed process is retryable');
  for (const notRetryable of ['compliance', 'must be one of']) {
    assert.ok(!new RegExp(notRetryable).test(src.slice(src.indexOf('const RETRYABLE'), src.indexOf('const RETRYABLE') + 300)),
      `${notRetryable} will fail identically in ninety seconds — retrying it spends the customer's day`);
  }
  const w = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(w, /body\.retryable \?\? body\.upstreamDown/,
    'the Worker reads the wider flag, and still understands an older container');
});

test('a container that will not take the job queues it, rather than refunding', async () => {
  // Live on 26 Aug 2026, minutes after a deploy: two jobs were refused at
  // dispatch and refunded while the container image was healthy and answering
  // /health locally. A cold start, a restart, or a brief instance shortage is
  // the most transient condition in the system — telling an agent "we could not
  // start that job" because Cloudflare was two seconds from ready is a failure
  // invented entirely by us.
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  // Now make the container refuse everything, and drive a retry through it.
  env.PIPELINE.get = () => ({ fetch: async () => { throw new Error('Container suspended'); } });
  db.db.prepare("UPDATE jobs SET retry_after = '2000-01-01T00:00:00.000Z', status = 'queued' WHERE id = ?").run(jobId);
  await sweepRetries(env, new Store(db));

  const row = db.db.prepare('SELECT status, finished_at, retry_after FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.finished_at, null, 'not failed — the container was simply not ready');
  assert.ok(row.retry_after, 'queued to try again shortly');
  assert.equal(await balanceOf(env, ctx, cookie), before, 'and nothing refunded, because nothing is over');
});

test('but a container that never takes it does eventually give up and refund', async () => {
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  env.PIPELINE.get = () => ({ fetch: async () => { throw new Error('Container suspended'); } });
  db.db.prepare("UPDATE jobs SET retry_after = '2000-01-01T00:00:00.000Z', status = 'queued', outage_retries = 20 WHERE id = ?").run(jobId);
  await sweepRetries(env, new Store(db));

  const row = db.db.prepare('SELECT status, finished_at FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'failed');
  assert.ok(row.finished_at);
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter, 'the credits come back');
});

test('a container already at capacity sends the job back to the queue', async () => {
  // Kyle's scenario: three agents, five virtual stagings each, all at once.
  // Fifteen jobs across four container slots used to mean four transform
  // processes per instance, each firing three staging candidates — an
  // out-of-memory kill and a self-inflicted 429 storm. The container now refuses
  // past its limit, and a refusal is not a failure: the job goes back to the
  // durable queue rather than being started somewhere it cannot finish.
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  env.PIPELINE.get = () => ({
    fetch: async () => new Response(JSON.stringify({ busy: true, inFlight: 2 }), { status: 503 }),
  });
  db.db.prepare("UPDATE jobs SET retry_after = '2000-01-01T00:00:00.000Z', status = 'queued' WHERE id = ?").run(jobId);
  await sweepRetries(env, new Store(db));

  const row = db.db.prepare('SELECT status, finished_at, retry_after, last_dispatch_at FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.finished_at, null, 'busy is not a failure');
  assert.ok(row.retry_after, 'it waits for a free slot');
  assert.equal(await balanceOf(env, ctx, cookie), before, 'and nothing is charged for work not started');
});

test('a 202 is still a real dispatch and gets stamped', async () => {
  // The busy check must not swallow the normal path — if last_dispatch_at stops
  // being written, the reaper measures silence from creation and revives healthy
  // jobs out from under themselves.
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  const { jobId } = await ready(env, ctx);
  const row = db.db.prepare('SELECT last_dispatch_at FROM jobs WHERE id = ?').get(jobId);
  assert.ok(row.last_dispatch_at, 'an accepted job records when it was handed over');
});

test('the container caps how much it takes on, and refuses the rest', () => {
  const src = readFileSync(new URL('../container/server.js', import.meta.url), 'utf8');
  assert.match(src, /MAX_CONCURRENT_JOBS \|\| 2/);
  assert.match(src, /if \(inFlight >= MAX_CONCURRENT_JOBS\)/, 'checked before any work starts');
  assert.match(src, /res\.writeHead\(503/, 'and refused with a status the Worker can act on');
  // The counter must come back down however the job ends, or the instance
  // silently stops accepting work for the rest of its life.
  assert.match(src, /\.finally\(\(\) => \{ inFlight--; exitIfDrained\(\); \}\)/,
    'decremented on failure as well as success (and the drain check rides along)');
  const w = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(w, /handed\.status === 503/, 'and the Worker treats busy as "try again", not "broken"');
});

test('the wait cutoff covers the retry queue too: an old parked job is refunded, not redispatched', async () => {
  // Beta, 31 Aug 2026: a client's declutter showed "working" for over an hour.
  // The give-up age only guarded the silent-job path — a job actively cycling
  // the outage queue could park and retry for 20 rounds, 1.5–2 hours of wall
  // clock, without ever crossing a cutoff. The sweep now ends anything past the
  // give-up age before dispatching it again.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);
  env.PIPELINE.dispatched.length = 0;

  const oldCreated = new Date(Date.now() - 41 * 60_000).toISOString();
  db.db.prepare("UPDATE jobs SET created_at = ?, retry_after = '2000-01-01T00:00:00.000Z', status = 'queued', outage_retries = 5 WHERE id = ?")
    .run(oldCreated, jobId);
  await sweepRetries(env, new Store(db));

  const row = db.db.prepare('SELECT status, finished_at FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'failed', 'past the give-up age the job ends');
  assert.ok(row.finished_at, 'and it is finished, not parked again');
  assert.equal(env.PIPELINE.dispatched.length, 0, 'no twenty-first attempt is started');
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter, 'the credits come back');
});

test('an outage report on a job past the give-up age refunds instead of parking', async () => {
  // The other half of the same cutoff: when the container reports "Google is
  // busy" for a job that is already past the give-up age, parking it for another
  // round would restart the same 1.5-hour grind. It ends there instead.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await ready(env, ctx);
  const before = await balanceOf(env, ctx, cookie);

  const oldCreated = new Date(Date.now() - 41 * 60_000).toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(oldCreated, jobId);

  const res = await worker.fetch(outageReport(jobId, 3), env, ctx);
  assert.equal(res.status, 200);

  const row = db.db.prepare('SELECT status, finished_at, retry_after FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'failed', 'no more parking past the cutoff');
  assert.ok(row.finished_at);
  assert.equal(row.retry_after, null, 'and nothing is queued to retry');
  assert.equal(await balanceOf(env, ctx, cookie), before + TRANSFORMATION_COST.declutter, 'the credits come back');
});

test('outage parks are jittered so parked jobs do not come due in the same sweep', async () => {
  // Two jobs parked in the same outage minute used to come due in the same
  // minute forever — redispatched together, re-tripping a per-minute rate limit
  // together. The park spacing now carries up to 45s of jitter.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await ready(env, ctx);

  await worker.fetch(outageReport(jobId), env, ctx);
  const row = db.db.prepare('SELECT retry_after FROM jobs WHERE id = ?').get(jobId);
  const delay = Date.parse(row.retry_after) - Date.now();
  assert.ok(delay >= 85_000, `an outage wait is at least the base spacing (got ${Math.round(delay / 1000)}s)`);
  assert.ok(delay <= 140_000, `and no more than base plus jitter (got ${Math.round(delay / 1000)}s)`);
});
