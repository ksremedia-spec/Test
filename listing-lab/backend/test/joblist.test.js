/**
 * Listing Lab — the list of what an agent has run.
 *
 * WHY THIS FILE EXISTS
 * The app was built around one photograph at a time, and the only place a result
 * ever appeared was the screen watching the job. Close the tab and the finished
 * photograph still existed — stored, paid for, permanent — with nowhere to see
 * it from.
 *
 * Kyle, describing the workflow he actually wants: queue three or four images,
 * "close their phone, come back to it a couple minutes later, and they're all
 * done." The server half already worked. This is the half that was missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import { CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';

const SECRET = 'whsec_test_joblist';
const SITE = 'https://listinglab.test';
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

function makeEnv(db) {
  return {
    DB: db, SITE_URL: SITE, STRIPE_WEBHOOK_SECRET: SECRET,
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

async function startJob(env, ctx, cookie, transformation = 'declutter', extra = {}) {
  const { photoId } = await (await worker.fetch(new Request(`${SITE}/api/photos`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX,
  }), env, ctx)).json();
  const out = await (await worker.fetch(
    post('/api/transform', { photoId, transformation, ...extra }, { cookie }), env, ctx)).json();
  await ctx.settled();
  return { ...out, photoId };
}

const listJobs = async (env, ctx, cookie) =>
  (await (await worker.fetch(get('/api/jobs', { cookie }), env, ctx)).json()).jobs;

test('an agent can see everything they have run, newest first', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await account(env, ctx, 'kyle@horizonhomemedia.test');

  const a = await startJob(env, ctx, cookie, 'declutter');
  const b = await startJob(env, ctx, cookie, 'twilight', { style: 'Dusk' });
  const c = await startJob(env, ctx, cookie, 'staging', { style: 'Coastal', roomType: 'Living Room' });

  const jobs = await listJobs(env, ctx, cookie);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map(j => j.jobId), [c.jobId, b.jobId, a.jobId], 'newest first');
  assert.deepEqual(jobs.map(j => j.transformation), ['staging', 'twilight', 'declutter']);
  assert.equal(jobs[0].roomType, 'Living Room', 'staging keeps its options, so the list can say what was asked for');
  db.close();
});

test('every job carries a picture to show — the original, and the result when there is one', async () => {
  // A list of finished work is useless without something to look at, and a job
  // row on its own has only a photo id in it.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account: acct } = await account(env, ctx, 'kyle@horizonhomemedia.test');
  const { jobId } = await startJob(env, ctx, cookie);

  let jobs = await listJobs(env, ctx, cookie);
  assert.ok(jobs[0].originalUrl, 'the uploaded photo, so the row is recognisable while it runs');
  assert.equal(jobs[0].resultUrl, null, 'nothing finished yet');

  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa('jpeg') } }),
  }), env, ctx);

  jobs = await listJobs(env, ctx, cookie);
  assert.equal(jobs[0].status, 'delivered');
  assert.ok(jobs[0].resultUrl, 'and now the finished photograph, reachable after closing the app');
  assert.ok(jobs[0].finishedAt);
  db.close();
});

test('a job waiting on an outage reads as still going, not as broken', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await account(env, ctx, 'kyle@horizonhomemedia.test');
  const { jobId } = await startJob(env, ctx, cookie);

  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'error', upstreamDown: true, retryable: true, error: 'Gemini 500: high demand' }),
  }), env, ctx);

  const jobs = await listJobs(env, ctx, cookie);
  assert.equal(jobs[0].waitingOnUpstream, true);
  assert.equal(jobs[0].finishedAt, null, 'nothing has finished, so the list must not say it has');
  db.close();
});

test('one account never sees another account\'s work', async () => {
  // The list is a new way to ask "what exists", and a new way to ask is a new
  // way to ask about someone else's photographs.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const mine = await account(env, ctx, 'mine@example.test');
  const theirs = await account(env, ctx, 'theirs@example.test');
  await startJob(env, ctx, mine.cookie, 'declutter');
  await startJob(env, ctx, mine.cookie, 'twilight', { style: 'Dusk' });

  assert.equal((await listJobs(env, ctx, mine.cookie)).length, 2);
  assert.equal((await listJobs(env, ctx, theirs.cookie)).length, 0, 'a different account sees nothing of it');
  db.close();
});

test('signed out, the list is not readable at all', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(get('/api/jobs'), env, ctx);
  assert.equal(res.status, 401);
  db.close();
});

/* --------------------------------------------------- the screens themselves */

