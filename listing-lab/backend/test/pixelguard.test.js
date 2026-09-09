/**
 * Pixel guard (1 Sep 2026; on by default after two clean full-pipeline
 * bench passes — PIXEL_GUARD=0 disables).
 *
 * Inside a catalogued fixed-feature box, pixels the model left essentially
 * unchanged snap back to the ORIGINAL photograph's exact pixels; meaningful
 * changes (new furniture crossing the feature, cast shadows) stay from the
 * candidate, with a feathered boundary. These tests prove the three promises
 * on synthetic frames where ground truth is exact.
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
const sharp = require(join(root, 'node_modules', 'sharp'));
const { pixelGuard } = require(join(root, 'pipeline', 'pixelguard.js'));

const W = 200, H = 100;

/** A flat grey frame with optional painted regions: [{x,y,w,h,rgb}] */
async function frame(regions = []) {
  const composites = regions.map(r => ({
    input: { create: { width: r.w, height: r.h, channels: 3, background: { r: r.rgb[0], g: r.rgb[1], b: r.rgb[2] } } },
    left: r.x, top: r.y,
  }));
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 120, g: 120, b: 120 } } })
    .composite(composites).png().toBuffer();
}

const px = async (buf, x, y) => {
  const { data } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const q = (y * W + x) * 3;
  return [data[q], data[q + 1], data[q + 2]];
};

test('drifted pixels inside a feature box snap back to the original exactly', async () => {
  // Original: a dark "window" at x 10-40%, y 10-90%. Candidate: the model
  // redrew it slightly lighter everywhere (drift ~8/255) — the classic
  // structural-fail-in-waiting.
  const original = await frame([{ x: 20, y: 10, w: 60, h: 80, rgb: [40, 40, 40] }]);
  const candidate = await frame([{ x: 20, y: 10, w: 60, h: 80, rgb: [48, 48, 48] }]);
  const gen = { data: candidate.toString('base64'), mime_type: 'image/png' };
  const out = await pixelGuard(sharp, original, gen, [{ name: 'window', kind: 'window', x_from: 10, x_to: 40, y_from: 10, y_to: 90 }]);
  const outBuf = Buffer.from(out.data, 'base64');
  const centre = await px(outBuf, 50, 50);
  assert.ok(Math.abs(centre[0] - 40) <= 2, `feature centre snapped to the original (got ${centre[0]}, want ~40)`);
  assert.ok(out.stats.snappedPct > 5, 'the stats admit real snapping happened');
  assert.equal(out.stats.perFeature[0].name, 'window');
});

test('a big change inside the box — new furniture crossing the feature — is KEPT from the candidate', async () => {
  const original = await frame([{ x: 20, y: 10, w: 60, h: 80, rgb: [40, 40, 40] }]);
  // Candidate: same window, plus a white "sofa arm" painted across its lower half.
  const candidate = await frame([
    { x: 20, y: 10, w: 60, h: 80, rgb: [40, 40, 40] },
    { x: 30, y: 60, w: 40, h: 30, rgb: [230, 230, 230] },
  ]);
  const gen = { data: candidate.toString('base64'), mime_type: 'image/png' };
  const out = await pixelGuard(sharp, original, gen, [{ name: 'window', kind: 'window', x_from: 10, x_to: 40, y_from: 10, y_to: 90 }]);
  const outBuf = Buffer.from(out.data, 'base64');
  const sofa = await px(outBuf, 50, 75);
  assert.ok(sofa[0] > 200, `the occluding furniture survives (got ${sofa[0]}, want ~230)`);
  const window = await px(outBuf, 30, 20);
  assert.ok(Math.abs(window[0] - 40) <= 2, 'while the unoccluded window is still the original');
});

test('outside every feature box the candidate is untouched, and no boxes means a no-op', async () => {
  const original = await frame([]);
  const candidate = await frame([{ x: 150, y: 20, w: 30, h: 30, rgb: [200, 60, 60] }]); // new decor, no box near it
  const gen = { data: candidate.toString('base64'), mime_type: 'image/png' };
  const out = await pixelGuard(sharp, original, gen, [{ name: 'door', kind: 'door', x_from: 5, x_to: 20, y_from: 10, y_to: 90 }]);
  const decor = await px(Buffer.from(out.data, 'base64'), 165, 35);
  assert.ok(decor[0] > 180 && decor[1] < 100, 'the new decor outside the box is exactly the candidate\'s business');

  const noop = await pixelGuard(sharp, original, gen, []);
  assert.equal(noop.stats.features, 0);
  assert.equal(noop.data, gen.data, 'no boxes → the candidate passes through untouched');
});

test('the guard is wired at all four candidate paths, default-on with an off switch, and fails soft', () => {
  const t = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const sites = (t.match(/process\.env\.PIXEL_GUARD !== '0'/g) || []).length;
  // Three since the teardown (2 Sep 2026): the repair pass went with the
  // judge stack, so its guard site went too.
  assert.equal(sites, 3, `staging, removal-parallel, and classic paths (found ${sites})`);
  assert.ok((t.match(/pixel guard failed \(raw candidate used\)/g) || []).length >= 3,
    'a guard failure never sinks a candidate — the raw frame proceeds to the judges');
});
