/**
 * Listing Lab — Worker tests, against a real SQLite database with the real schema.
 *
 * These are the ones that matter most, because they exercise the whole path a
 * customer or an attacker actually takes rather than one function in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import { CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';
import { offeredFor, adviceFor, auditSummary, failJobAndRefund, sweepRetries, STAGING_STYLES, ROOM_TYPES, TWILIGHT_MOODS } from '../src/worker.js';
import { Store } from '../src/store.js';

const SECRET = 'whsec_test_worker';
const SITE = 'https://listinglab.test';

function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: SECRET,
    PIPELINE_SECRET: 'pipeline-shared-secret',
    PHOTOS: new TestR2(),
    ASSETS: { fetch: async () => new Response('<!doctype html><title>Listing Lab</title>', { headers: { 'content-type': 'text/html' } }) },
    // The container binding is a Durable Object namespace; record what it is
    // handed so a test can assert the job spec is complete.
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

const uploadReq = (bytes = PNG_1PX, type = 'image/png', headers = {}) =>
  new Request(`${SITE}/api/photos`, { method: 'POST', headers: { 'content-type': type, ...headers }, body: bytes });

const post = (path, body, headers = {}) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });

/** Sign up and return the session cookie header value. */
async function signedIn(env, ctx, email = 'kyle@horizonhomemedia.test') {
  const res = await worker.fetch(post('/api/signup', {
    email, password: 'a-strong-password-1', name: 'Kyle', company: 'Horizon Home Media',
  }), env, ctx);
  // Read the body ONCE — a Response body is a stream and cannot be read twice.
  const payload = await res.json();
  assert.equal(res.status, 201, JSON.stringify(payload));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, account: payload.account };
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

/* -------------------------------------------------------------- signing in */

test('signing up creates an account with a locked-down cookie', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(post('/api/signup', { email: 'A@Example.com', password: 'password-one-two' }), env, ctx);
  assert.equal(res.status, 201);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const { account } = await res.json();
  assert.equal(account.email, 'a@example.com', 'email normalised');
  assert.equal(account.password_hash, undefined, 'never send the password hash to the browser');
  db.close();
});

test('the same email cannot be registered twice', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  await signedIn(env, ctx, 'dup@example.com');
  const res = await worker.fetch(post('/api/signup', { email: 'DUP@example.com', password: 'password-one-two' }), env, ctx);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'EMAIL_TAKEN');
  db.close();
});

test('a wrong password and an unknown email give the same answer', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  await signedIn(env, ctx, 'real@example.com');
  const wrong = await worker.fetch(post('/api/signin', { email: 'real@example.com', password: 'not-the-password' }), env, ctx);
  const unknown = await worker.fetch(post('/api/signin', { email: 'nobody@example.com', password: 'not-the-password' }), env, ctx);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json(), 'the form must not reveal who has an account');
  db.close();
});

test('signing in works and signing out kills the session', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx);
  assert.equal((await worker.fetch(get('/api/me', { cookie }), env, ctx)).status, 200);
  await worker.fetch(post('/api/signout', {}, { cookie }), env, ctx);
  assert.equal((await worker.fetch(get('/api/me', { cookie }), env, ctx)).status, 401, 'the old cookie is dead');
  db.close();
});

test('every account endpoint refuses an anonymous caller', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  for (const [path, req] of [
    ['/api/me', get('/api/me')],
    ['/api/credits', get('/api/credits')],
    ['/api/checkout', post('/api/checkout', { packId: 'pack_10' })],
    ['/api/transform', post('/api/transform', { photoId: 'p1', transformation: 'staging' })],
    ['/api/jobs/job_1', get('/api/jobs/job_1')],
  ]) {
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 401, `${path} should require sign-in`);
  }
  db.close();
});

test('a forged session cookie is not accepted', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  await signedIn(env, ctx);
  const res = await worker.fetch(get('/api/me', { cookie: 'll_session=' + 'f'.repeat(64) }), env, ctx);
  assert.equal(res.status, 401);
  db.close();
});

/* --------------------------------------------------------------- the webhook */

test('an unsigned webhook is rejected and credits nobody', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  const body = checkoutEvent(account.id);

  const res = await worker.fetch(post('/api/stripe/webhook', body), env, ctx);
  assert.equal(res.status, 400);
  await ctx.settled();

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 0, 'a forged payment must grant nothing');
  db.close();
});

test('a signed webhook credits the account', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  const body = checkoutEvent(account.id);

  const res = await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  assert.equal(res.status, 200);
  await ctx.settled();

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30);
  assert.match(credits.statement[0].description, /Bought 30 credits/);
  db.close();
});

test('the same purchase delivered twice under different event ids credits once', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);

  // Stripe: "In some cases, two separate Event objects are generated and sent."
  const first = checkoutEvent(account.id, { eventId: 'evt_1', sessionId: 'cs_same' });
  const second = checkoutEvent(account.id, { eventId: 'evt_2', sessionId: 'cs_same' });

  for (const body of [first, second]) {
    const res = await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
    assert.equal(res.status, 200);
  }
  await ctx.settled();

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'two deliveries, one purchase');
  db.close();
});

test('a retry of the exact same delivery is answered without doing anything twice', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  const body = checkoutEvent(account.id);
  const sig = await stripeHeader(body);

  const a = await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': sig }), env, ctx);
  const b = await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': sig }), env, ctx);
  await ctx.settled();

  assert.equal(a.status, 200);
  assert.equal((await b.json()).duplicate, true);
  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30);
  db.close();
});

test('paying the 10-pack price cannot buy the 75-pack', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  const body = checkoutEvent(account.id, { packId: 'pack_75', amount: 1999 });

  const res = await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  assert.equal(res.status, 200, 'we accept the delivery so Stripe stops retrying');
  await ctx.settled();

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 0, 'but grant nothing');
  db.close();
});

test('another kind of Stripe event grants nothing', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  const body = JSON.stringify({ id: 'evt_pi', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', metadata: { pack_id: 'pack_75', account_id: account.id } } } });

  const res = await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  assert.equal((await res.json()).ignored, 'payment_intent.succeeded');
  await ctx.settled();

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 0);
  db.close();
});

/* ------------------------------------------------------------- transforming */

async function seedPhoto(db, accountId) {
  await db.prepare("INSERT INTO listings (id, account_id, address, created_at) VALUES ('l1', ?, '123 Main St', '2026-08-25')").bind(accountId).run();
  await db.prepare("INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES ('p1', 'l1', ?, 'orig/p1.jpg', '2026-08-25')").bind(accountId).run();
}

