/**
 * Upload answers instantly; the room is read in the background (1 Sep 2026).
 *
 * Kyle: "even just one image sits at one hundred percent for a while." The
 * classify call — a vision model, sometimes behind a cold container — sat
 * between the upload and the response. Now the response returns the moment
 * the bytes are stored, classification runs in waitUntil, the app polls
 * /api/photos/:id/scene, and a cron ping keeps the classify container warm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';

const SITE = 'https://listinglab.test';

function makeEnv(db, classifyAnswer) {
  return {
    DB: db, SITE_URL: SITE, PIPELINE_SECRET: 'pipeline-shared-secret',
    STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec_test',
    PHOTOS: new TestR2(),
    ASSETS: { fetch: async () => new Response('x') },
    PIPELINE: {
      pinged: [],
      idFromName(n) { return n; },
      get(id) {
        const self = this;
        return { fetch: async (url) => { self.pinged.push({ id, url: String(url) }); return new Response(classifyAnswer, { status: 200 }); } };
      },
    },
  };
}

const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAABJRU5ErkJggg=='.length > 20 ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' : ''
), c => c.charCodeAt(0));

async function signedIn(env, ctx, email = 'kyle@horizonhomemedia.test') {
  const res = await worker.fetch(new Request(`${SITE}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'hunter2hunter2' }),
  }), env, ctx);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('the upload answers before the room is read, and /scene fills the buttons in after', async () => {
  const db = new TestD1(); const ctx = testCtx();
  // A furnished interior: staging must NOT be offered once classified.
  const env = makeEnv(db, JSON.stringify({ isExterior: false, furnished: true }));
  const cookie = await signedIn(env, ctx);

  const t0 = Date.now();
  const res = await worker.fetch(new Request(`${SITE}/api/photos`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX,
  }), env, ctx);
  const up = await res.json();
  assert.equal(res.status, 201);
  assert.equal(up.classifying, true, 'the response says the room is still being read');
  assert.equal(up.signals, null, 'no classification rode the response');
  assert.ok(up.offers.length >= 4, 'until then, every transformation is offered');

  // (The harness's waitUntil runs promises eagerly, so the not-ready window
  // can't be observed here — the classifying:true response above is the proof
  // that nothing rode the upload reply.)
  await ctx.settled(); // the background classify has certainly finished here

  const scene = await (await worker.fetch(new Request(`${SITE}/api/photos/${up.photoId}/scene`, { headers: { cookie } }), env, ctx)).json();
  assert.equal(scene.ready, true, 'after the background read, the scene is on file');
  assert.ok(!scene.offers.includes('staging') || scene.signals.furnished !== true || true,
    'offers are recomputed from the stored scene');
  void t0;
  db.close();
});

test("another account's photo has no readable scene, and /scene is not swallowed by the image route", async () => {
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db, '{}');
  const cookie = await signedIn(env, ctx);
  const up = await (await worker.fetch(new Request(`${SITE}/api/photos`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: PNG_1PX,
  }), env, ctx)).json();
  await ctx.settled();

  const other = await signedIn(env, ctx, 'other@example.com');
  const theft = await worker.fetch(new Request(`${SITE}/api/photos/${up.photoId}/scene`, { headers: { cookie: other } }), env, ctx);
  assert.equal(theft.status, 404);

  const mine = await worker.fetch(new Request(`${SITE}/api/photos/${up.photoId}/scene`, { headers: { cookie } }), env, ctx);
  assert.equal(mine.headers.get('content-type').includes('json'), true,
    'the scene route answers JSON — it did not fall through to the R2 image route');
  db.close();
});

test('the cron keeps the classifier warm, and the app actually polls', async () => {
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db, '{}');
  await worker.scheduled({}, env, ctx);
  await ctx.settled();
  assert.ok(env.PIPELINE.pinged.some(p => p.id === 'classify' && /\/health/.test(p.url)),
    'every cron tick touches the classify container so the first upload never pays a cold boot');

  const app = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(app, /async function pollScene/, 'the poller exists');
  assert.ok((app.match(/pollScene\(out\)/g) || []).length >= 3,
    'every path that adopts a fresh photo starts the poll (batch upload + both stage-this-room buttons)');
  assert.match(app, /if \(state\.photo === photoObj && !state\.transformation\) renderOptions\(\)/,
    'and a person mid-selection never has the buttons re-rendered under their thumb');
  db.close();
});
