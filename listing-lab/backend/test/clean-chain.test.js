/**
 * The clean-copy chain (1 Sep 2026).
 *
 * "Stage this room" used to download the delivered JPEG — disclosure stamp
 * baked into the corner — and re-upload it as the next job's original. The
 * model sometimes redrew that stamp under the fresh one, and a garbled double
 * watermark reached a real delivery on 31 Aug. The fix is mechanical, not
 * persuasive: the pipeline ships a pre-watermark frame beside every delivery,
 * the Worker stores it where no customer route serves it, and chained edits
 * start from that clean frame via a server-side copy.
 *
 * These tests pin the three promises that make it safe:
 *   1. the clean copy is stored, and used as the chained edit's source
 *   2. the clean copy is NEVER served to a customer — every image a customer
 *      can reach carries exactly one disclosure stamp
 *   3. deliveries from before clean copies existed still chain (stamped
 *      fallback), and other accounts' jobs stay invisible
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import { CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';

const SITE = 'https://listinglab.test';
const SECRET = 'whsec_test';

function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: SECRET,
    PIPELINE_SECRET: 'pipeline-shared-secret',
    PHOTOS: new TestR2(),
    ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) },
    PIPELINE: {
      dispatched: [],
      idFromName(n) { return n; },
      get(id) {
        const self = this;
        return { fetch: async (_url, init) => { self.dispatched.push(JSON.parse(init.body)); return new Response('{}', { status: 202 }); } };
      },
    },
  };
}

const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

const post = (path, body, headers = {}) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });

async function signedIn(env, ctx, email = 'kyle@horizonhomemedia.test') {
  const res = await worker.fetch(post('/api/signup', { email, password: 'hunter2hunter2' }), env, ctx);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const { account } = await (await worker.fetch(get('/api/me', { cookie }), env, ctx)).json();
  return { cookie, account };
}

const enc = new TextEncoder();
async function stripeHeader(body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${ts},v1=${hex}`;
}
const checkoutEvent = (accountId, { eventId = 'evt_1', sessionId = 'cs_1', packId = 'pack_30', amount = 5699 } = {}) =>
  JSON.stringify({
    id: eventId,
    type: CREDIT_GRANTING_EVENT,
    data: { object: { id: sessionId, payment_status: 'paid', amount_total: amount, currency: 'usd',
                      metadata: { pack_id: packId, account_id: accountId } } },
  });
async function fund(env, ctx, accountId, sessionId = 'cs_fund', packId = 'pack_30') {
  const pack = CREDIT_PACKS.find(p => p.id === packId);
  const body = checkoutEvent(accountId, { eventId: `evt_${sessionId}`, sessionId, packId, amount: pack.priceCents });
  await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  await ctx.settled();
}

const uploadReq = (headers = {}) =>
  new Request(`${SITE}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/png', ...headers }, body: PNG_1PX });

async function deliveredJob(env, ctx, cookie, { withClean }) {
  const { photoId } = await (await worker.fetch(uploadReq({ cookie }), env, ctx)).json();
  const { jobId } = await (await worker.fetch(
    post('/api/transform', { photoId, transformation: 'empty' }, { cookie }), env, ctx)).json();
  await ctx.settled();
  await worker.fetch(new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' },
    body: JSON.stringify({
      jobId, outcome: 'delivered', attemptsUsed: 1,
      image: { filename: 'r.jpg', base64: btoa('stamped-bytes') },
      ...(withClean ? { cleanImage: { base64: btoa('clean-bytes') } } : {}),
    }),
  }), env, ctx);
  return { jobId, photoId };
}

test('the chained edit starts from the CLEAN frame, which no customer route serves', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await deliveredJob(env, ctx, cookie, { withClean: true });

  // 1. Stored beside the result.
  const cleanKeys = [...env.PHOTOS.objects.keys()].filter(k => k.endsWith('-result-clean.jpg'));
  assert.equal(cleanKeys.length, 1, 'exactly one clean copy per delivery');

  // 2. Never served — not inline, not as a download.
  const served = await worker.fetch(get(`/api/photos/${encodeURIComponent(cleanKeys[0])}`, { cookie }), env, ctx);
  assert.equal(served.status, 404, 'the unstamped frame must be unreachable by customers');
  const dl = await worker.fetch(get(`/api/photos/${encodeURIComponent(cleanKeys[0])}?download=1`, { cookie }), env, ctx);
  assert.equal(dl.status, 404, 'the download flag is not a way around it');

  // 3. from-job copies the clean bytes into the new starting photo.
  const res = await worker.fetch(post('/api/photos/from-job', { jobId }, { cookie }), env, ctx);
  assert.equal(res.status, 201);
  const out = await res.json();
  const bytes = await worker.fetch(get(out.url, { cookie }), env, ctx);
  assert.equal(await bytes.text(), 'clean-bytes', 'the next job starts from the unstamped frame');
  db.close();
});

test('a delivery from before clean copies existed still chains — stamped fallback', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await deliveredJob(env, ctx, cookie, { withClean: false });

  const res = await worker.fetch(post('/api/photos/from-job', { jobId }, { cookie }), env, ctx);
  assert.equal(res.status, 201, 'no clean copy is the old world, not an error');
  const out = await res.json();
  const bytes = await worker.fetch(get(out.url, { cookie }), env, ctx);
  assert.equal(await bytes.text(), 'stamped-bytes', 'exactly what the old flow uploaded');
  db.close();
});

test("someone else's job cannot become my photo, and an unfinished job cannot either", async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await deliveredJob(env, ctx, cookie, { withClean: true });

  const { cookie: other } = await signedIn(env, ctx, 'other@example.com');
  const theft = await worker.fetch(post('/api/photos/from-job', { jobId }, { cookie: other }), env, ctx);
  assert.equal(theft.status, 404, "same 404 as a job that doesn't exist");

  // A queued job of my own is refused politely.
  const { photoId } = await (await worker.fetch(uploadReq({ cookie }), env, ctx)).json();
  const { jobId: queued } = await (await worker.fetch(
    post('/api/transform', { photoId, transformation: 'empty' }, { cookie }), env, ctx)).json();
  const early = await worker.fetch(post('/api/photos/from-job', { jobId: queued }, { cookie }), env, ctx);
  assert.equal(early.status, 422);
  db.close();
});

test('the pieces stay wired: app uses from-job, container ships the clean frame, pipeline writes it', () => {
  const app = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  const stageClicks = app.match(/\/api\/photos\/from-job/g) || [];
  assert.equal(stageClicks.length, 2, 'both Stage-this-room buttons go through the server-side copy');
  // The two screens hold differently-shaped job objects: /api/jobs/:id says
  // jobId, the list items say id. Sending only .id put undefined on the wire
  // and the server said 'no such job' (Kyle, 1 Sep 2026). Both sites must
  // accept either shape.
  assert.equal((app.match(/jobId: j(ob)?\.jobId \|\| j(ob)?\.id/g) || []).length, 2,
    'both buttons read jobId-or-id, whichever shape the screen holds');
  assert.ok(!/const blob = await \(await fetch\(j(ob)?\.resultUrl\)\)\.blob\(\)/.test(app),
    'no button re-uploads the stamped delivery any more');

  const server = readFileSync(new URL('../container/server.js', import.meta.url), 'utf8');
  assert.match(server, /\.approved\.clean\.jpg/, 'the container looks for the clean frame');
  assert.match(server, /cleanImage/, 'and ships it in the callback');

  const t = readFileSync(new URL('../pipeline/transform.js', import.meta.url), 'utf8');
  // The pipeline delivers through FOUR separate sites (staging ranking, masked
  // composite, best-of-passers, classic single). The first version of this fix
  // patched only one of them and empties chained stamped for another hour —
  // so pin the count of delivery sites to the count of clean writes.
  const deliverySites = (t.match(/`\$\{stem\}\.\$\{tag\}\.approved\.jpg`/g) || []).length;
  const cleanWrites = (t.match(/\.approved\.clean\.jpg/g) || []).length;
  assert.equal(deliverySites, 4, `delivery sites moved — re-audit the clean-copy writes (found ${deliverySites})`);
  assert.ok(cleanWrites >= deliverySites, `every delivery site must write the clean frame (${cleanWrites}/${deliverySites})`);
});