import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');

test('the file picker takes more than one photo', () => {
  // The whole batch workflow starts here. Without `multiple`, an agent picks one
  // photo, waits, picks another — the exact loop Kyle wanted gone.
  // (The accept list itself is pinned in config.test.js, HEIC included since
  // 31 Aug 2026 — this test only guards `multiple`.)
  assert.match(html, /<input type="file" id="file" accept="[^"]*" multiple>/);
  assert.ok(!/capture=/.test(html),
    'and still no capture attribute — on iOS that hides the camera roll entirely, ' +
    'which is where an agent\'s photos actually are');
});

test('one photo keeps the single-photo flow, several get the batch screen', () => {
  // A list of one is worse than the progress steps and the before/after slider.
  // Two paths only where the two paths are genuinely better.
  assert.match(html, /if \(state\.batch\.length === 1\) \{/);
  assert.match(html, /show\(\$\('batchCard'\), true\)/);
});

test('photos upload one at a time, not all at once', () => {
  // A phone on a listing's driveway is not on good wifi, and each upload runs a
  // vision call. Five parallel uploads on 5G is five timeouts, not five photos.
  const fn = html.slice(html.indexOf('async function uploadPhotos'), html.indexOf('function failUpload'));
  assert.match(fn, /for \(const file of good\) \{/, 'sequential');
  assert.ok(!/Promise\.all/.test(fn), 'never all at once');
  assert.match(fn, /bad\.push/, 'and one bad file does not sink the batch');
});

test('the batch screen offers each photo only what that photo allows', () => {
  // The batch screen is a different way in, not a different rulebook — an
  // already-furnished room must not be offered staging just because it arrived
  // in a group.
  const fn = html.slice(html.indexOf('function renderBatch'), html.indexOf('const batchChosen'));
  assert.match(fn, /item\.photo\?\.offers \|\|/, 'per-photo offers, same as the single flow');
  assert.match(fn, /Skip this one/, 'and a way to drop one without starting over');
});

test('the cost is checked before the agent waits, not after', () => {
  // Otherwise some of a batch starts and the rest bounce off the server with an
  // error the agent sees one photo at a time.
  const fn = html.slice(html.indexOf('function updateBatchButton'), html.indexOf("$('batchCancel')"));
  assert.match(fn, /cost > state\.balance/);
  assert.match(fn, /Not enough credits/);
});

test('the queue screen exists and is reachable at any time', () => {
  // This is the piece that makes "close your phone and come back" real. The
  // server side already worked; there was nowhere to come back TO.
  assert.match(html, /id="queueCard"/);
  assert.match(html, /id="queueBtn">My photos</, 'reachable from the header, not only after a batch');
  assert.match(html, /\$\('queueBtn'\)\.onclick = \(\) => openQueue\(\)/);
  assert.match(html, /show\(\$\('queueBtn'\), true\)/, 'and shown once signed in');
});

test('the queue stops polling when nothing is running', () => {
  // A finished list does not need refreshing, and a phone left on this screen
  // should not sit asking every few seconds all afternoon.
  const fn = html.slice(html.indexOf('function startQueueWatch'), html.indexOf('function stopQueueWatch'));
  assert.match(fn, /if \(!busy\) stopQueueWatch\(\)/);
});

test('a network blip does not blank the queue', () => {
  // Returning an empty list on a failed fetch would tell an agent their photos
  // had vanished.
  const fn = html.slice(html.indexOf('async function refreshQueue'), html.indexOf('function startQueueWatch'));
  assert.match(fn, /catch \{ return false; \}/);
  assert.ok(fn.indexOf('catch { return false; }') < fn.indexOf("queueRows').innerHTML = ''"),
    'the failure path must return before anything is cleared');
});

test('a busy image service reads differently from a broken job', () => {
  const fn = html.slice(html.indexOf('async function refreshQueue'), html.indexOf('function startQueueWatch'));
  assert.match(fn, /waitingOnUpstream/);
  assert.match(fn, /nothing charged/);
});

test('what the agent types is escaped before it becomes HTML', () => {
  // File names come from the agent's phone and go straight into the batch list.
  assert.match(html, /function escapeHtml\(s\)\{/);
  assert.match(html, /\$\{escapeHtml\(item\.name\)\}/, 'file names are escaped');
});

test('a job that is running says so, instead of "waiting to start"', async () => {
  // Nothing on the normal path ever moved a job off 'queued' — `claimAttempt`
  // sets 'running' and is dead code. It went unnoticed because until the queue
  // screen existed nobody looked at a job's status while it ran; the single-job
  // page had its own progress bar. An agent would have watched "Waiting to
  // start" for three minutes and then seen it jump to done.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await account(env, ctx, 'kyle@horizonhomemedia.test');
  const { jobId } = await startJob(env, ctx, cookie);

  const jobs = await listJobs(env, ctx, cookie);
  assert.equal(jobs[0].status, 'running', 'handed to a container means running');

  // And finishing still wins over it.
  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'rejected', note: 'No result passed our compliance checks.' }),
  }), env, ctx);
  assert.equal((await listJobs(env, ctx, cookie))[0].status, 'rejected');
  db.close();
});

