/**
 * Listing Lab — the twilight look (Kyle, 10 Sep 2026).
 *
 * Every delivered Twilight is darkened a quarter stop and given a gentle
 * contrast curve before it is stamped. Kyle chose the numbers by eye from a
 * four-way comparison; the reference that made that comparison is NumPy,
 * and it is transcribed here so the Node table is held to it value for
 * value. Real pixels through sharp, as in colorlock.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { twilightLook, lookForType, toneValue, toneTable, DEFAULT_EV, DEFAULT_CONTRAST } = require(join(root, 'pipeline', 'tone.js'));
const { applyWatermark, verifyWatermark, DELIVERY_JPEG_QUALITY } = require(join(root, 'pipeline', 'watermark.js'));

/** TWILIGHT-LOOK.md §7, line for line: exposure in linear light, then the S-curve on the 0–255 value. */
function reference(v, ev, amt) {
  let lin = Math.pow(v / 255, 2.2);
  lin = Math.min(1, Math.max(0, lin * Math.pow(2, ev)));
  const exposed = Math.pow(lin, 1 / 2.2) * 255;
  const x = exposed / 255;
  const y = x + amt * (x - 0.5) * (1 - Math.abs(2 * x - 1));
  return Math.min(1, Math.max(0, y)) * 255;
}

const flat = (v, w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } }).jpeg({ quality: 100 }).toBuffer();
async function centre(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = ((info.height >> 1) * info.width + (info.width >> 1)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

test('the approved numbers are the defaults', () => {
  assert.equal(DEFAULT_EV, -0.25);
  assert.equal(DEFAULT_CONTRAST, 0.35);
});

test('every one of the 256 values matches the reference implementation within ±1', () => {
  const table = toneTable(DEFAULT_EV, DEFAULT_CONTRAST);
  for (let v = 0; v < 256; v++) {
    const want = reference(v, DEFAULT_EV, DEFAULT_CONTRAST);
    assert.ok(Math.abs(table[v] - want) <= 1, `value ${v}: table ${table[v]}, reference ${want.toFixed(2)}`);
    assert.equal(table[v], toneValue(v, DEFAULT_EV, DEFAULT_CONTRAST));
  }
  // The table is monotonic — the look never reverses the order of two tones.
  for (let v = 1; v < 256; v++) assert.ok(table[v] >= table[v - 1], `value ${v} lower than ${v - 1}`);
});

test('a flat mid-grey comes back darker, by exactly what the formula says', async () => {
  const out = await twilightLook(await flat(128));
  const [r, g, b] = await centre(out);
  const want = reference(128, DEFAULT_EV, DEFAULT_CONTRAST);   // ≈ 115
  for (const c of [r, g, b]) assert.ok(Math.abs(c - want) <= 1, `got ${c}, formula says ${want.toFixed(2)}`);
  assert.ok(r < 128, 'darker than it went in');
});

test('black stays black; white lands exactly where the reference puts it', async () => {
  const [w] = await centre(await twilightLook(await flat(255)));
  const [k] = await centre(await twilightLook(await flat(0)));
  assert.ok(Math.abs(k - 0) <= 1, `black became ${k}`);
  // The brief's checklist says white is "unchanged". The contrast curve does
  // taper to nothing at both ends, but the quarter-stop exposure step still
  // lowers white — to 241 by the reference maths the brief says to match.
  // The reference wins (TWILIGHT-LOOK.md §7 and "do not improve the curve");
  // the discrepancy is recorded in HANDBACK.md.
  const want = reference(255, DEFAULT_EV, DEFAULT_CONTRAST);
  assert.ok(Math.abs(w - want) <= 1, `white landed at ${w}, reference says ${want.toFixed(2)}`);
  assert.equal(Math.round(want), 241);
});

test('ev 0 and contrast 0 together are an exact no-op: the same bytes come back', async () => {
  const buf = await flat(90);
  const out = await twilightLook(buf, { ev: 0, contrast: 0 });
  assert.equal(out, buf, 'the very same buffer, not a re-encode');
  const table = toneTable(0, 0);
  for (let v = 0; v < 256; v++) assert.equal(table[v], v);
});

test('the look is applied to twilight and to nothing else', async () => {
  const buf = await flat(128);
  for (const type of ['declutter', 'empty', 'staging']) {
    assert.equal(await lookForType(type, buf), buf, `${type} must pass through untouched`);
  }
  const toned = await lookForType('twilight', buf);
  assert.notEqual(toned, buf);
  const [v] = await centre(toned);
  assert.ok(v < 128);
});

test('the frame keeps its size, and the delivered twilight still verifies its stamp', async () => {
  // A gradient with some texture, large enough for the stamp geometry.
  const W = 1024, H = 768;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    raw[i] = (x / W) * 200 + 20; raw[i + 1] = (y / H) * 160 + 40; raw[i + 2] = ((x + y) % 97) + 60;
  }
  const photo = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: DELIVERY_JPEG_QUALITY }).toBuffer();
  const toned = await twilightLook(photo);
  const meta = await sharp(toned).metadata();
  assert.equal(meta.width, W); assert.equal(meta.height, H);
  assert.equal(meta.format, 'jpeg');

  const stamped = await applyWatermark(toned, 'Virtual twilight');
  const check = await verifyWatermark(stamped, 'Virtual twilight', toned);
  assert.equal(check.present, true, JSON.stringify(check));
});
