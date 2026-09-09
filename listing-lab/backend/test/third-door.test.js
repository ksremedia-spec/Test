/**
 * The third door (31 Aug 2026): fal.ai serving the SAME pro model from its own
 * capacity, knocked only when both Google doors are jammed, BEFORE any drop to
 * flash. Kyle's week: six "high demand" windows, doors failing separately, and
 * a Luxury staging that flash could not carry — the identical model through
 * one more counter beats a different model every time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const transform = require(join(root, 'pipeline', 'transform.js'));
const { setDeadline } = require(join(root, 'pipeline', 'gemini.js'));

const IMG = { data: Buffer.from('fake-jpeg').toString('base64'), mime_type: 'image/jpeg' };
const FAL_OK = JSON.stringify({ images: [{ url: 'https://fal.media/fake/result.jpg', content_type: 'image/jpeg' }] });

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

test('both Google doors shut → the SAME model is served through fal, not downgraded to flash', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  process.env.FAL_KEY = 'fal-test-key';
  const seenModels = [];
  let falAsked = 0;
  // Google's doors: pro is overloaded at both.
  const door = async (_k, _p, _i, _m, opts) => {
    seenModels.push(opts.model || 'gemini-3-pro-image');
    throw new Error('Gemini 500: gemini-3-pro-image is currently experiencing high demand');
  };
  // fal: answers with an image URL, then the download.
  const restore = stubFetch(async (url) => {
    if (String(url).includes('fal.run')) { falAsked++; return new Response(FAL_OK, { status: 200 }); }
    if (String(url).includes('fal.media')) return new Response(Buffer.from('real-jpeg-bytes'), { status: 200 });
    throw new Error('unexpected fetch: ' + url);
  });
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(falAsked, 1, 'the third door was knocked');
    assert.equal(out.model, 'gemini-3-pro-image', 'the delivered image is still the PRO model');
    assert.equal(out.door, 'fal', 'and it is marked as served through fal');
    assert.ok(!out.usedFallbackModel, 'no quality downgrade happened');
    assert.ok(!seenModels.includes(transform.FALLBACK_MODEL), 'flash was never asked');
    assert.equal(out.data, Buffer.from('real-jpeg-bytes').toString('base64'), 'the image bytes came home');
  } finally {
    transform._setDoors({}); restore(); setDeadline(null); delete process.env.FAL_KEY;
  }
});

test('the third door failing too still lands on flash — the ladder keeps its last rung', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  process.env.FAL_KEY = 'fal-test-key';
  const seenModels = [];
  const door = async (_k, _p, _i, _m, opts) => {
    const model = opts.model || 'gemini-3-pro-image';
    seenModels.push(model);
    if (/pro-image/.test(model)) throw new Error('Gemini 500: currently experiencing high demand');
    return { ...IMG };
  };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('fal.run')) return new Response('{"detail":"capacity"}', { status: 503 });
    throw new Error('unexpected fetch: ' + url);
  });
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(out.model, transform.FALLBACK_MODEL, 'flash still catches the job');
    assert.equal(out.usedFallbackModel, true);
  } finally {
    transform._setDoors({}); restore(); setDeadline(null); delete process.env.FAL_KEY;
  }
});

test('without FAL_KEY nothing changes, and the container passes the key like the others', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  delete process.env.FAL_KEY;
  let falAsked = 0;
  const door = async (_k, _p, _i, _m, opts) => {
    if (/pro-image/.test(opts.model || 'gemini-3-pro-image')) throw new Error('Gemini 500: high demand');
    return { ...IMG };
  };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('fal')) { falAsked++; return new Response(FAL_OK, { status: 200 }); }
    throw new Error('unexpected fetch: ' + url);
  });
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(falAsked, 0, 'no key, no knock');
    assert.equal(out.model, transform.FALLBACK_MODEL, 'behaviour is exactly the pre-fal ladder');
  } finally {
    transform._setDoors({}); restore(); setDeadline(null);
  }
  const w = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  assert.match(w, /env\.FAL_KEY \? \{ FAL_KEY/, 'the container receives FAL_KEY like the other keys');
});

test('STORM MODE: both Google models down at every route → FLUX via fal, same checks', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  process.env.FAL_KEY = 'fal-test-key';
  let nanoProAsked = 0, fluxAsked = 0;
  // Every Google door refuses both models; fal's nano door refuses; flux answers.
  const door = async (_k, _p, _i, _m, opts) => {
    if (/pro-image/.test(opts.model || 'gemini-3-pro-image')) nanoProAsked++;
    throw new Error('Gemini 500: currently experiencing high demand');
  };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('nano-banana-pro')) return new Response('{"detail":"capacity"}', { status: 503 });
    if (String(url).includes('flux-2-pro')) { fluxAsked++; return new Response(FAL_OK, { status: 200 }); }
    if (String(url).includes('fal.media')) return new Response(Buffer.from('flux-bytes'), { status: 200 });
    throw new Error('unexpected fetch: ' + url);
  });
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(fluxAsked, 1, 'the storm rung was knocked');
    assert.equal(out.model, 'flux-2-pro', 'the frame is honestly labelled as FLUX');
    assert.equal(out.usedFallbackModel, true, 'and marked as a fallback draw for the wide colour door');
    assert.equal(out.data, Buffer.from('flux-bytes').toString('base64'));
  } finally {
    transform._setDoors({}); restore(); setDeadline(null); delete process.env.FAL_KEY;
  }
});

test('storm mode failing re-throws the familiar outage — the queue sees the usual story', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  process.env.FAL_KEY = 'fal-test-key';
  const door = async () => { throw new Error('Gemini 500: currently experiencing high demand'); };
  const restore = stubFetch(async (url) => new Response('{"detail":"down"}', { status: 503 }));
  transform._setDoors({ nano: door, vertex: door });
  try {
    await assert.rejects(
      () => transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {}),
      /high demand/, 'the flash outage error surfaces, which the whole chain already understands');
  } finally {
    transform._setDoors({}); restore(); setDeadline(null); delete process.env.FAL_KEY;
  }
});

test('slash-named room types never reach a file path', async () => {
  // 'Basement / Rec Room' split the output path into a nonexistent directory —
  // FATAL ENOENT on the first slash-named staging in production (31 Aug 2026).
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../pipeline/transform.js', import.meta.url), 'utf8');
  const m = src.match(/const tag = \[type, options\.style, options\.room\][^\n]*/);
  assert.ok(m, 'the tag is built in one visible place');
  assert.match(m[0], /\[\^A-Za-z0-9-\]/, 'the tag strips everything path-hostile, not just spaces');
  // Prove it on the two slash-bearing menu entries.
  const mk = (room) => ['staging', 'Luxury', room].filter(Boolean).join('-').replace(/[^A-Za-z0-9-]+/g, '');
  assert.equal(mk('Basement / Rec Room'), 'staging-Luxury-BasementRecRoom');
  assert.equal(mk('Nursery / Kids Room'), 'staging-Luxury-NurseryKidsRoom');
  assert.ok(!mk('Basement / Rec Room').includes('/'));
});