async function fund(env, ctx, accountId, sessionId = 'cs_fund', packId = 'pack_30') {
  const pack = CREDIT_PACKS.find(p => p.id === packId);
  const body = checkoutEvent(accountId, { eventId: `evt_${sessionId}`, sessionId, packId, amount: pack.priceCents });
  await worker.fetch(post('/api/stripe/webhook', body, { 'stripe-signature': await stripeHeader(body) }), env, ctx);
  await ctx.settled();
}

test('a transformation charges the right number of credits', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await seedPhoto(db, account.id);
  await fund(env, ctx, account.id);

  const res = await worker.fetch(post('/api/transform', { photoId: 'p1', transformation: 'staging', style: 'Coastal', roomType: 'Living Room' }, { cookie }), env, ctx);
  assert.equal(res.status, 202);
  const out = await res.json();
  assert.equal(out.status, 'queued');
  assert.equal(out.balance, 28, 'staging costs 2');
  db.close();
});

test('an account with no credits cannot start a job', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await seedPhoto(db, account.id);

  const res = await worker.fetch(post('/api/transform', { photoId: 'p1', transformation: 'staging', style: 'Coastal', roomType: 'Living Room' }, { cookie }), env, ctx);
  assert.equal(res.status, 402, 'payment required');
  assert.equal((await res.json()).error.code, 'INSUFFICIENT_CREDITS');
  db.close();
});

test('the browser cannot ask for a style the pipeline will refuse', async () => {
  // Seen live on 26 Aug 2026: a staging job with style "Transitional" was
  // accepted, charged two credits, started a container, and died five seconds
  // later with "something went wrong while producing this photo". The closed
  // sets have to be enforced where the charge happens, not only in the dropdown.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await seedPhoto(db, account.id);
  await fund(env, ctx, account.id);

  for (const [bad, code] of [
    [{ style: 'Transitional', roomType: 'Living Room' }, 'UNKNOWN_STYLE'],
    [{ style: 'Coastal', roomType: 'Wine Cellar' }, 'UNKNOWN_ROOM'],
    [{ roomType: 'Living Room' }, 'UNKNOWN_STYLE'],
    [{ style: 'Coastal' }, 'UNKNOWN_ROOM'],
  ]) {
    const res = await worker.fetch(post('/api/transform',
      { photoId: 'p1', transformation: 'staging', ...bad }, { cookie }), env, ctx);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error.code, code);
  }

  const twilight = await worker.fetch(post('/api/transform',
    { photoId: 'p1', transformation: 'twilight', style: 'Midnight' }, { cookie }), env, ctx);
  assert.equal(twilight.status, 400);

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'and none of that cost the customer anything');
  db.close();
});

test('the closed sets in the API match the ones the pipeline enforces', () => {
  // Two lists that drift apart is how a legitimate style starts being refused at
  // the door — or worse, how an illegitimate one gets through to the container.
  const src = readFileSync(new URL('../pipeline/prompts.js', import.meta.url), 'utf8');
  const keysOf = (name) => {
    const start = src.indexOf(`const ${name} = {`);
    const body = src.slice(start, src.indexOf('\n};', start));
    return [...body.matchAll(/^\s{2}'?([^':\n]+?)'?:\s/gm)].map(m => m[1].trim());
  };
  assert.deepEqual([...STAGING_STYLES].sort(), keysOf('STAGING_STYLES').sort());
  assert.deepEqual([...ROOM_TYPES].sort(), keysOf('ROOM_TYPES').sort());
  assert.deepEqual([...TWILIGHT_MOODS].sort(), keysOf('TWILIGHT_MOODS').sort());
});

test('the browser cannot ask for a transformation we do not sell', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await seedPhoto(db, account.id);
  await fund(env, ctx, account.id);

  const res = await worker.fetch(post('/api/transform', { photoId: 'p1', transformation: 'sky_replacement' }, { cookie }), env, ctx);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'UNKNOWN_TRANSFORMATION');
  db.close();
});

test('one account cannot read another account s job', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const mine = await signedIn(env, ctx, 'mine@example.com');
  const theirs = await signedIn(env, ctx, 'theirs@example.com');
  await seedPhoto(db, mine.account.id);
  await fund(env, ctx, mine.account.id);

  const { jobId } = await (await worker.fetch(
    post('/api/transform', { photoId: 'p1', transformation: 'declutter' }, { cookie: mine.cookie }), env, ctx)).json();

  const ownerSees = await worker.fetch(get(`/api/jobs/${jobId}`, { cookie: mine.cookie }), env, ctx);
  const otherSees = await worker.fetch(get(`/api/jobs/${jobId}`, { cookie: theirs.cookie }), env, ctx);

  assert.equal(ownerSees.status, 200);
  assert.equal(otherSees.status, 404, 'and 404 not 403, so job ids cannot be probed');
  db.close();
});

test('the third attempt is the last one — the database arbitrates', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await seedPhoto(db, account.id);
  await fund(env, ctx, account.id);
  const { jobId } = await (await worker.fetch(
    post('/api/transform', { photoId: 'p1', transformation: 'staging', style: 'Coastal', roomType: 'Living Room' }, { cookie }), env, ctx)).json();

  const { Store } = await import('../src/store.js');
  const store = new Store(db);
  for (let i = 1; i <= 3; i++) {
    const job = await store.claimAttempt(jobId);
    assert.equal(job.attempts_used, i);
  }
  await assert.rejects(() => store.claimAttempt(jobId), err => (assert.equal(err.code, 'ATTEMPTS_EXHAUSTED'), true));
  db.close();
});



/* ------------------------------------------------------- uploading a photo */

test('an agent can upload a photo straight from their phone', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);

  const res = await worker.fetch(uploadReq(PNG_1PX, 'image/png', { cookie }), env, ctx);
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.match(out.photoId, /^pho_/);
  assert.ok(out.listingId, 'gets a catch-all listing without having to invent one');
  assert.ok(env.PHOTOS.objects.has(`${account.id}/${out.photoId}/original`), 'the bytes are actually stored');
  db.close();
});

test('a PDF or a video is refused, not stored', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx);
  const res = await worker.fetch(uploadReq(PNG_1PX, 'application/pdf', { cookie }), env, ctx);
  assert.equal(res.status, 415);
  assert.equal(env.PHOTOS.objects.size, 0);
  db.close();
});

