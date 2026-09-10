/**
 * Listing Lab — push notifications for the iPhone app (10 Sep 2026).
 *
 * The app registers its phone; when a job finishes the Worker sends one
 * line to every phone on the account through Apple's push service, signed
 * with the .p8 key. The tests mint their own P-256 key, so the signing is
 * real and checked with the matching public key, and stand in for Apple's
 * endpoint with a stub that records what it was sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';
import { apnsToken, sendPush, jobFinishedMessage, pushConfigured, resetApnsTokenCache, APNS_HOSTS, APNS_TOKEN_TTL_MS } from '../src/apns.js';
import { APP_BUNDLE_ID } from '../src/apple.js';

const SITE = 'https://listinglab.test';
const TOKEN_A = 'a'.repeat(64), TOKEN_B = 'b'.repeat(64);

/** A P-256 key pair as Apple issues one, the private half as a .p8 PEM. */
async function makeKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g).join('\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

function makeEnv(db, key, extra = {}) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    PIPELINE_SECRET: 'pipeline-shared-secret',
    PHOTOS: new TestR2(),
    ASSETS: { fetch: async () => new Response('asset') },
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: '6YCK9MG5RD',
    APNS_PRIVATE_KEY: key.pem,
    ...extra,
  };
}
const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const del = (path, headers = {}) => new Request(`${SITE}${path}`, { method: 'DELETE', headers });

async function signedUp(env, ctx, email = 'agent@example.com') {
  const res = await worker.fetch(post('/api/signup', { email, password: 'password-one-two' }), env, ctx);
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { account } = await res.json();
  return { cookie, account };
}

/** Stand in for Apple: record every push, answer as told. */
function stubApple(answer = () => new Response('{}', { status: 200 })) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('push.apple.com')) {
      const call = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      sent.push(call);
      return answer(call);
    }
    return real(url, init);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const b64urlToBytes = s => { let t = s.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return Uint8Array.from(atob(t), c => c.charCodeAt(0)); };
const readJson = part => JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));

/* ---------------------------------------------------------- the signing */

test('the bearer token is a JWT Apple would accept, signed with the .p8 key, and reused for fifty minutes', async () => {
  resetApnsTokenCache();
  const key = await makeKey(); const env = makeEnv(null, key);
  const now = Date.parse('2026-09-10T12:00:00Z');
  const token = await apnsToken(env, now);
  const [h, c, sig] = token.split('.');
  assert.deepEqual(readJson(h), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(readJson(c), { iss: '6YCK9MG5RD', iat: Math.floor(now / 1000) });
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok, 'the signature verifies with the matching public key');

  assert.equal(await apnsToken(env, now + APNS_TOKEN_TTL_MS - 1000), token, 'the same token until it is nearly an hour old');
  assert.notEqual(await apnsToken(env, now + APNS_TOKEN_TTL_MS + 1000), token, 'then a fresh one');
  resetApnsTokenCache();
});

test('one push is one request to the right Apple host, for our app, with the one line', async () => {
  resetApnsTokenCache();
  const key = await makeKey(); const env = makeEnv(null, key);
  const apple = stubApple();
  try {
    const out = await sendPush(env, { token: TOKEN_A, environment: 'sandbox' }, { body: 'Your Twilight is ready.', jobId: 'job_1' });
    assert.deepEqual(out, { ok: true, status: 200, reason: null, gone: false });
    assert.equal(apple.sent.length, 1);
    const call = apple.sent[0];
    assert.equal(call.url, `${APNS_HOSTS.sandbox}/3/device/${TOKEN_A}`);
    assert.equal(call.headers['apns-topic'], APP_BUNDLE_ID);
    assert.equal(call.headers['apns-push-type'], 'alert');
    assert.match(call.headers.authorization, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(call.body, { aps: { alert: { body: 'Your Twilight is ready.' }, sound: 'default' }, jobId: 'job_1' });

    await sendPush(env, { token: TOKEN_B, environment: 'production' }, { body: 'x', jobId: 'job_2' });
    assert.equal(apple.sent[1].url, `${APNS_HOSTS.production}/3/device/${TOKEN_B}`);
  } finally { apple.restore(); resetApnsTokenCache(); }
});

test("a dead token is reported as gone; Apple being down is not", async () => {
  resetApnsTokenCache();
  const key = await makeKey(); const env = makeEnv(null, key);
  const apple = stubApple(call => call.url.endsWith(TOKEN_A)
    ? new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })
    : new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }));
  try {
    assert.equal((await sendPush(env, { token: TOKEN_A, environment: 'production' }, { body: 'x' })).gone, true);
    assert.equal((await sendPush(env, { token: TOKEN_B, environment: 'production' }, { body: 'x' })).gone, true);
  } finally { apple.restore(); }
  const down = stubApple(() => { throw new Error('ECONNRESET'); });
  try {
    const out = await sendPush(env, { token: TOKEN_A, environment: 'production' }, { body: 'x' });
    assert.equal(out.ok, false); assert.equal(out.gone, false, 'an outage is not a reason to forget the phone');
  } finally { down.restore(); resetApnsTokenCache(); }
});