test('marking a job running never resurrects a finished one', () => {
  // A late dispatch stamp landing after the result came back would flip a
  // delivered job to running and lose the customer their photograph.
  const src = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  // 600 chars, not 300 — the heartbeat-reset comment (1 Sep 2026) pushed the
  // WHERE clause past the old window and false-failed this pin.
  const fn = src.slice(src.indexOf('async markDispatched'), src.indexOf('async markDispatched') + 600);
  assert.match(fn, /AND finished_at IS NULL/);
});

/**
 * THE WHOLE SET IN ONE FILE (9 Sep 2026, Kyle: "group download from the My
 * Photos page"). The chosen finished results come back as one ZIP; other
 * people's jobs and unfinished ones are left out without a word.
 */
async function deliver(env, ctx, jobId, bytes) {
  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({ jobId, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa(bytes) } }),
  }), env, ctx);
}
function zipNames(buf) {
  // Walk the central directory: entry signature 0x02014b50, name at +46.
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (v.getUint32(i, true) !== 0x02014b50) continue;
    const n = v.getUint16(i + 28, true);
    names.push(new TextDecoder().decode(buf.subarray(i + 46, i + 46 + n)));
    i += 45 + n;
  }
  return names;
}

test('the chosen finished photos come back as one ZIP, and only mine', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await account(env, ctx, 'kyle@horizonhomemedia.test');
  const other = await account(env, ctx, 'someone@else.test');

  const a = await startJob(env, ctx, cookie, 'twilight', { style: 'Dusk' });
  const b = await startJob(env, ctx, cookie, 'declutter');
  const c = await startJob(env, ctx, cookie, 'twilight', { style: 'Dusk' });   // never finishes
  const theirs = await startJob(env, ctx, other.cookie, 'twilight', { style: 'Dusk' });
  await deliver(env, ctx, a.jobId, 'first-jpeg');
  await deliver(env, ctx, b.jobId, 'second-jpeg');
  await deliver(env, ctx, theirs.jobId, 'not-yours');

  const res = await worker.fetch(get(`/api/jobs/zip?ids=${a.jobId},${b.jobId},${c.jobId},${theirs.jobId}`, { cookie }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="listing-lab-\d{4}-\d{2}-\d{2}\.zip"/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.equal(new DataView(buf.buffer).getUint32(0, true), 0x04034b50, 'it is a ZIP');
  assert.deepEqual(zipNames(buf), ['listing-lab-01-twilight.jpg', 'listing-lab-02-declutter.jpg'],
    'mine, finished, in the order I picked them — the unfinished one and the stranger\'s left out');
  assert.ok(new TextDecoder().decode(buf).includes('first-jpeg'), 'with the actual bytes inside');
  assert.ok(!new TextDecoder().decode(buf).includes('not-yours'), 'and never anyone else\'s');

  // Nothing pickable at all is a plain answer, not an empty archive.
  const none = await worker.fetch(get(`/api/jobs/zip?ids=${c.jobId},${theirs.jobId}`, { cookie }), env, ctx);
  assert.equal(none.status, 404);
  const empty = await worker.fetch(get('/api/jobs/zip', { cookie }), env, ctx);
  assert.equal(empty.status, 400);
  db.close();
});