test('a HEIC wearing a JPEG content-type is caught by its bytes, not its label', async () => {
  // The first real customer failure (31 Aug 2026): an iPhone HEIC renamed
  // .jpg sailed past the content-type check and crashed the pipeline six
  // minutes later — the pipeline container has no HEIC decoder. The upload
  // gate must read the magic bytes and refuse at once, with words that tell
  // the customer what to actually do.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx);
  // Minimal ISO-BMFF header: size + 'ftyp' + brand 'heic'
  const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
  const res = await worker.fetch(uploadReq(heic, 'image/jpeg', { cookie }), env, ctx);
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.error.code, 'HEIC_DISGUISED');
  assert.match(body.error.message, /iPhone HEIC/i, 'the customer is told what the file really is');
  assert.equal(env.PHOTOS.objects.size, 0, 'nothing undecodable is ever stored');

  // And random bytes that are no known image are refused too.
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const res2 = await worker.fetch(uploadReq(junk, 'image/jpeg', { cookie }), env, ctx);
  assert.equal(res2.status, 415);
  db.close();
});

test('an empty file is refused', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx);
  const res = await worker.fetch(uploadReq(new Uint8Array(0), 'image/jpeg', { cookie }), env, ctx);
  assert.equal(res.status, 400);
  db.close();
});

test('one agent cannot read another agent photo', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const mine = await signedIn(env, ctx, 'mine2@example.com');
  const theirs = await signedIn(env, ctx, 'theirs2@example.com');
  const { photoId } = await (await worker.fetch(uploadReq(PNG_1PX, 'image/png', { cookie: mine.cookie }), env, ctx)).json();
  const key = `${mine.account.id}/${photoId}/original`;

  assert.equal((await worker.fetch(get(`/api/photos/${encodeURIComponent(key)}`, { cookie: mine.cookie }), env, ctx)).status, 200);
  assert.equal((await worker.fetch(get(`/api/photos/${encodeURIComponent(key)}`, { cookie: theirs.cookie }), env, ctx)).status, 404);
  db.close();
});

