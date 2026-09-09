/**
 * Listing Lab — colour lock.
 *
 * WHY THIS FILE EXISTS
 * Kyle ran a bathroom declutter on 26 Aug 2026 and said the delivered photo's
 * colour was "slightly changed". It was: measured on the ceiling, the left wall,
 * the window and the tile floor — none of which were touched — the file came back
 * red +5, blue +4, green +0 against his original. Three compliance judges had
 * passed it, and they always would: the shift is about 2%, invisible side by side
 * to a vision model, and instantly visible to a photographer.
 *
 * So the check for it has to be arithmetic, not judgment. These tests hold the
 * arithmetic to three promises:
 *   1. an ordinary drift is measured and removed,
 *   2. a change too big to be drift is REFUSED, not silently corrected away
 *      (that would be papering over a relit room, which is a lie about the
 *      property — the exact failure this product exists to prevent),
 *   3. the customer gets back a file the size they uploaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { lockColour, measureColourDrift, matchDimensions, imageSizeFor, TWO_K_MAX_EDGE } = require(join(root, 'pipeline', 'colorlock.js'));

/**
 * A stand-in for a photograph: smooth gradients plus local detail, so the fit has
 * a real range of tones to work with rather than one flat colour.
 */
async function photo(w = 640, h = 426) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const wall = 150 + 70 * (x / w) + 20 * Math.sin(y / 9);
      data[i] = Math.max(0, Math.min(255, wall));
      data[i + 1] = Math.max(0, Math.min(255, wall - 10 + 12 * Math.cos(x / 13)));
      data[i + 2] = Math.max(0, Math.min(255, wall - 25 + 18 * Math.sin((x + y) / 17)));
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 96 }).toBuffer();
}

/** The same frame as the model would return it: everything nudged one way. */
async function tinted(buf, gains, offsets) {
  return sharp(buf).linear(gains, offsets).jpeg({ quality: 96 }).toBuffer();
}

test('an ordinary colour drift is measured', async () => {
  const original = await photo();
  const drifted = await tinted(original, [1, 1, 1], [5, 0, 4]); // the real failure: warm/magenta
  const m = await measureColourDrift(original, drifted);
  // Original minus generated, so a generated frame that is too red reads negative.
  assert.ok(m.drift[0] < -3, `red drift should be seen, got ${m.drift[0]}`);
  assert.ok(Math.abs(m.drift[1]) < 1.5, `green was not shifted, got ${m.drift[1]}`);
  assert.ok(m.drift[2] < -2, `blue drift should be seen, got ${m.drift[2]}`);
});

test('an ordinary colour drift is corrected back onto the original', async () => {
  const original = await photo();
  const drifted = await tinted(original, [1.01, 1, 1.005], [5, 0, 4]);
  const r = await lockColour(original, drifted);
  assert.equal(r.applied, true, r.reason || 'the correction should have run');
  assert.equal(r.within, true, `residual ${JSON.stringify(r.after)} is outside tolerance`);
  for (const v of r.after) assert.ok(Math.abs(v) <= 1.5, `channel left off by ${v}`);
});

test('a shift too large to be drift is refused, not corrected away', async () => {
  // This is a room that came back RELIT — a light switched on, the exposure
  // pushed. Correcting it would hide a misrepresentation of the property instead
  // of failing it, so the frame must come back untouched with a reason attached.
  const original = await photo();
  const relit = await tinted(original, [1.35, 1.3, 1.28], [10, 8, 6]);
  const r = await lockColour(original, relit);
  assert.equal(r.applied, false, 'a 30% lift must not be treated as a rendering drift');
  assert.match(r.reason, /larger than a rendering drift/);
  assert.equal(r.buf, relit, 'the untouched frame should be handed back for the judges');
});