test('the wording: ready, or came back with credits returned', () => {
  assert.equal(jobFinishedMessage({ transformation: 'twilight', status: 'delivered' }), 'Your Twilight is ready.');
  assert.equal(jobFinishedMessage({ transformation: 'staging', status: 'delivered' }), 'Your Virtual Staging is ready.');
  assert.equal(jobFinishedMessage({ transformation: 'empty', status: 'rejected' }), 'Your Empty Room came back — credits returned.');
  assert.equal(jobFinishedMessage({ transformation: 'declutter', status: 'failed' }), 'Your Declutter came back — credits returned.');
  assert.equal(pushConfigured({}), false);
  assert.equal(pushConfigured({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'p' }), true);
});

/* ------------------------------------------------------------ the routes */

test('a phone registers, moves with whoever signs in on it, and forgets itself at sign-out', async () => {
  const db = new TestD1(); const key = await makeKey(); const env = makeEnv(db, key); const ctx = testCtx();
  const a = await signedUp(env, ctx, 'a@example.com');
  const store = new Store(db);

  const res = await worker.fetch(post('/api/devices', { token: TOKEN_A.toUpperCase(), environment: 'sandbox' }, { cookie: a.cookie }), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual((await store.devicesForAccount(a.account.id)).map(d => [d.token, d.environment]), [[TOKEN_A, 'sandbox']], 'stored lowercase');

  // The same phone, registered again by another account, belongs to that account now.
  const b = await signedUp(env, ctx, 'b@example.com');
  await worker.fetch(post('/api/devices', { token: TOKEN_A, environment: 'production' }, { cookie: b.cookie }), env, ctx);
  assert.equal((await store.devicesForAccount(a.account.id)).length, 0);
  assert.deepEqual((await store.devicesForAccount(b.account.id)).map(d => d.environment), ['production']);

  // Only your own phone can be forgotten by you; sign-out forgets it.
  await worker.fetch(del(`/api/devices/${TOKEN_A}`, { cookie: a.cookie }), env, ctx);
  assert.equal((await store.devicesForAccount(b.account.id)).length, 1, "a's sign-out cannot touch b's phone");
  await worker.fetch(del(`/api/devices/${TOKEN_A}`, { cookie: b.cookie }), env, ctx);
  assert.equal((await store.devicesForAccount(b.account.id)).length, 0);

  // Rubbish is refused; nobody signed in is refused.
  assert.equal((await worker.fetch(post('/api/devices', { token: 'not-a-token' }, { cookie: a.cookie }), env, ctx)).status, 400);
  assert.equal((await worker.fetch(post('/api/devices', { token: TOKEN_A }), env, ctx)).status, 401);
  db.close();
});

/* --------------------------------------------------- when a job finishes */

async function jobFor(env, ctx, cookie, accountId) {
  const store = new Store(env.DB);
  const at = '2026-09-10T10:00:00.000Z';
  await store.createListing({ id: 'lst_1', accountId, address: 'Uploads', at });
  await store.createPhoto({ id: 'pho_1', listingId: 'lst_1', accountId, originalKey: `${accountId}/pho_1/original`, at });
  await store.createJob({ id: 'job_1', accountId, photoId: 'pho_1', transformation: 'twilight', attemptsAllowed: 3, at });
  return 'job_1';
}
const resultReq = (jobId, body) => new Request(`${SITE}/internal/jobs/${jobId}/result`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-pipeline-secret': 'pipeline-shared-secret' }, body: JSON.stringify(body),
});