test('with fal standing ready, Google never gets the long goodbye', async () => {
  // 1 Sep 2026, Kyle: "why are we waiting for Google when there's fal?" A job
  // died 'not enough time left for the third door' because after two brisk
  // knocks the ladder went BACK to Google with full patience — five long
  // tries at a provider that had already refused — before fal was considered.
  // With FAL_KEY set: two knocks per Google door, then straight to fal.
  setDeadline(Date.now() + 5 * 60_000);
  process.env.FAL_KEY = 'fal-test-key';
  process.env.FAL_FIRST = '0'; // this test pins the GOOGLE-FIRST fallback ladder's shape
  process.env.VERTEX_API_KEY = 'vx-test'; // both Google doors exist for this test
  let doorKnocks = 0;
  const patienceSeen = [];
  const door = async (_k, _p, _i, _m, opts) => {
    if (/pro-image/.test(opts.model || 'gemini-3-pro-image')) {
      doorKnocks++;
      patienceSeen.push(opts.retries);
      throw new Error('Gemini 503: currently experiencing high demand');
    }
    return { ...IMG };
  };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('fal.run')) return new Response(FAL_OK, { status: 200 });
    if (String(url).includes('fal.media')) return new Response(Buffer.from('bytes'), { status: 200 });
    throw new Error('unexpected fetch: ' + url);
  });
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(out.door, 'fal', 'the job landed on fal');
    assert.equal(doorKnocks, 2, `two brisk Google knocks, never a third with full patience (got ${doorKnocks})`);
    assert.ok(patienceSeen.every(r => r === 1), 'BOTH doors got the brisk retries, not just the first');
  } finally {
    transform._setDoors({}); restore(); setDeadline(null); delete process.env.FAL_KEY; delete process.env.FAL_FIRST; delete process.env.VERTEX_API_KEY;
  }
});


test('FAL FIRST: the calm counter is asked before Google is bothered at all', async () => {
  // 1 Sep 2026, Kyle: 'Google is so wishy washy. Why don't we just go to fal
  // first?' — flipped with the numbers on the table (+1.6c/image). The ladder
  // is reordered, not shortened: fal, then Google's two doors, then flash,
  // then FLUX. FAL_FIRST=0 restores the old order (pinned above).
  setDeadline(Date.now() + 5 * 60_000);
  process.env.FAL_KEY = 'fal-test-key';
  delete process.env.FAL_FIRST;
  let googleKnocks = 0, falAsked = 0;
  const door = async () => { googleKnocks++; throw new Error('Gemini 503: high demand'); };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('fal.run')) { falAsked++; return new Response(FAL_OK, { status: 200 }); }
    if (String(url).includes('fal.media')) return new Response(Buffer.from('bytes'), { status: 200 });
    throw new Error('unexpected fetch: ' + url);
  });
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(falAsked, 1, 'fal is the front door');
    assert.equal(googleKnocks, 0, 'Google is never bothered when fal answers');
    assert.equal(out.door, 'fal');
    assert.equal(out.model, 'gemini-3-pro-image', 'same model, calmer counter');

    // And when fal refuses, Google is still right there behind it.
    const restore2 = stubFetch(async (url) => {
      if (String(url).includes('fal.run')) return new Response('{"detail":"capacity"}', { status: 503 });
      throw new Error('unexpected fetch: ' + url);
    });
    transform._setDoors({ nano: async (_k,_p,_i,_m,o) => ({ ...IMG }), vertex: async () => ({ ...IMG }) });
    try {
      const out2 = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
      assert.equal(out2.model, 'gemini-3-pro-image', 'Google catches what fal drops');
      assert.ok(!out2.door, 'served through a Google door, not fal');
    } finally { restore2(); }
  } finally {
    transform._setDoors({}); restore(); setDeadline(null); delete process.env.FAL_KEY;
  }
});
