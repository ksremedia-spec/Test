/**
 * Model-level fallback, tested with fake doors — no network, no API cost.
 *
 * On 27 Aug 2026 gemini-3-pro-image returned 500 "high demand" for ~5 hours and
 * the product could not produce a photograph, because both doors (developer API,
 * Vertex) reach that ONE model. This proves the missing rung: when the model is
 * down at the door, generateImage draws the same job on the fallback model.
 * Written because the live outage ended mid-test and "trust me it's wired" is
 * not proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const transform = require(join(here, '..', 'pipeline', 'transform.js'));
const { setDeadline } = require(join(here, '..', 'pipeline', 'gemini.js'));

const IMG = { data: Buffer.from('fake-jpeg').toString('base64'), mime_type: 'image/jpeg' };

test('when the primary model is down at the door, the job draws on the fallback model', async () => {
  setDeadline(Date.now() + 5 * 60_000);           // plenty of time left
  const seen = [];
  // Both doors behave the same: pro-image is overloaded, flash-image answers.
  const door = async (_k, _p, _i, _m, opts) => {
    const model = opts.model || 'gemini-3-pro-image';
    seen.push(model);
    if (/pro-image/.test(model)) throw new Error('Gemini 500: gemini-3-pro-image is currently experiencing high demand');
    return { ...IMG };
  };
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(out.model, transform.FALLBACK_MODEL, 'the delivered image was drawn by the fallback model');
    assert.equal(out.usedFallbackModel, true, 'and it is marked as a fallback draw');
    assert.ok(seen.some(m => /pro-image/.test(m)), 'it tried the primary first');
    assert.ok(seen.includes(transform.FALLBACK_MODEL), 'then fell to the fallback');
  } finally {
    transform._setDoors({});
  }
});

test('a healthy primary model is never downgraded to the fallback', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  const seen = [];
  const door = async (_k, _p, _i, _m, opts) => { seen.push(opts.model || 'gemini-3-pro-image'); return { ...IMG }; };
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.notEqual(out.model, transform.FALLBACK_MODEL, 'a working primary is used, not the fallback');
    assert.ok(!seen.includes(transform.FALLBACK_MODEL), 'the fallback was never asked');
  } finally {
    transform._setDoors({});
  }
});

test('a rate limit (429) at every door falls back to the flash model', async () => {
  // POLICY REVERSED 31 Aug 2026. The original rule — "a 429 clears in under a
  // minute and must never downgrade quality" — was disproven in beta: parallel
  // testers kept the pro model's per-minute quota saturated continuously, every
  // outage-queue retry re-tripped it, and two declutters sat "working" for over
  // an hour while the fallback never engaged. By the time generateViaDoors
  // throws a 429, BOTH doors have retried through it; flash draws against a
  // separate quota and actually answers. A softer image beats no image.
  setDeadline(Date.now() + 5 * 60_000);
  const seen = [];
  const door = async (_k, _p, _i, _m, opts) => {
    const model = opts.model || 'gemini-3-pro-image';
    seen.push(model);
    if (/pro-image/.test(model)) throw new Error('Gemini 429: rate limit exceeded');
    return { ...IMG };
  };
  transform._setDoors({ nano: door, vertex: door });
  try {
    const out = await transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', {});
    assert.equal(out.model, transform.FALLBACK_MODEL, 'a saturated pro quota falls through to flash');
    assert.equal(out.usedFallbackModel, true, 'and the draw is marked as a fallback');
    assert.ok(seen.some(m => /pro-image/.test(m)), 'the primary was still tried first');
  } finally {
    transform._setDoors({});
  }
});

test('a 429 with the fallback disabled still surfaces as an error', async () => {
  setDeadline(Date.now() + 5 * 60_000);
  // With MODEL_FALLBACK off there is no rung below the primary — the 429 must
  // come out as a retryable error for the outage queue, not vanish.
  const door = async () => { throw new Error('Gemini 429: rate limit exceeded'); };
  transform._setDoors({ nano: door, vertex: door });
  const prev = process.env.MODEL_FALLBACK;
  try {
    await assert.rejects(
      () => transform.generateImage('key', 'prompt', IMG.data, 'image/jpeg', { model: transform.FALLBACK_MODEL }),
      /429/, 'a 429 on the fallback model itself has nowhere lower to go');
  } finally {
    transform._setDoors({});
    if (prev === undefined) delete process.env.MODEL_FALLBACK; else process.env.MODEL_FALLBACK = prev;
  }
});