test('the correction refuses to run when almost nothing in the frame is unchanged', async () => {
  const original = await photo();
  // Nothing in common: no unchanged pixels to fit a correction against.
  const unrelated = await sharp({ create: { width: 640, height: 426, channels: 3, background: { r: 20, g: 90, b: 200 } } })
    .jpeg().toBuffer();
  const r = await lockColour(original, unrelated, { share: 0.1 });
  assert.equal(r.applied, false);
  assert.match(r.reason, /too little of the frame is unchanged|larger than a rendering drift/);
});

test('removed objects do not drag the colour fit around', async () => {
  // A declutter changes a minority of the frame enormously. The fit must ignore
  // those pixels — if it averaged them in, it would "correct" the whole photo to
  // compensate for a soap bottle that is meant to be gone.
  const original = await photo();
  const drifted = await tinted(original, [1, 1, 1], [5, 0, 4]);
  const meta = await sharp(drifted).metadata();
  const patch = await sharp({ create: { width: Math.round(meta.width * 0.22), height: Math.round(meta.height * 0.3), channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
  const withRemoval = await sharp(drifted)
    .composite([{ input: patch, left: 10, top: 10 }])
    .jpeg({ quality: 96 }).toBuffer();
  const r = await lockColour(original, withRemoval);
  assert.equal(r.applied, true, r.reason || 'should still correct');
  for (const v of r.after) assert.ok(Math.abs(v) <= 1.5, `channel left off by ${v} — the removed region skewed the fit`);
});

test('correcting and resizing happen in one pass', async () => {
  // Two passes over a 50-megapixel frame is how the container got itself killed
  // mid-job ("pipeline exited null" — a signal, not an error). The corrected frame
  // must come out already at the customer's size.
  const original = await photo(800, 532);
  const bigDrifted = await sharp(await tinted(original, [1, 1, 1], [5, 0, 4]))
    .resize(1000, 665).jpeg({ quality: 96 }).toBuffer();
  const r = await lockColour(original, bigDrifted, { resizeTo: [800, 532] });
  assert.equal(r.applied, true, r.reason || 'should correct');
  const m = await sharp(r.buf).metadata();
  assert.equal(m.width, 800, 'the one pass should have resized too');
  assert.equal(m.height, 532);
  for (const v of r.after) assert.ok(Math.abs(v) <= 1.5, `channel left off by ${v}`);
});

test('the delivered file is the size the customer uploaded', async () => {
  // The bathroom declutter came back 5056px wide from a 4096px original. That
  // extra size is interpolation, not detail.
  const original = await photo(800, 532);
  const bigger = await sharp(original).resize(1000, 665).jpeg().toBuffer();
  const r = await matchDimensions(original, bigger);
  assert.equal(r.resized, true);
  const m = await sharp(r.buf).metadata();
  assert.equal(m.width, 800);
  assert.equal(m.height, 532);
});

test('a file that already matches is passed through untouched', async () => {
  const original = await photo(400, 266);
  const same = await sharp(original).jpeg().toBuffer();
  const r = await matchDimensions(original, same);
  assert.equal(r.resized, false);
  assert.equal(r.buf, same, 're-encoding a frame that needs no resize only costs quality');
});

test('a render is never stretched past the size the model made', async () => {
  // Kyle, 26 Aug 2026: a luxury listing is edited and delivered at around 56
  // megapixels; the image model tops out near 17. Matching the original by
  // upscaling would invent a 3x of detail that was never photographed — on the
  // file most likely to be printed.
  const original = await photo(1200, 800);
  const smallerRender = await sharp(original).resize(600, 400).jpeg().toBuffer();
  const r = await matchDimensions(original, smallerRender);
  assert.equal(r.resized, false, 'the render must be delivered at its own size');
  assert.equal(r.buf, smallerRender);
  const m = await sharp(r.buf).metadata();
  assert.equal(m.width, 600, 'no manufactured pixels');
});

test('a render larger than the original is still brought back down', async () => {
  const original = await photo(600, 400);
  const bigger = await sharp(original).resize(1000, 667).jpeg().toBuffer();
  const r = await matchDimensions(original, bigger);
  assert.equal(r.resized, true);
  assert.deepEqual(r.to, [600, 400]);
});

test('the render size is chosen from the uploaded photo', () => {
  // Anything generated above the upload's own size is discarded on the way out,
  // so a 2048px upload rendered at 4K costs nearly double for the same file.
  assert.equal(imageSizeFor({ width: 2048, height: 1365 }), '2K');
  assert.equal(imageSizeFor({ width: TWO_K_MAX_EDGE, height: 1000 }), '2K');
  assert.equal(imageSizeFor({ width: TWO_K_MAX_EDGE + 1, height: 1000 }), '4K');
  assert.equal(imageSizeFor({ width: 4096, height: 2726 }), '4K');
  assert.equal(imageSizeFor({ width: 9000, height: 6000 }), '4K');
  // Unknown dimensions must not silently pick the cheap option and soften a
  // large photo.
  assert.equal(imageSizeFor({}), '4K');
  assert.equal(imageSizeFor(null), '4K');
});

test('nothing forces a render size over the pipeline any more', () => {
  // The container used to set IMAGE_SIZE=4K on every job, which overrode the
  // per-photo choice before it could be made.
  const server = readFileSync(join(root, 'container', 'server.js'), 'utf8');
  const index = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  for (const [name, src] of [['container/server.js', server], ['src/index.js', index]]) {
    assert.ok(!/IMAGE_SIZE:\s*(process\.env\.IMAGE_SIZE|env\.IMAGE_SIZE)\s*\|\|\s*'4K'/.test(src),
      `${name} still forces 4K`);
    assert.match(src, /IMAGE_SIZE \? \{ IMAGE_SIZE/, `${name} should pass IMAGE_SIZE only when set`);
  }
  const transform = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(transform, /IMAGE_SIZE_OVERRIDE \|\| imageSizeFor\(originalMeta\)/,
    'the pipeline should decide from the source photo');
});

test('the result page says nothing technical about sizes', () => {
  // Kyle, 26 Aug 2026: "We do not have to tell the agent anything technical about
  // their sizes when the image returns. They don't need to know anything." The
  // sizing rules still hold — never upscale, render at the size that fits the
  // upload — they are just not the agent's problem to read about.
  const html = readFileSync(join(root, 'web', 'app.html'), 'utf8');
  assert.ok(!/Delivered at/.test(html), 'no dimensions on the result');
  assert.ok(!/reportDimensions/.test(html), 'and none of the code that put them there');
  assert.ok(!/does not render above this size/.test(html), 'no explanation of the model\'s limits');
});

test('the pipeline colour-locks every render before it is judged', async () => {
  // The order matters: correct first, judge second. Judging the raw render and
  // delivering a corrected one would mean the checks never saw what ships.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const normalise = src.indexOf('normaliseRender(gen, originalBuf');
  assert.ok(normalise > -1, 'transform.js should normalise each render');
  const judge = src.indexOf('judgeComplianceVoted', normalise);
  assert.ok(judge > normalise, 'the colour lock must run before the compliance judge');
  assert.match(src, /if \(type === 'twilight'\) return gen;/,
    'twilight must be exempt — relighting the scene is the work there');
});

test('the colour limits are tunable but default to the values fitted to pro-image', () => {
  // Tunable so the Flash fallback can be tested without editing production code;
  // defaulting to the old values so nothing changes for anyone who does not opt in.
  const src = readFileSync(join(root, 'pipeline', 'colorlock.js'), 'utf8');
  assert.match(src, /COLOUR_MAX_GAIN \|\| '1\.12'/);
  assert.match(src, /COLOUR_MIN_GAIN \|\| '0\.89'/);
  assert.match(src, /COLOUR_MAX_OFFSET \|\| '14'/);
});