test('a delivered result tells every phone on the account, once, and a dead phone is forgotten', async () => {
  resetApnsTokenCache();
  const db = new TestD1(); const key = await makeKey(); const env = makeEnv(db, key); const ctx = testCtx();
  const { cookie, account } = await signedUp(env, ctx);
  await worker.fetch(post('/api/devices', { token: TOKEN_A, environment: 'sandbox' }, { cookie }), env, ctx);
  await worker.fetch(post('/api/devices', { token: TOKEN_B, environment: 'production' }, { cookie }), env, ctx);
  const jobId = await jobFor(env, ctx, cookie, account.id);
  const apple = stubApple(call => call.url.endsWith(TOKEN_B)
    ? new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 })
    : new Response('{}', { status: 200 }));
  try {
    const res = await worker.fetch(resultReq(jobId, { jobId, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa('stamped') } }), env, ctx);
    assert.equal(res.status, 200);
    await ctx.settled();
    assert.deepEqual(apple.sent.map(c => c.body.aps.alert.body), ['Your Twilight is ready.', 'Your Twilight is ready.']);
    assert.deepEqual(apple.sent.map(c => c.body.jobId), [jobId, jobId]);
    assert.deepEqual((await new Store(db).devicesForAccount(account.id)).map(d => d.token), [TOKEN_A], 'the 410 phone is gone');

    // A second, late callback for the same job changes nothing and sends nothing.
    await worker.fetch(resultReq(jobId, { jobId, outcome: 'delivered', attemptsUsed: 2, image: { filename: 'r.jpg', base64: btoa('again') } }), env, ctx);
    await ctx.settled();
    assert.equal(apple.sent.length, 2);
  } finally { apple.restore(); resetApnsTokenCache(); }
  db.close();
});

test('a job that came back says so, and with no APNs key nothing is sent at all', async () => {
  resetApnsTokenCache();
  const db = new TestD1(); const key = await makeKey(); const env = makeEnv(db, key); const ctx = testCtx();
  const { cookie, account } = await signedUp(env, ctx);
  await worker.fetch(post('/api/devices', { token: TOKEN_A, environment: 'sandbox' }, { cookie }), env, ctx);
  const jobId = await jobFor(env, ctx, cookie, account.id);
  const apple = stubApple();
  try {
    await worker.fetch(resultReq(jobId, { jobId, outcome: 'rejected', attemptsUsed: 3, note: 'No compliant result was produced.' }), env, ctx);
    await ctx.settled();
    assert.deepEqual(apple.sent.map(c => c.body.aps.alert.body), ['Your Twilight came back — credits returned.']);
  } finally { apple.restore(); }

  const db2 = new TestD1(); const quiet = makeEnv(db2, key, { APNS_PRIVATE_KEY: undefined }); const ctx2 = testCtx();
  const s2 = await signedUp(quiet, ctx2);
  await worker.fetch(post('/api/devices', { token: TOKEN_A, environment: 'sandbox' }, { cookie: s2.cookie }), quiet, ctx2);
  const job2 = await jobFor(quiet, ctx2, s2.cookie, s2.account.id);
  const apple2 = stubApple();
  try {
    const res = await worker.fetch(resultReq(job2, { jobId: job2, outcome: 'delivered', attemptsUsed: 1, image: { filename: 'r.jpg', base64: btoa('stamped') } }), quiet, ctx2);
    assert.equal(res.status, 200, 'the job still finishes');
    await ctx2.settled();
    assert.equal(apple2.sent.length, 0);
  } finally { apple2.restore(); resetApnsTokenCache(); }
  db.close(); db2.close();
});