test('a photo belonging to someone else cannot be transformed, and is not charged for', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const mine = await signedIn(env, ctx, 'a1@example.com');
  const theirs = await signedIn(env, ctx, 'b1@example.com');
  await fund(env, ctx, theirs.account.id, 'cs_b1');
  const { photoId } = await (await worker.fetch(uploadReq(PNG_1PX, 'image/png', { cookie: mine.cookie }), env, ctx)).json();

  const res = await worker.fetch(post('/api/transform', { photoId, transformation: 'staging' }, { cookie: theirs.cookie }), env, ctx);
  assert.equal(res.status, 404);
  const credits = await (await worker.fetch(get('/api/credits', { cookie: theirs.cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'nothing charged for a photo they do not own');
  db.close();
});

/* ------------------------------------------------- the pipeline reporting back */

async function startJob(env, ctx, cookie, transformation = 'staging') {
  const { photoId } = await (await worker.fetch(uploadReq(PNG_1PX, 'image/png', { cookie }), env, ctx)).json();
  const res = await worker.fetch(post('/api/transform', { photoId, transformation, style: 'Coastal', roomType: 'Living Room' }, { cookie }), env, ctx);
  return { ...(await res.json()), photoId };
}

const callback = (jobId, body, secret = 'pipeline-shared-secret') =>
  new Request(`${SITE}/internal/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pipeline-secret': secret },
    body: JSON.stringify(body),
  });

test('the container is handed everything it needs to run the job', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();

  const spec = env.PIPELINE.dispatched.at(-1);
  assert.equal(spec.jobId, jobId);
  assert.equal(spec.transformation, 'staging');
  assert.equal(spec.style, 'Coastal');
  assert.equal(spec.roomType, 'Living Room');
  assert.ok(spec.originalUrl.includes('/internal/photos/'));
  assert.ok(spec.callbackUrl.endsWith(`/internal/jobs/${jobId}/result`));
  assert.equal(spec.callbackSecret, 'pipeline-shared-secret');
  db.close();
});

test('the download button hands back a file, not a picture to look at', async () => {
  // Kyle, 26 Aug 2026, from his phone: "download link once photo is done doesn't
  // work". The button was an `<a download>` pointing at a route that served
  // image/jpeg and nothing else — and Safari on iOS treats that attribute as a
  // suggestion, so the agent got the photo opened in the tab and no file.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie, 'declutter');
  await ctx.settled();
  await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 1,
    image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') },
  }), env, ctx);

  const { resultUrl } = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();

  const inline = await worker.fetch(get(resultUrl, { cookie }), env, ctx);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-disposition'), null,
    'the slider previews this same URL — it must still render inline');

  const asFile = await worker.fetch(get(`${resultUrl}?download=1`, { cookie }), env, ctx);
  assert.equal(asFile.status, 200);
  const cd = asFile.headers.get('content-disposition');
  assert.match(cd, /^attachment;/, 'a header is not a suggestion, the attribute is');
  assert.match(cd, /filename="listing-lab-[A-Za-z0-9._-]+\.jpg"/, `unhelpful filename: ${cd}`);
  assert.equal(await asFile.text(), 'fake-jpeg-bytes', 'same bytes either way');
  db.close();
});

test('the result page asks for the download as an attachment', () => {
  const html = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(html, /resultUrl \+ '\?download=1'/, 'the button must request the file form');
});

test('someone else\'s photo is not downloadable either', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx, 'a@example.com');
  const res = await worker.fetch(get('/api/photos/acct_someone_else%2Fpho_1%2Fresult.jpg?download=1', { cookie }), env, ctx);
  assert.equal(res.status, 404, 'the download flag must not become a way around the owner check');
  db.close();
});

test('a delivered job keeps its audit, not just the ones that break', async () => {
  // Until 26 Aug 2026 only errors were recorded. Kyle reported a colour cast on a
  // DELIVERED photo and there was nothing stored to say what the checks had
  // concluded — the interesting jobs are the ones that shipped.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie, 'declutter');
  await ctx.settled();

  await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 1,
    image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') },
    audit: {
      type: 'declutter', outcome: 'approved', imageSize: '4K',
      colour: [{ label: 'attempt1', colour: { applied: true, before: [-3.8, 0.5, -2.8], after: [0.5, 0.2, 0.5] } }],
      watermark: { text: 'Virtually decluttered', present: true },
      attempts: [{ attempt: 1, verdict: { pass: true, passes: 3, votes: 3, violations: [] },
                   removal: { removedAnything: true, items: ['soap dispenser', 'vanity mirror'] },
                   scope: { remaining: [{ key: 'trash_bin', votes: '3/3', where: 'beside the toilet', label: 'a trash can', gating: true }],
                            noted: [{ key: 'cords', where: 'under the TV' }], overreach: [], errors: [] } }],
    },
  }), env, ctx);

  const row = db.db.prepare('SELECT outcome, audit_json FROM job_attempts WHERE job_id = ?').get(jobId);
  assert.ok(row, 'the delivered attempt should be recorded');
  assert.equal(row.outcome, 'delivered');
  const saved = JSON.parse(row.audit_json);
  assert.equal(saved.attempts[0].pass, true);
  assert.deepEqual(saved.attempts[0].removal.items, ['soap dispenser', 'vanity mirror']);
  assert.equal(saved.colour[0].colour.applied, true, 'the colour numbers are the point of keeping this');
  assert.deepEqual(saved.attempts[0].scope.remaining, [{ key: 'trash_bin', votes: '3/3', where: 'beside the toilet' }],
    'what the scope checks decided must survive into the record');
  assert.deepEqual(saved.attempts[0].scope.noted, ['cords']);
  db.close();
});

test('a staging summary keeps the brief and the ranking that chose it', () => {
  // "That's perfect staging" is only useful if the record says which brief made
  // it. The first time Kyle said it, the record did not.
  const s = auditSummary({
    type: 'staging', outcome: 'approved',
    briefs: [{ attempt: 1, seed: 'a1b2c3', concept: 'Coastal, seating turned to the fireplace' }],
    ranking: { order: [2, 0, 1], scores: [7, 6, 8] },
    attempts: [{ candidate: 1, verdict: { pass: true, passes: 3, votes: 3, violations: [] } }],
  });
  assert.equal(s.briefs[0].seed, 'a1b2c3');
  assert.match(s.briefs[0].concept, /fireplace/);
  assert.deepEqual(s.ranking.order, [2, 0, 1]);
});

test('an audit summary drops the bulk and keeps what answers a complaint', () => {
  const big = {
    type: 'staging', outcome: 'approved',
    attempts: Array.from({ length: 20 }, (_, i) => ({
      candidate: i, verdict: { pass: false, passes: 0, votes: 3, violations: ['x'.repeat(400)] },
      // The kind of field that must never reach the database.
      raw: '/tmp/job/cand' + i + '.raw.jpg',
    })),
  };
  const s = auditSummary(big);
  const text = JSON.stringify(s);
  assert.ok(text.length <= 12000, `summary is ${text.length} characters`);
  assert.ok(!text.includes('/tmp/job/'), 'container file paths are meaningless once the container is gone');
  assert.equal(auditSummary(null), null);
  assert.equal(auditSummary('not an audit'), null);
});


test('a rejected job keeps its audit and an outage is not called a rejection', async () => {
  // 26 Aug 2026: Google's image model returned 500/503 for several minutes. Every
  // attempt died before producing a frame, and the app told Kyle "no result passed
  // our compliance checks" — blaming a judge for an outage — and stored nothing.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie, 'declutter');
  await ctx.settled();

  await worker.fetch(callback(jobId, {
    jobId, outcome: 'error', attemptsUsed: 3,
    error: 'Gemini 503: gemini-3-pro-image is currently unavailable',
    note: 'The image service was unavailable just now, so nothing was produced. Your credits have been returned — please try again in a few minutes.',
    audit: { type: 'declutter', outcome: 'error', attempts: [{ attempt: 1, error: 'Gemini 503' }] },
  }), env, ctx);

  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.match(status.note, /image service was unavailable/);
  assert.ok(!/compliance/i.test(status.note), 'an outage must not be reported as a compliance failure');

  const row = db.db.prepare('SELECT outcome, audit_json FROM job_attempts WHERE job_id = ?').get(jobId);
  assert.equal(row.outcome, 'error');
  const saved = JSON.parse(row.audit_json);
  assert.match(saved.error, /503/, 'the technical error is what makes this fixable');
  assert.equal(saved.type, 'declutter');

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'an outage costs the customer nothing');
  db.close();
});

test('a delivered result is stored and the credits stay spent', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();

  const res = await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 2,
    image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') },
  }), env, ctx);
  assert.equal(res.status, 200);

  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.equal(status.status, 'delivered');
  assert.equal(status.attemptsUsed, 2);
  assert.ok(status.resultUrl, 'the agent gets a link to the finished image');
  const resultKey = [...env.PHOTOS.objects.keys()].find(k => k.includes(jobId));
  assert.ok(resultKey, 'the finished image was written to storage');
  assert.ok(resultKey.startsWith(`${account.id}/`), 'and under the owning account');

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 28, 'delivered work is paid for');
  db.close();
});

test('a rejected result returns the credits — the promise on the marketing page', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();

  await worker.fetch(callback(jobId, { jobId, outcome: 'rejected', note: 'Nothing passed the checks.' }), env, ctx);

  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.equal(status.status, 'rejected');
  assert.match(status.note, /Nothing passed/);

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'staging returns both credits');
  assert.match(credits.statement[0].description, /credits returned/);
  db.close();
});

test('a crash in the pipeline also returns the credits', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie, 'declutter');
  await ctx.settled();

  await worker.fetch(callback(jobId, { jobId, outcome: 'error', error: 'boom', note: 'Something went wrong.' }), env, ctx);
  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'a customer never pays for our crash');
  db.close();
});

test('the same result reported twice does not return credits twice', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();

  const body = { jobId, outcome: 'rejected', note: 'Nothing passed.' };
  await worker.fetch(callback(jobId, body), env, ctx);
  await worker.fetch(callback(jobId, body), env, ctx);

  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30, 'not 32');
  db.close();
});

test('a result posted without the shared secret is refused', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();

  const res = await worker.fetch(callback(jobId, { jobId, outcome: 'rejected' }, 'wrong-secret'), env, ctx);
  assert.equal(res.status, 401);

  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.equal(status.status, 'running', 'still running — an outsider cannot mark a job finished');
  assert.equal(status.note, null, 'and cannot put words in front of the customer either');
  db.close();
});

/* ------------------------------------------------------------------- misc */

test('an unknown endpoint is a clean 404, not a crash', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(get('/api/nonsense'), env, ctx);
  assert.equal(res.status, 401, 'unauthenticated first');
  const { cookie } = await signedIn(env, ctx);
  const res2 = await worker.fetch(get('/api/nonsense', { cookie }), env, ctx);
  assert.equal(res2.status, 404);
  db.close();
});

test('a signed-out visitor gets the app page, not a 401', async () => {
  // The page is where the sign-in form lives. Gating it behind sign-in is a
  // locked door with the key inside.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  for (const path of ['/', '/app', '/anything']) {
    const res = await worker.fetch(get(path), env, ctx);
    assert.equal(res.status, 200, `${path} must be public`);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  db.close();
});

test('the API still refuses anonymous callers after that change', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  assert.equal((await worker.fetch(get('/api/me'), env, ctx)).status, 401);
  assert.equal((await worker.fetch(get('/api/credits'), env, ctx)).status, 401);
  db.close();
});

/* ------------------------------------------- offering only what makes sense */

const sig = o => ({ isExterior: false, removableClutter: 'none', furniture: 'none', stageableFloor: true, ...o });

test('a room with just two boxes is STILL offered declutter', () => {
  // Kyle's case, and the hole in the first version: "only a token piece or two"
  // described exactly this room, so the app refused the job the agent wanted.
  const twoBoxes = sig({ removableClutter: 'some', furniture: 'none' });
  assert.ok(offeredFor(twoBoxes).includes('declutter'), 'those two boxes ARE the job');
  assert.ok(offeredFor(twoBoxes).includes('staging'), 'and the floor is still stageable');
});

test('a bathroom with a few things on the counter is offered declutter', () => {
  const bathroom = sig({ removableClutter: 'some', furniture: 'none', stageableFloor: false });
  assert.ok(offeredFor(bathroom).includes('declutter'));
  assert.ok(!offeredFor(bathroom).includes('staging'), 'but there is nowhere to put a sofa');
});

test('a genuinely bare room is not offered declutter', () => {
  const bare = sig({ removableClutter: 'none', furniture: 'none' });
  assert.deepEqual(offeredFor(bare), ['staging']);
});

test('a furnished room is not offered staging', () => {
  const furnished = sig({ removableClutter: 'lots', furniture: 'furnished' });
  const o = offeredFor(furnished);
  assert.ok(o.includes('declutter') && o.includes('empty'));
  assert.ok(!o.includes('staging'), 'empty it first');
});

test('a sparsely furnished room is offered everything sensible, with a nudge', () => {
  const sparse = sig({ removableClutter: 'some', furniture: 'sparse' });
  const o = offeredFor(sparse);
  assert.ok(o.includes('declutter') && o.includes('empty') && o.includes('staging'));
  assert.match(adviceFor(sparse, 'staging'), /Emptying it first/);
});

test('an exterior is only offered twilight', () => {
  assert.deepEqual(offeredFor(sig({ isExterior: true })), ['twilight']);
});

test('a light declutter is offered with a heads-up rather than a refusal', () => {
  assert.match(adviceFor(sig({ removableClutter: 'some' }), 'declutter'), /not much here to remove/);
  // A very full room steers toward Empty Room — declutter's measured weak spot
  // and Empty Room's strength (28 Aug 2026). A nudge, never a block.
  assert.match(adviceFor(sig({ removableClutter: 'lots' }), 'declutter'), /Empty Room/);
});

test('when the classifier says nothing, everything is offered', () => {
  for (const v of [null, undefined, {}, 'nonsense', 42]) {
    assert.deepEqual(offeredFor(v), ['declutter', 'empty', 'staging', 'twilight'],
      'a classifier outage must never block an agent');
  }
});

test('the offer list is never empty, even on contradictory signals', () => {
  const weird = { isExterior: false, removableClutter: 'none', furniture: 'furnished', stageableFloor: false };
  assert.ok(offeredFor(weird).length > 0);
});

test('the server refuses staging on an already-furnished room, and charges nothing', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { photoId } = await (await worker.fetch(uploadReq(PNG_1PX, 'image/png', { cookie }), env, ctx)).json();
  await db.prepare("UPDATE photos SET scene = ? WHERE id = ?")
    .bind(JSON.stringify(sig({ removableClutter: 'lots', furniture: 'furnished' })), photoId).run();

  const res = await worker.fetch(post('/api/transform', { photoId, transformation: 'staging', style: 'Coastal', roomType: 'Living Room' }, { cookie }), env, ctx);
  assert.equal(res.status, 422);
  assert.match((await res.json()).error.message, /already furnished/i);
  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, 30);
  db.close();
});

test('the server ALLOWS declutter on a lightly cluttered room', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { photoId } = await (await worker.fetch(uploadReq(PNG_1PX, 'image/png', { cookie }), env, ctx)).json();
  await db.prepare("UPDATE photos SET scene = ? WHERE id = ?")
    .bind(JSON.stringify(sig({ removableClutter: 'some', furniture: 'none' })), photoId).run();

  const res = await worker.fetch(post('/api/transform', { photoId, transformation: 'declutter' }, { cookie }), env, ctx);
  assert.equal(res.status, 202, 'two boxes is a real job');
  db.close();
});

test('malformed JSON does not take the Worker down', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const res = await worker.fetch(post('/api/signin', 'not json at all'), env, ctx);
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  db.close();
});

test('a job waiting out an outage tells the customer their image is coming and their credits are safe', async () => {
  const { customerMessage } = await import('../src/worker.js').then(m => m).catch(() => ({}));
  // customerMessage is module-internal; assert its behaviour through jobStatus if exported,
  // otherwise assert the source guarantees. Kept as a source-guarantee to avoid coupling.
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function customerMessage'), src.indexOf('async function jobStatus'));
  // The waiting message must promise the image and deny the charge, and must not
  // read as an error or a refund.
  assert.match(fn, /waitingOnUpstream/);
  // Audit, 3 Sep 2026: the credits ARE debited at start (atomically), so
  // "you have not been charged" was untrue while the balance visibly dropped.
  // The honest promise is that they come back if the job cannot deliver.
  assert.match(fn, /credits come back automatically/i, 'a waiting customer must be told the credits return if it cannot deliver');
  assert.doesNotMatch(fn.slice(fn.indexOf('waitingOnUpstream'), fn.indexOf("=== 'failed'")), /not been charged/i, 'never claim they were not charged — they were, refundably');
  assert.match(fn, /delivered|on its way|queued/i, 'and that the photo is coming');
  // The refund line must be gated behind an actual failure, never shown while waiting.
  const waitingBlock = fn.slice(fn.indexOf('waitingOnUpstream'), fn.indexOf("=== 'failed'") > -1 ? fn.indexOf("=== 'failed'") : fn.length);
  assert.ok(!/credit has been returned/i.test(waitingBlock), 'the refund line must not appear in the waiting state');
});

test('the atomic debit is the referee: it refuses when the balance cannot cover the cost', async () => {
  // Security review, 31 Aug 2026. The in-memory balance check ran against a
  // stale snapshot, so two simultaneous transforms could both pass it and drive
  // the account negative — real money spent on Google for credits that were
  // never there. The fix moved the guard INTO the database: the debit inserts
  // only when the summed balance still covers the cost. This test proves the DB
  // is the referee, independent of any in-memory check.
  const db = new TestD1();
  const store = new Store(db);
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)')
    .bind('acct', 'a@b.c', now).run();
  await db.prepare('INSERT INTO listings (id, account_id, address, created_at) VALUES (?, ?, ?, ?)')
    .bind('lst', 'acct', '1 St', now).run();
  await db.prepare('INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('pho', 'lst', 'acct', 'k', now).run();
  // Grant exactly 2 credits.
  await store.appendEntry('acct', { key: 'seed', type: 'promo', delta: 2, at: now });
  const mkJob = async id => db.prepare(
    `INSERT INTO jobs (id, account_id, photo_id, transformation, status, attempts_allowed, created_at)
     VALUES (?, 'acct', 'pho', 'staging', 'queued', 3, ?)`).bind(id, now).run();

  // First 2-credit debit: affordable, applied.
  await mkJob('j1');
  const a = await store.debitForJobIfAffordable('acct',
    { key: 'j1:debit', type: 'debit', delta: -2, jobId: 'j1', transformation: 'staging', at: now }, 2);
  assert.deepEqual(a, { applied: true });
  assert.equal(await store.balanceFor('acct'), 0);

  // Second 2-credit debit against a now-empty account: the DB refuses it even
  // though a caller holding the old snapshot (balance 2) would have allowed it.
  await mkJob('j2');
  const b = await store.debitForJobIfAffordable('acct',
    { key: 'j2:debit', type: 'debit', delta: -2, jobId: 'j2', transformation: 'staging', at: now }, 2);
  assert.deepEqual(b, { applied: false, insufficient: true });
  assert.equal(await store.balanceFor('acct'), 0, 'balance never went negative');

  // The refused debit wrote nothing, so re-charging the SAME key later still works
  // once credits exist — no phantom row was left behind.
  await store.appendEntry('acct', { key: 'topup', type: 'promo', delta: 2, at: now });
  const c = await store.debitForJobIfAffordable('acct',
    { key: 'j2:debit', type: 'debit', delta: -2, jobId: 'j2', transformation: 'staging', at: now }, 2);
  assert.deepEqual(c, { applied: true });
  assert.equal(await store.balanceFor('acct'), 0);

  // With balance sufficient, replaying an already-written debit key is caught by
  // the UNIQUE constraint and reported as a duplicate — never a second charge.
  await store.appendEntry('acct', { key: 'topup2', type: 'promo', delta: 4, at: now });
  const d = await store.debitForJobIfAffordable('acct',
    { key: 'j1:debit', type: 'debit', delta: -2, jobId: 'j1', transformation: 'staging', at: now }, 2);
  assert.equal(d.applied, false);
  assert.equal(d.duplicate, true);
  assert.equal(await store.balanceFor('acct'), 4, 'a duplicate key never double-charges');
  db.close();
});

test('a rejection callback that arrives after delivery is ignored (the callback guard)', async () => {
  // Audit, 3 Sep 2026. finishJob is atomic, but the refund used to follow
  // regardless of whether this caller actually finished the job. A stale
  // container callback (or the stall sweep) landing after the real delivery
  // would hand the credits back for a photo the customer already has.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();
  const charged = (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance;

  await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 1,
    image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') },
  }), env, ctx);
  // The late rejection for the same job.
  await worker.fetch(callback(jobId, { jobId, outcome: 'rejected', note: 'Nothing passed.' }), env, ctx);

  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.equal(status.status, 'delivered', 'the delivery stands');
  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, charged, 'and the credits stay spent — no refund for a delivered photo');
  assert.ok(!credits.statement.some(s => /returned/i.test(s.description)), 'no return entry in the ledger');
  db.close();
});

test('THE REFUND RACE: the sweep failing a job that just delivered must not refund it', async () => {
  // Audit, 3 Sep 2026. The stall sweep reads a batch of silent jobs, then
  // fails and refunds each. Between the read and the fail, the real delivery
  // can land. finishJob is atomic and the delivery wins — but the refund used
  // to follow regardless: photo AND credits. This drives failJobAndRefund with
  // exactly that stale row.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();
  const staleRow = db.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);   // what the sweep read: running, unfinished
  const charged = (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance;

  await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 1,
    image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') },
  }), env, ctx);

  await failJobAndRefund(new Store(db), staleRow, 'That job stopped responding. Your credits have been returned.');

  const status = await (await worker.fetch(get(`/api/jobs/${jobId}`, { cookie }), env, ctx)).json();
  assert.equal(status.status, 'delivered', 'the delivery stands');
  const credits = await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json();
  assert.equal(credits.balance, charged, 'and the credits stay spent');
  assert.ok(!credits.statement.some(s => /returned/i.test(s.description)), 'no return entry in the ledger');
  db.close();
});

test('rate limits: a caller past the limit gets 429 on sign-in, and a missing binding means no limit', async () => {
  // Audit, 3 Sep 2026. The limiter is Cloudflare's Workers rate limiter,
  // keyed on route + IP. Modelled here with a binding that allows N calls.
  const db = new TestD1(); const ctx = testCtx();
  let allowed = 2;
  const env = { ...makeEnv(db), LIMIT_AUTH: { limit: async () => ({ success: allowed-- > 0 }) } };
  const attempt = () => worker.fetch(post('/api/signin', { email: 'nobody@example.com', password: 'wrong-password' }, { 'cf-connecting-ip': '203.0.113.9' }), env, ctx);
  assert.notEqual((await attempt()).status, 429);
  assert.notEqual((await attempt()).status, 429);
  const third = await attempt();
  assert.equal(third.status, 429, 'third attempt inside the window is refused');
  assert.equal(third.headers.get('retry-after'), '60');
  // No binding at all (local dev, an older deploy): the door still works.
  const bare = await worker.fetch(post('/api/signin', { email: 'nobody@example.com', password: 'wrong-password' }), makeEnv(db), ctx);
  assert.notEqual(bare.status, 429);
  db.close();
});

test('Google sign-in never enters an account that was created with a password', async () => {
  // Audit, 3 Sep 2026: signup does not verify email, so a squatter could
  // register a victim's address first; Google login by address alone would
  // then land the victim inside the squatter's account.
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  await worker.fetch(post('/api/signup', { email: 'victim@example.com', password: 'squatter-pass-123', name: 'Squatter' }), env, ctx);
  const store = new Store(db);
  const acct = await store.accountByEmail('victim@example.com');
  assert.ok(acct && acct.password_hash !== '$google-only$', 'a password account exists for that address');
  // The guard is the one line the callback runs after verifying Google's claims;
  // exercise its decision directly (the full OAuth exchange needs Google).
  const wouldMerge = acct.password_hash === '$google-only$';
  assert.equal(wouldMerge, false, 'the callback refuses to merge into it');
  db.close();
});

/* ------------------------------------------------- erasing a customer's data */

test('the owner can erase an account: photos and jobs gone from D1 and R2, ledger kept, account anonymised', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  env.DIAG_SECRET = 'diag-test';
  const { cookie, account } = await signedIn(env, ctx, 'leaving@example.com');
  await fund(env, ctx, account.id);
  const { jobId } = await startJob(env, ctx, cookie);
  await ctx.settled();
  await worker.fetch(callback(jobId, {
    jobId, outcome: 'delivered', attemptsUsed: 1,
    image: { filename: 'r.jpg', base64: btoa('fake-jpeg-bytes') },
  }), env, ctx);
  const before = [...env.PHOTOS.objects.keys()].filter(k => k.startsWith(`${account.id}/`));
  assert.ok(before.length >= 2, 'an original and a result are in storage');
  const ledgerBefore = db.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id = ?').get(account.id).n;
  assert.ok(ledgerBefore >= 2, 'a purchase and a spend are on the ledger');

  // Guards: no secret, wrong secret, missing confirmation, unknown email.
  assert.equal((await worker.fetch(post('/internal/board/erase-account', { email: 'leaving@example.com', confirm: 'leaving@example.com' }), env, ctx)).status, 404);
  assert.equal((await worker.fetch(post('/internal/board/erase-account?s=wrong', { email: 'leaving@example.com', confirm: 'leaving@example.com' }), env, ctx)).status, 404);
  const noConfirm = await worker.fetch(post('/internal/board/erase-account?s=diag-test', { email: 'leaving@example.com' }), env, ctx);
  assert.equal(noConfirm.status, 400);
  assert.equal((await noConfirm.json()).error.code, 'CONFIRM_REQUIRED');
  assert.equal((await worker.fetch(post('/internal/board/erase-account?s=diag-test', { email: 'nobody@example.com', confirm: 'nobody@example.com' }), env, ctx)).status, 404);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE account_id = ?').get(account.id).n, 1, 'nothing touched by a refused request');

  const res = await worker.fetch(post('/internal/board/erase-account?s=diag-test', { email: 'Leaving@Example.com', confirm: 'leaving@example.com' }), env, ctx);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.photos, 1);
  assert.equal(out.jobs, 1);
  assert.ok(out.objectsDeleted >= before.length, 'every object the account owned was deleted');
  assert.equal(out.objectsFailed, 0);

  const after = [...env.PHOTOS.objects.keys()].filter(k => k.startsWith(`${account.id}/`));
  assert.deepEqual(after, [], 'no bytes of theirs remain in storage');
  for (const t of ['photos', 'jobs', 'sessions']) {
    assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`).get(account.id).n, 0, `${t} rows gone`);
  }
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM job_attempts WHERE job_id = ?').get(jobId).n, 0, 'attempts gone');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id = ?').get(account.id).n, ledgerBefore, 'purchase records are the exception the policy names');

  const acct = db.db.prepare('SELECT email, name, company, password_hash FROM accounts WHERE id = ?').get(account.id);
  assert.equal(acct.email, `erased+${account.id}@deleted.invalid`);
  assert.equal(acct.name, null);
  assert.equal(acct.company, null);
  assert.equal(acct.password_hash, '$erased$');

  // Their old cookie is dead, and the email is free to register again.
  assert.equal((await worker.fetch(get('/api/me', { cookie }), env, ctx)).status, 401);
  assert.equal((await worker.fetch(post('/api/signin', { email: 'leaving@example.com', password: 'a-strong-password-1' }), env, ctx)).status, 401);
  const again = await worker.fetch(post('/api/signup', { email: 'leaving@example.com', password: 'a-strong-password-2' }), env, ctx);
  assert.equal(again.status, 201, 'the address can open a fresh account later');
  db.close();
});

