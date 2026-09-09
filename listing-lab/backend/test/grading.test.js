/**
 * Listing Lab — grading, and keeping the evidence to grade.
 *
 * WHY THIS EXISTS
 * The pass rate has been measured on six photographs, one of which had a
 * pathological corner that produced a third of all the day's complaints. That is
 * not a measurement, and every change made on the strength of it was a guess.
 *
 * Two things had to be true before sixty photographs could settle it. Rejected
 * frames had to survive — until now one lived and died in a container's temp
 * directory, so a rejection was a sentence with no evidence behind it. And
 * grading sixty of them had to take minutes rather than an evening, because the
 * thing that kills a golden set is photograph twenty-three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import { CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';

const SECRET = 'whsec_test_grading';
const DIAG = 'diag-secret-for-grading';
const SITE = 'https://listinglab.test';
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

const makeEnv = db => ({
  DB: db, SITE_URL: SITE, STRIPE_WEBHOOK_SECRET: SECRET, DIAG_SECRET: DIAG,
  PIPELINE_SECRET: 'pipeline-shared-secret', PHOTOS: new TestR2(),
  PIPELINE: { idFromName: n => n, get: () => ({ fetch: async () => new Response('{}', { status: 202 }) }) },
});
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

async function readyJob(env, ctx, transformation = 'declutter') {
  const res = await worker.fetch(post('/api/signup', { email: `k${Math.random()}@t.test`, password: 'a-strong-password-1' }), env, ctx);
  const { account } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const pack = CREDIT_PACKS.find(p => p.id === 'pack_30');
  const body = JSON.stringify({
    id: `evt_${account.id}`, type: CREDIT_GRANTING_EVENT,
    data: { object: { id: `cs_${account.id}`, payment_status: 'paid', amount_total: pack.priceCents, currency: 'usd',
                      metadata: { pack_id: 'pack_30', account_id: account.id } } },
  });
  await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  await ctx.settled();
  const { photoId } = await (await worker.fetch(new Request(`${SITE}/api/photos`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX }), env, ctx)).json();
  const { jobId } = await (await worker.fetch(post('/api/transform', { photoId, transformation }, { cookie }), env, ctx)).json();
  await ctx.settled();
  return { cookie, jobId };
}

const callback = (jobId, body) => new Request(`${SITE}/internal/jobs/${jobId}/result`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
  body: JSON.stringify(body),
});

test('a rejected job keeps the frame it produced', async () => {
  // Until now the frame lived in a container temp directory and was deleted with
  // it, so "nothing passed our compliance checks" was a claim nobody could check.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, jobId } = await readyJob(env, ctx);

  await worker.fetch(callback(jobId, {
    jobId, outcome: 'rejected', note: 'No result passed our compliance checks.',
    rejectedImage: { filename: 'a1.jpg', base64: btoa('the-frame-we-would-not-ship') },
  }), env, ctx);

  const row = db.db.prepare('SELECT status, result_key, reject_key FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.result_key, null, 'a rejected frame is NOT a result');
  assert.ok(row.reject_key, 'but it is kept');
  assert.ok([...env.PHOTOS.objects.keys()].includes(row.reject_key), 'and actually written to storage');

  // The customer's own view must not offer it as a finished photo.
  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.equal(status.resultUrl, null, 'never rendered as a result');
  const list = await (await worker.fetch(get('/api/jobs', { cookie }), env, ctx)).json();
  assert.equal(list.jobs[0].resultUrl, null);
  assert.ok(list.jobs[0].rejectUrl, 'a separate field entirely, so nothing can confuse the two');
  db.close();
});

test('a delivered job still stores exactly one image, as a result', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await readyJob(env, ctx);
  await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa('shipped') },
  }), env, ctx);
  const row = db.db.prepare('SELECT result_key, reject_key FROM jobs WHERE id = ?').get(jobId);
  assert.ok(row.result_key);
  assert.equal(row.reject_key, null);
  db.close();
});

/* ------------------------------------------------------------------ grading */

const grader = (p, init) => new Request(`${SITE}${p}${p.includes('?') ? '&' : '?'}s=${DIAG}`, init);

