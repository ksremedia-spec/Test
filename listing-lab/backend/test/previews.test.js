/**
 * Listing Lab — small previews for the app's My photos grid (10 Sep 2026).
 *
 * Kyle's phone downloaded sixty full-size photos to fill a grid of tiles.
 * Now `?preview=1` asks for a 640-pixel copy, made once by Cloudflare's
 * image tool and kept in R2 beside the photo. The rule that matters most:
 * a preview problem never hides a photo — anything that stops a preview
 * being made serves the full photo instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestR2, TestImages, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';

const SITE = 'https://listinglab.test';
const PHOTO = new TextEncoder().encode('FULL-SIZE PHOTO BYTES');

function makeEnv(db, extra = {}) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    PHOTOS: new TestR2(),
    IMAGES: new TestImages(),
    ASSETS: { fetch: async () => new Response('asset') },
    ...extra,
  };
}
const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });

/** An account with one delivered job and its photo in storage. */
async function seeded(env, ctx) {
  const res = await worker.fetch(post('/api/signup', { email: 'agent@example.com', password: 'password-one-two' }), env, ctx);
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { account } = await res.json();
  const store = new Store(env.DB);
  const at = '2026-09-10T10:00:00.000Z';
  await store.createListing({ id: 'lst_1', accountId: account.id, address: 'Uploads', at });
  const originalKey = `${account.id}/pho_1/original`;
  const resultKey = `${account.id}/pho_1/job_1-result.jpg`;
  await store.createPhoto({ id: 'pho_1', listingId: 'lst_1', accountId: account.id, originalKey, at });
  await store.createJob({ id: 'job_1', accountId: account.id, photoId: 'pho_1', transformation: 'empty', attemptsAllowed: 3, at });
  await store.finishJob({ jobId: 'job_1', status: 'delivered', resultKey, variantKeys: [], at });
  await env.PHOTOS.put(originalKey, PHOTO, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.PHOTOS.put(resultKey, PHOTO, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.PHOTOS.put(`${account.id}/pho_1/job_1-result-clean.jpg`, PHOTO, { httpMetadata: { contentType: 'image/jpeg' } });
  return { cookie, account, originalKey, resultKey, enc: k => encodeURIComponent(k) };
}

test('the first preview request shrinks the photo once and keeps the copy; the next is a plain read', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, resultKey, enc } = await seeded(env, ctx);

  const first = await worker.fetch(get(`/api/photos/${enc(resultKey)}?preview=1`, { cookie }), env, ctx);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/jpeg');
  assert.match(first.headers.get('cache-control'), /immutable/);
  assert.equal(await first.text(), 'PREVIEW width=640 image/jpeg');
  assert.equal(env.IMAGES.calls.length, 1);
  assert.deepEqual(env.IMAGES.calls[0].transform, { width: 640 }, 'width only — one billable shrink per photo');
  assert.deepEqual(env.IMAGES.calls[0].output, { format: 'image/jpeg', quality: 82 });
  assert.ok(env.PHOTOS.objects.has(`${resultKey}-preview.jpg`), 'the copy is kept beside the photo');

  const second = await worker.fetch(get(`/api/photos/${enc(resultKey)}?preview=1`, { cookie }), env, ctx);
  assert.equal(await second.text(), 'PREVIEW width=640 image/jpeg');
  assert.equal(env.IMAGES.calls.length, 1, 'served from storage, not shrunk again');

  // The full photo is untouched, with or without the flag elsewhere.
  const full = await worker.fetch(get(`/api/photos/${enc(resultKey)}`, { cookie }), env, ctx);
  assert.equal(await full.text(), 'FULL-SIZE PHOTO BYTES');
  const download = await worker.fetch(get(`/api/photos/${enc(resultKey)}?preview=1&download=1`, { cookie }), env, ctx);
  assert.equal(await download.text(), 'FULL-SIZE PHOTO BYTES', 'a download is never the small copy');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  db.close();
});

test('a preview problem never hides a photo: no tool, a broken tool, or a photo too big all serve the full photo', async () => {
  for (const [name, extra] of [
    ['no binding', { IMAGES: undefined }],
    ['tool throws', { IMAGES: new TestImages({ fail: true }) }],
  ]) {
    const db = new TestD1(); const env = makeEnv(db, extra); const ctx = testCtx();
    const { cookie, originalKey, enc } = await seeded(env, ctx);
    const res = await worker.fetch(get(`/api/photos/${enc(originalKey)}?preview=1`, { cookie }), env, ctx);
    assert.equal(res.status, 200, name);
    assert.equal(await res.text(), 'FULL-SIZE PHOTO BYTES', name);
    assert.ok(!env.PHOTOS.objects.has(`${originalKey}-preview.jpg`), `${name}: nothing half-made is kept`);
    db.close();
  }

  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, originalKey, enc } = await seeded(env, ctx);
  await env.PHOTOS.put(originalKey, new Uint8Array(20 * 1024 * 1024 + 1), { httpMetadata: { contentType: 'image/jpeg' } });
  const big = await worker.fetch(get(`/api/photos/${enc(originalKey)}?preview=1`, { cookie }), env, ctx);
  assert.equal(big.status, 200);
  assert.equal((await big.arrayBuffer()).byteLength, 20 * 1024 * 1024 + 1, 'over the tool\'s limit: the full photo, untouched');
  assert.equal(env.IMAGES.calls.length, 0);
  db.close();
});

test('the clean copy has no preview either, and a preview is only ever of your own photo', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account, enc } = await seeded(env, ctx);
  const clean = await worker.fetch(get(`/api/photos/${enc(`${account.id}/pho_1/job_1-result-clean.jpg`)}?preview=1`, { cookie }), env, ctx);
  assert.equal(clean.status, 404);
  const other = await worker.fetch(get(`/api/photos/${enc('acct_someone_else/pho_9/original')}?preview=1`, { cookie }), env, ctx);
  assert.equal(other.status, 404);
  assert.equal(env.IMAGES.calls.length, 0);
  db.close();
});

test('the job list carries a preview link: the result when there is one, else the original', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie, account, resultKey, originalKey, enc } = await seeded(env, ctx);
  const store = new Store(db);
  await store.createJob({ id: 'job_2', accountId: account.id, photoId: 'pho_1', transformation: 'declutter', attemptsAllowed: 3, at: '2026-09-10T11:00:00.000Z' });

  const res = await worker.fetch(get('/api/jobs', { cookie }), env, ctx);
  const { jobs } = await res.json();
  const byId = Object.fromEntries(jobs.map(j => [j.jobId, j]));
  assert.equal(byId.job_1.previewUrl, `/api/photos/${enc(resultKey)}?preview=1`);
  assert.equal(byId.job_1.resultUrl, `/api/photos/${enc(resultKey)}`, 'the full links are as before');
  assert.equal(byId.job_2.previewUrl, `/api/photos/${enc(originalKey)}?preview=1`, 'a job still working shows its original');
  db.close();
});