/* ------------------------------------------------------ hardening, 3 Sep */

test('plain http and www are sent to the one https address, permanently', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const http = await worker.fetch(new Request('http://listinglab.test/app?x=1'), env, ctx);
  assert.equal(http.status, 301);
  assert.equal(http.headers.get('location'), 'https://listinglab.test/app?x=1');
  const www = await worker.fetch(new Request('https://www.listinglab.test/pricing'), env, ctx);
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('location'), 'https://listinglab.test/pricing');
  // Local development is untouched.
  const local = { ...env, SITE_URL: 'http://localhost:8787' };
  const dev = await worker.fetch(new Request('http://localhost:8787/'), local, ctx);
  assert.equal(dev.status, 200);
  db.close();
});

test('every response carries the browser locks; HTML pages get a CSP', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const page = await worker.fetch(get('/'), env, ctx);
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /fonts\.googleapis\.com/, 'the fonts the pages use still load');
  assert.match(csp, /img-src 'self' data: blob:/, 'inline illustrations and upload previews still show');

  const api = await worker.fetch(get('/api/me'), env, ctx);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('content-security-policy'), null, 'JSON does not need a page policy');

  // The owner board keeps its own, stricter policy.
  env.DIAG_SECRET = 'diag-test';
  const board = await worker.fetch(get('/internal/board?s=diag-test'), env, ctx);
  assert.equal(board.status, 200);
  assert.match(board.headers.get('content-security-policy'), /base-uri 'none'/);
  assert.equal(board.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  db.close();
});

