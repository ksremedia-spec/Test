/**
 * The coverage router (2 Sep 2026, Kyle: "the model that decides big job or
 * small job is broken, it called this bedroom a big job").
 *
 * The router that picks whether masked or classic leads a declutter must be
 * ARITHMETIC over the segmenter's traced outlines — never a model's opinion
 * of how cluttered a room looks. (The scene classifier rated a lightly
 * cluttered nursery "too full"; measured, its clutter is 2.5% of the frame.)
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
const { coverage } = require(join(root, 'pipeline', 'maskedit.js'));

// A rectangle in the segmenter's [y, x] 0-1000 space.
const rect = (y0, x0, y1, x1) => [[y0, x0], [y0, x1], [y1, x1], [y1, x0]];

test('coverage is the shoelace formula, in percent of the frame', () => {
  // 100×100 of the 1000×1000 space = 1% of the frame.
  const one = coverage([{ label: 'toy', polygons: [rect(0, 0, 100, 100)] }]);
  assert.equal(one.unionPct, 1);
  assert.equal(one.largestPct, 1);
  assert.equal(one.largestLabel, 'toy');
  // Vertex order must not matter (clockwise vs counter-clockwise).
  const rev = coverage([{ label: 'toy', polygons: [rect(0, 0, 100, 100).reverse()] }]);
  assert.equal(rev.unionPct, 1);
});

test('many small items sum small; one big item is flagged as the largest', () => {
  const nursery = coverage([
    { label: 'cords', polygons: [rect(0, 0, 50, 40)] },          // 0.2%
    { label: 'water jug', polygons: [rect(100, 100, 150, 140)] }, // 0.2%
    { label: 'floor fan', polygons: [rect(200, 200, 270, 300)] }, // 0.7%
  ]);
  assert.ok(nursery.unionPct < 2, `nursery-shaped clutter stays small (got ${nursery.unionPct}%)`);
  assert.equal(nursery.largestLabel, 'floor fan');

  const garage = coverage([
    { label: 'dog crate', polygons: [rect(300, 200, 800, 700)] }, // 25%
  ]);
  assert.equal(garage.largestPct, 25);
  assert.ok(garage.largestPct > 8, 'a dog crate trips the single-item limit — classic leads there');
});

test('untraced regions are excluded — they stay in the photo whichever path leads', () => {
  const cov = coverage([
    { label: 'traced', polygons: [rect(0, 0, 100, 100)] },
    { label: 'untraced', polygons: null },
  ]);
  assert.equal(cov.unionPct, 1, 'the untraced region added nothing');
  assert.equal(coverage([]).unionPct, 0);
  assert.equal(coverage(null).unionPct, 0);
});

test('the router wiring holds: arithmetic decides, masked leads small frames, nothing is paid twice', () => {
  const t = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(t, /maskedit\.coverage\(regions\)/, 'the router calls the arithmetic, not a model');
  assert.match(t, /cov\.unionPct <= MASKED_FIRST_MAX_PCT && cov\.largestPct <= MASKED_FIRST_MAX_REGION_PCT/,
    'both limits gate the masked-first route — total share AND the single biggest item');
  assert.match(t, /MASKED_FIRST = process\.env\.MASKED_FIRST === '1'/, 'classic leads by default; MASKED_FIRST=1 restores the router');
  assert.match(t, /&& !maskedLed\) \{/, 'the rescue never re-runs a masked path that already led');
  assert.match(t, /maskedSeg \|\| \(segPromise && await segPromise\) \|\| await segmentClutter\(\)/, 'segmentation is paid once — the router\'s, or the one started beside the first classic render — and reused by the rescue');
  // When masked led and failed, classic gets the extended clock — the mirror
  // image of the old order, so the total patience is unchanged.
  assert.match(t, /jobBudgetS = JOB_BUDGET_S \+ MASKED_EXTRA_S/, 'classic inherits the extended clock after a masked lead');
});
