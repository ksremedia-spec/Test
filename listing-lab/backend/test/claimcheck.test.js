/**
 * The claim check (4 Sep 2026): a judge's "X was removed" claim is held to the
 * pixels at the spot it names. Arithmetic half only — the crop question is a
 * model call and is exercised on the golden set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { boxDiff, checkable } = require('../pipeline/claimcheck.js');

function frame(w, h, fill) { const d = Buffer.alloc(w * h * 3, fill); return { data: d, w, h }; }

test('an unchanged patch disproves a removal claim; a changed patch does not', () => {
  const o = frame(100, 100, 120), c = frame(100, 100, 120);
  // Change only the top-left quarter of the candidate.
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) { const i = (y * 100 + x) * 3; c.data[i] = 250; c.data[i + 1] = 250; c.data[i + 2] = 250; }
  const untouched = boxDiff(o, c, [600, 600, 950, 950]);   // bottom-right: identical
  assert.equal(untouched.mean, 0); assert.equal(untouched.share, 0);
  const touched = boxDiff(o, c, [0, 0, 450, 450]);          // top-left: repainted
  assert.ok(touched.mean > 100); assert.ok(touched.share > 0.9);
});

test('only boxed, major, object-removal claims are checkable — never leftovers, ghosts or camera', () => {
  const box = [100, 100, 300, 300];
  assert.equal(checkable({ severity: 'major', text: 'The dark floor rug in the corner was removed.', box_2d: box }), true);
  assert.equal(checkable({ severity: 'major', text: 'The range was replaced with a different model.', box_2d: box }), true);
  assert.equal(checkable({ severity: 'major', text: 'The dark floor rug in the corner was removed.' }), false, 'no box, no check');
  assert.equal(checkable({ severity: 'minor', text: 'Rug removed.', box_2d: box }), false, 'minor never fails a photo, nothing to disprove');
  assert.equal(checkable({ severity: 'major', text: 'A broom was left standing in the corner.', box_2d: box }), false, 'leftovers are proven by the checklist');
  assert.equal(checkable({ severity: 'major', text: 'Ghost smear where the bags were removed.', box_2d: box }), false, 'ghosts are never disproved here');
  assert.equal(checkable({ severity: 'major', text: 'Camera angle changed; the door frame moved.', box_2d: box }), false);
  assert.equal(checkable({ severity: 'major', text: 'A glass nightstand was added behind the bed.', box_2d: box }), false, 'additions are not removal claims');
});