test('the grading queue holds rejections as well as deliveries', async () => {
  // A set of only the jobs that passed measures nothing except how often we
  // agree with ourselves. The rejections are the half that says what the
  // strictness is costing.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const a = await readyJob(env, ctx, 'declutter');
  const b = await readyJob(env, ctx, 'twilight');
  await worker.fetch(callback(a.jobId, { jobId: a.jobId, outcome: 'delivered', image: { filename: 'r.jpg', base64: btoa('ok') } }), env, ctx);
  await worker.fetch(callback(b.jobId, { jobId: b.jobId, outcome: 'rejected', note: 'camera moved',
    rejectedImage: { filename: 'a1.jpg', base64: btoa('nope') } }), env, ctx);

  const { jobs } = await (await worker.fetch(grader('/internal/grade/jobs'), env, ctx)).json();
  assert.equal(jobs.length, 2);
  const rejected = jobs.find(j => j.systemVerdict === 'rejected');
  assert.ok(rejected.afterUrl, 'the rejected frame is viewable, or it cannot be graded');
  assert.ok(rejected.beforeUrl, 'alongside the original it came from');
  assert.equal(rejected.myVerdict, null, 'nobody has graded it yet');
  db.close();
});

test('a grade is saved, and re-grading replaces it rather than duplicating', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await readyJob(env, ctx);
  await worker.fetch(callback(jobId, { jobId, outcome: 'delivered', image: { filename: 'r.jpg', base64: btoa('ok') } }), env, ctx);

  await worker.fetch(grader(`/internal/grade/${jobId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'fail', note: 'chair gone' }) }), env, ctx);
  await worker.fetch(grader(`/internal/grade/${jobId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'pass', note: 'looked again, fine' }) }), env, ctx);

  const rows = db.db.prepare('SELECT verdict, note FROM grades WHERE job_id = ?').all(jobId);
  assert.equal(rows.length, 1, 'one verdict per job, not a history');
  assert.equal(rows[0].verdict, 'pass');
  assert.equal(rows[0].note, 'looked again, fine');
  db.close();
});

test('the verdict vocabulary is closed', async () => {
  // 'wrong_job' is deliberately separate from 'fail': a bad classification and a
  // bad result are different failures with different fixes, and one button for
  // both would blur them into a number nobody can act on.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { jobId } = await readyJob(env, ctx);
  await worker.fetch(callback(jobId, { jobId, outcome: 'delivered', image: { filename: 'r.jpg', base64: btoa('ok') } }), env, ctx);

  for (const verdict of ['pass', 'fail', 'wrong_job']) {
    const res = await worker.fetch(grader(`/internal/grade/${jobId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict }) }), env, ctx);
    assert.equal(res.status, 200, verdict);
  }
  const bad = await worker.fetch(grader(`/internal/grade/${jobId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'maybe' }) }), env, ctx);
  assert.equal(bad.status, 400);
  db.close();
});

test('without the secret the grader does not exist', async () => {
  // It reaches across every account by design, because it measures the system
  // rather than serving a customer. A signed-in session must not be enough.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  for (const path of ['/internal/grade', '/internal/grade/jobs', '/internal/grade/photo?k=x']) {
    const res = await worker.fetch(get(`${SITE}${path}`.replace(SITE, '')), env, ctx);
    assert.ok(res.status === 404 || res.status === 401, `${path} gave ${res.status}`);
  }
  const wrong = await worker.fetch(get('/internal/grade?s=not-the-secret'), env, ctx);
  assert.ok(wrong.status === 404 || wrong.status === 401);
  db.close();
});

test('the page hides our verdict until he has given his', () => {
  // The whole value is the disagreement. Showing "we rejected this" before he
  // looks anchors the answer, and an anchored grade measures nothing except how
  // persuasive our own label is.
  const src = readFileSync(new URL('../src/grader.js', import.meta.url), 'utf8');
  assert.match(src, /anchors the answer/,
    'the intent is documented where someone would otherwise "helpfully" surface it');
  const render = src.slice(src.indexOf('function render(){'), src.indexOf('function wireSlider'));
  assert.ok(!/systemVerdict/.test(render), 'the question screen must not mention what we decided');
  assert.ok(!/systemNote/.test(render));
  const grade = src.slice(src.indexOf('async function grade('), src.indexOf('function renderDone'));
  assert.match(grade, /systemVerdict/, 'it is revealed afterwards, where a disagreement is interesting');
});

test('grading sixty photographs is sixty keystrokes', () => {
  // The bottleneck is not the photographs, it is photograph twenty-three.
  const src = readFileSync(new URL('../src/grader.js', import.meta.url), 'utf8');
  assert.match(src, /keydown/, 'keyboard shortcuts');
  assert.match(src, /if \(e\.target\.tagName === 'INPUT'\) return;/, 'that do not fire while typing a note');
  assert.match(src, /jobs\.sort\(\(a,b\) => \(a\.myVerdict\?1:0\) - \(b\.myVerdict\?1:0\)\)/,
    'ungraded first, so nothing stands between him and the next unanswered job');
  assert.match(src, /api\('\/internal\/grade\/'/, 'saved on the button press, not at the end');
});
