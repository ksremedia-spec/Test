/**
 * Listing Lab — masked declutter, the pixel math under oath.
 *
 * These tests run on synthetic images (no API, no cost) and pin down the three
 * promises the architecture makes:
 *   1. a fill that removed the clutter AND matched the surroundings is used;
 *   2. a fill that hallucinated around the region is refused;
 *   3. a fill that changed nothing is refused (it "passes" every ring);
 * and the composite promise itself: pixels outside every region are the
 * ORIGINAL's, bit-for-bit within JPEG tolerance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sharp = require(join(root, 'node_modules', 'sharp'));
const { regionRect, rasterizePolys, scoreFill, assemble } = require(join(root, 'pipeline', 'maskedit.js'));

const W = 300, H = 200;

/** Solid-colour canvas with an optional square painted on it. */
async function frame(bg, squares = []) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="${bg}"/>
    ${squares.map(s => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${s.fill}"/>`).join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

// The "clutter": a red square at (100,60)..(140,100). Its polygon in the
// 0-1000 normalized [y,x] convention the segmenter uses.
const SQ = { x: 100, y: 60, w: 40, h: 40, fill: '#c03030' };
const polygon = [
  [SQ.y / H * 1000, SQ.x / W * 1000],
  [SQ.y / H * 1000, (SQ.x + SQ.w) / W * 1000],
  [(SQ.y + SQ.h) / H * 1000, (SQ.x + SQ.w) / W * 1000],
  [(SQ.y + SQ.h) / H * 1000, SQ.x / W * 1000],
];
const region = { label: 'red box', polygons: [polygon] };

const OPTS = { dilatePx: 4, ringPx: 12 };
const asFill = (buf, name) => ({ buf, left: 0, top: 0, width: W, height: H, name });

test('a faithful fill (clutter gone, surroundings intact) scores clean and is used', async () => {
  const orig = await frame('#888', [SQ]);
  const fill = asFill(await frame('#888'), 'good');           // square removed
  const s = await scoreFill(orig, fill, region, [region], W, H, OPTS);
  assert.ok(s.inside > 8, `interior changed a lot (got ${s.inside.toFixed(1)})`);
  assert.ok(s.ring < 9, `ring quiet (got ${s.ring.toFixed(1)})`);

  const { cleaned, kept, plan } = await assemble(orig, [region], [fill], W, H);
  assert.equal(cleaned, 1);
  assert.equal(kept, 0);
  assert.equal(plan[0].from, 'good');
});

test('a hallucinating fill (surroundings repainted) is refused; region keeps original', async () => {
  const orig = await frame('#888', [SQ]);
  // Square removed BUT the strip IMMEDIATELY beside the region was repainted —
  // the model "reconstructed" furniture that was never clutter. It has to sit
  // in the ring (the blend neighbourhood): hallucination farther away is
  // harmless by construction, because those pixels are discarded originals.
  // A BLATANT repaint since the tolerance moved 15 → 24 (2 Sep 2026): the
  // gate is a pre-filter for genuinely misaligned fills (ring 25+); the
  // borderline band it used to refuse — which included honest fills the
  // whole-frame render made — now passes through to the one judge, which
  // guards every composite anyway.
  const bad = asFill(await frame('#888', [{ x: 141, y: 45, w: 30, h: 70, fill: '#000' }]), 'bad');
  const s = await scoreFill(orig, bad, region, [region], W, H, OPTS);
  assert.ok(s.ring > 24, `ring must catch the repaint (got ${s.ring.toFixed(1)})`);

  const { buf, cleaned, kept } = await assemble(orig, [region], [bad], W, H);
  assert.equal(cleaned, 0);
  assert.equal(kept, 1);
  // The square is still there — original pixels, not the bad fill's.
  const px = await sharp(buf).extract({ left: 118, top: 78, width: 4, height: 4 }).raw().toBuffer();
  assert.ok(px[0] > 120 && px[1] < 90, 'red clutter still present (kept original)');
});

test('a no-op fill (nothing changed) is refused despite its perfect ring', async () => {
  const orig = await frame('#888', [SQ]);
  const noop = asFill(await frame('#888', [SQ]), 'noop');      // identical
  const s = await scoreFill(orig, noop, region, [region], W, H, OPTS);
  assert.ok(s.ring < 3, 'ring is perfect — that is exactly the trap');
  assert.ok(s.inside < 8, `interior unchanged (got ${s.inside.toFixed(1)})`);
  const { cleaned, kept } = await assemble(orig, [region], [noop], W, H);
  assert.equal(cleaned, 0);
  assert.equal(kept, 1);
});

test('the composite outside every region is the original, and inside is the fill', async () => {
  const orig = await frame('#888', [SQ, { x: 220, y: 130, w: 30, h: 30, fill: '#3050c0' }]); // blue "furniture"
  const fill = asFill(await frame('#888'), 'good');            // fill would ALSO erase the furniture…
  const { buf, cleaned } = await assemble(orig, [region], [fill], W, H);
  assert.equal(cleaned, 1);
  // …but the furniture is outside the region, so it survives untouched.
  const blue = await sharp(buf).extract({ left: 230, top: 140, width: 4, height: 4 }).raw().toBuffer();
  assert.ok(blue[2] > 120 && blue[0] < 90, 'furniture outside the mask keeps ORIGINAL pixels');
  // And the clutter is gone: centre of the region reads background grey.
  const centre = await sharp(buf).extract({ left: 118, top: 78, width: 4, height: 4 }).raw().toBuffer();
  assert.ok(Math.abs(centre[0] - centre[2]) < 25 && centre[0] > 100, 'clutter region filled with cleaned surface');
});

test('a crop-local fill serves only the region it covers', async () => {
  const orig = await frame('#888', [SQ]);
  // Fill covers only a rect around the square (like a cropFill result).
  const rect = regionRect([polygon], W, H, 40);
  const cropClean = await sharp(await frame('#888')).extract(rect).jpeg({ quality: 95 }).toBuffer();
  const crop = { buf: cropClean, ...rect, name: 'crop' };
  const s = await scoreFill(orig, crop, region, [region], W, H, OPTS);
  assert.ok(s && s.inside > 8 && s.ring < 9, 'crop fill scores like a full-frame one');
  // A second region far outside the crop cannot be served by it.
  const farPoly = [[850, 750], [850, 950], [980, 950], [980, 750]];
  const far = { label: 'far item', polygons: [farPoly] };
  const s2 = await scoreFill(orig, crop, far, [region, far], W, H, OPTS);
  assert.equal(s2, null, 'a crop fill cannot serve a region it does not cover');
});

test('an untraceable region is kept, never box-filled', async () => {
  const orig = await frame('#888', [SQ]);
  const fill = asFill(await frame('#888'), 'good');
  const blind = { label: 'mystery item', polygons: null };
  const { cleaned, kept, plan } = await assemble(orig, [blind], [fill], W, H);
  assert.equal(cleaned, 0);
  assert.equal(kept, 1);
  assert.equal(plan[0].kept, 'untraceable');
});
