/**
 * The speed-and-success trio (1 Sep 2026, Kyle: "How can we improve speed and
 * success at the same time").
 *
 * Failing is the slowest thing the pipeline does — a rejection burns 7–16
 * minutes and delivers nothing — so all three pieces attack the pass rate and
 * the clock together:
 *   1. RED-BOX REFERENCE — the keep-clear zones, drawn on a copy of the photo
 *      and handed to the artist, because coordinate prose was being ignored.
 *   2. PRESCREEN — one cheap refuse-only call before the three-vote jury.
 *   3. REPAIR PASS — a near-miss (movable mistakes only) is fixed in place
 *      and re-faces the FULL gauntlet, instead of being thrown away.
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
const { drawNoGoReference } = require(join(root, 'pipeline', 'layout.js'));
const { prescreenCandidate } = require(join(root, 'pipeline', 'compliance.js'));
const { setDeadline } = require(join(root, 'pipeline', 'gemini.js'));

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

test('the red-box reference paints every clear zone and warns the model off copying it', async () => {
  const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
  const layout = { doors: [
    { name: 'right door', clear_zone: { x_from: 70, x_to: 95, y_from: 60, y_to: 95 } },
    { name: 'back opening', clear_zone: { x_from: 30, x_to: 55, y_from: 50, y_to: 62 } },
    { name: 'no zone door' },
  ] };
  const ref = await drawNoGoReference(sharp, photo, layout);
  assert.ok(ref && ref.data, 'a reference image came back');
  assert.equal(ref.mime_type, 'image/jpeg');
  assert.match(ref.label, /KEEP-CLEAR/i, 'the label explains the zones');
  assert.match(ref.label, /NOT part of the room/i, 'and forbids drawing the boxes into the output');
  // The overlay actually changed pixels inside a zone (the red shading).
  const before = await sharp(photo).extract({ left: 320, top: 220, width: 10, height: 10 }).raw().toBuffer();
  const after = await sharp(Buffer.from(ref.data, 'base64')).extract({ left: 320, top: 220, width: 10, height: 10 }).raw().toBuffer();
  assert.notDeepEqual([...before], [...after], 'pixels inside a zone are visibly shaded');
  assert.equal(await drawNoGoReference(sharp, photo, { doors: [] }), null, 'nothing to draw → no reference');
});

test('the prescreen is refuse-only, and biased against false kills by prompt', async () => {
  setDeadline(Date.now() + 60_000);
  let sentPrompt = null;
  const restore = stubFetch(async (url, init) => {
    sentPrompt = JSON.parse(init.body).contents[0].parts[0].text;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"blocked":true,"text":false,"camera":false,"details":["A sofa end stands inside the right-door clear box."]}' }] } }] }), { status: 200 });
  });
  try {
    const inv = { doors: [{ name: 'right door', clear_zone: { x_from: 70, x_to: 95, y_from: 60, y_to: 95 } }] };
    const out = await prescreenCandidate('k', 'judge-model', 'oB64', 'image/jpeg', 'cB64', 'image/jpeg', inv);
    assert.equal(out.dead, true);
    assert.match(out.violations[0], /^\[prescreen\] /, 'violations are labelled with their source');
    assert.match(sentPrompt, /When unsure about any check, answer false/, 'the bias against false kills is in the prompt');
    assert.match(sentPrompt, /x 70%–95%/, 'the real clear boxes ride along');
  } finally { restore(); setDeadline(null); }
});

test('a clean prescreen clears the candidate for the full jury — it can never approve', async () => {
  setDeadline(Date.now() + 60_000);
  const restore = stubFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"blocked":false,"text":false,"camera":false,"details":[]}' }] } }] }), { status: 200 }));
  try {
    const out = await prescreenCandidate('k', 'judge-model', 'o', 'image/jpeg', 'c', 'image/jpeg', null);
    assert.equal(out.dead, false, 'not dead — but nothing here marks it PASSED either');
    assert.equal(out.violations.length, 0);
  } finally { restore(); setDeadline(null); }
});

test('the red-box reference still rides into generation — construction survived the teardown', () => {
  const t = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(t, /references: options\.noGoRef \? \[options\.noGoRef\] : undefined/,
    'staging generation receives the red-box reference');
});

test('THE TEARDOWN HOLDS: no bouncer, no vetter, no repair re-jury, no structural or realism gates', () => {
  // 2 Sep 2026, Kyle: "rip all these judges out down to the originals and
  // give better prompts." The golden set scored the twelve-checker pile
  // 44/61, identical to a week earlier — the pile moved mistakes around
  // without reducing them. One judge remains; everything else that grades a
  // candidate must be arithmetic. This pin is what stops the pile growing
  // back one "quick fix" at a time.
  const t = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  for (const gone of ['prescreenCandidate(', 'vetRemovalClaims(', 'verifyFixedElements(',
                      'verifyFocalPoint(', 'verifyFocalProximity(', 'verifyRemoval(',
                      'verifyClutterGone(', 'critiqueRealismVoted(', 'THE REPAIR PASS']) {
    assert.ok(!t.includes(gone), `${gone} must stay out of the pipeline`);
  }
  // The one judge, at two unanimous votes by default.
  assert.match(t, /JUDGE_VOTES = parseInt\(process\.env\.JUDGE_VOTES \|\| '2'/,
    'one judge, two votes, both must pass');
  // The deterministic spine stays: colour lock, pixel guard, watermark verify.
  assert.match(t, /colourViolation\(colourRecord\)/);
  assert.match(t, /pixelGuard\(sharp, originalBuf/);
  assert.match(t, /verifyWatermark\(finalBuf, wmText, preWmBuf\)/);
});