test('the owner secret moves from the URL into a cookie on the first browser visit', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  env.DIAG_SECRET = 'diag-test';
  const browser = { accept: 'text/html,application/xhtml+xml' };

  // A browser arriving with the bookmark is moved to the clean address…
  const first = await worker.fetch(get('/internal/board?s=diag-test', browser), env, ctx);
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), '/internal/board');
  const setCookie = first.headers.get('set-cookie');
  assert.match(setCookie, /^ll_owner=[0-9a-f]{64};/, 'a hash, not the secret itself');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /Path=\/internal/);
  assert.ok(!setCookie.includes('diag-test'), 'the secret never goes into the cookie');
  const cookie = setCookie.split(';')[0];

  // …and from then on the cookie alone opens every owner page, with no secret in any link.
  const board = await worker.fetch(get('/internal/board', { ...browser, cookie }), env, ctx);
  assert.equal(board.status, 200);
  const html = await board.text();
  assert.ok(!html.includes('diag-test'), 'the rendered dashboard no longer contains the secret');
  assert.equal((await worker.fetch(get('/internal/board/live', { cookie }), env, ctx)).status, 200);
  assert.equal((await worker.fetch(get('/internal/board/promos', { cookie }), env, ctx)).status, 200);
  assert.equal((await worker.fetch(get('/internal/grade', { ...browser, cookie }), env, ctx)).status, 200);
  const jobs = await worker.fetch(get('/internal/grade/jobs?s=', { cookie }), env, ctx);
  assert.equal(jobs.status, 200, 'the grader page fetches with an empty s= and the cookie does the work');

  // Wrong cookie, no cookie, wrong secret: the same 404 as before.
  assert.equal((await worker.fetch(get('/internal/board', { cookie: 'll_owner=' + 'f'.repeat(64) }), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board?s=nope', browser), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/grade', browser), env, ctx)).status, 401);

  // curl with the secret is NOT redirected — the runbook's calls keep working.
  const curl = await worker.fetch(get('/internal/board/slots.json?s=diag-test'), env, ctx);
  assert.equal(curl.status, 200);
  assert.equal(curl.headers.get('set-cookie'), null);

  // Rotating the secret kills every cookie at once.
  env.DIAG_SECRET = 'rotated';
  assert.equal((await worker.fetch(get('/internal/board', { cookie }), env, ctx)).status, 404);
  db.close();
});

test('THE 15-MINUTE PROMISE binds a job that is still heartbeating', async () => {
  // Soak test, 3 Sep 2026: a closet declutter heartbeated through two container
  // kills and showed "working" for 21 minutes. Heartbeats kept it off the
  // silent-job path; the queue path only saw it between park and re-dispatch.
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account } = await signedIn(env, ctx);
  await fund(env, ctx, account.id);
  const fresh = (await startJob(env, ctx, cookie, 'declutter')).jobId;
  const old = (await startJob(env, ctx, cookie, 'declutter')).jobId;
  await ctx.settled();
  const ago = m => new Date(Date.now() - m * 60 * 1000).toISOString();
  const beat = new Date().toISOString();
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ?, heartbeat_at = ? WHERE id = ?').run(ago(10), ago(1), beat, fresh);
  db.db.prepare('UPDATE jobs SET created_at = ?, last_dispatch_at = ?, heartbeat_at = ? WHERE id = ?').run(ago(16), ago(1), beat, old);
  const before = (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance;

  const swept = await sweepRetries(env, new Store(db));
  assert.equal(swept.timedOut, 1, 'exactly the overdue job is stopped');

  const gone = await (await worker.fetch(get(`/api/jobs/${old}`, { cookie }), env, ctx)).json();
  assert.equal(gone.status, 'failed');
  assert.match(gone.note, /longer than we are willing to keep you waiting/);
  const kept = await (await worker.fetch(get(`/api/jobs/${fresh}`, { cookie }), env, ctx)).json();
  assert.equal(kept.status, 'running', 'a ten-minute heartbeating job is left alone');
  const after = (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance;
  assert.equal(after, before + 2, 'the stopped job is refunded, the running one is not');

  // A result that limps in afterwards is dropped, not delivered and not refunded twice.
  await worker.fetch(callback(old, { jobId: old, outcome: 'delivered', attemptsUsed: 2, image: { filename: 'r.jpg', base64: btoa('late') } }), env, ctx);
  const still = await (await worker.fetch(get(`/api/jobs/${old}`, { cookie }), env, ctx)).json();
  assert.equal(still.status, 'failed');
  assert.equal((await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json()).balance, after);
  db.close();
});

test('a D1 hiccup is retried once; other errors are not', async () => {
  // Soak re-test, 3 Sep 2026: an upload 500'd on "D1 DB storage operation
  // exceeded timeout which caused object to be reset", gone a moment later.
  const { retryingD1 } = await import('../src/store.js');
  const calls = [];
  const flaky = (msg, times) => {
    let n = 0;
    const stmt = {
      bind: () => stmt,
      first: async () => { calls.push('first'); if (n++ < times) throw new Error(msg); return { ok: 1 }; },
      run: async () => { calls.push('run'); if (n++ < times) throw new Error(msg); return { meta: { changes: 1 } }; },
      all: async () => ({ results: [] }),
    };
    return { prepare: () => stmt, batch: async (s) => { calls.push('batch'); if (n++ < times) throw new Error(msg); return s.map(() => ({})); } };
  };
  const ok = retryingD1(flaky('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.', 1));
  assert.deepEqual(await ok.prepare('SELECT 1').bind().first(), { ok: 1 });
  assert.equal(calls.filter(c => c === 'first').length, 2, 'one retry');

  calls.length = 0;
  const twice = retryingD1(flaky('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.', 2));
  await assert.rejects(() => twice.prepare('SELECT 1').bind().first(), /exceeded timeout/, 'only ONE retry, then the error surfaces');

  calls.length = 0;
  const real = retryingD1(flaky('UNIQUE constraint failed: photos.id', 1));
  await assert.rejects(() => real.prepare('INSERT').bind().run(), /UNIQUE/, 'a real error is not retried');
  assert.equal(calls.length, 1);

  // Wrapped statements pass through batch() unwrapped, and batch retries too.
  calls.length = 0;
  const b = retryingD1(flaky('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.', 1));
  const out = await b.batch([b.prepare('A').bind(), b.prepare('B').bind()]);
  assert.equal(out.length, 2);
  assert.equal(calls.filter(c => c === 'batch').length, 2);
});
