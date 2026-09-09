/**
 * Listing Lab — what "declutter" means.
 *
 * WHY THIS FILE EXISTS
 * Kyle ran the same bathroom twice on 26 Aug 2026. The first run left the trash
 * can beside the toilet ("it didn't remove something it probably should've"). The
 * second, same photo and same settings, took the trash can — and also the towels,
 * the wooden vase and the decorative dish.
 *
 * Neither run broke a rule, because there was no rule. A vision call built a
 * "keep list" before each run and decided for itself whether a vase was decor to
 * protect or clutter to remove; the judge then enforced whatever it had been told.
 * The same photo could legitimately come back either way.
 *
 * Kyle's rule: personal clutter goes, styling stays. These tests hold the four
 * places that have to agree — the keep-list catalogue, the generator prompt, the
 * compliance judge, and the two checks on the result — to that one definition,
 * so it cannot quietly drift apart again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const scope = require(join(root, 'pipeline', 'scope.js'));
const { RULES } = require(join(root, 'pipeline', 'compliance.js'));
const { buildPrompt } = require(join(root, 'pipeline', 'prompts.js'));

test('a trash can is clutter and a towel is not', () => {
  // The two items that made the difference between Kyle's two runs.
  const clutter = scope.clutterLine().toLowerCase();
  const keepers = scope.keeperLine().toLowerCase();
  assert.match(clutter, /trash can|waste basket|bin/);
  assert.match(clutter, /toiletries/);
  assert.match(keepers, /towels/);
  assert.match(keepers, /vases/);
  assert.ok(!/towel/.test(clutter), 'towels must not be listed as clutter');
  assert.ok(!/trash|waste/.test(keepers), 'a bin is never a furnishing');
});

test('the generator, the judge and the catalogue all state the same rule', () => {
  // Three prompts that used to carry three hand-written lists. Any of them
  // drifting is how a photo comes back decluttered by a different definition.
  const prompt = buildPrompt('declutter', {});
  const catalogue = readFileSync(join(root, 'pipeline', 'inventory.js'), 'utf8');
  for (const source of [prompt, RULES.declutter]) {
    assert.ok(source.includes(scope.clutterLine()), 'this prompt does not carry the shared clutter list');
    assert.ok(source.includes(scope.keeperLine()), 'this prompt does not carry the shared keep list');
  }
  assert.match(catalogue, /clutterLine\(\)/, 'the keep-list catalogue must exclude clutter by the shared list');
  assert.ok(!/Do NOT list clutter \(clothes, bags/.test(catalogue), 'the old hand-written list should be gone');
});

test('cords and personal photos are recorded but never fail a job', () => {
  // Measured before this was decided: the check found real cords in four of six
  // ordinary rooms — under a wall-mounted TV, beside a fireplace, from a window
  // AC. Gating on that would reject good work over a cord that belongs to the
  // house, and erasing an appliance's cord while keeping the appliance is closer
  // to idealising the property than tidying it.
  const gating = scope.CLUTTER_CATEGORIES.filter(c => c.gating !== false).map(c => c.key);
  const noted = scope.CLUTTER_CATEGORIES.filter(c => c.gating === false).map(c => c.key);
  assert.deepEqual(noted.sort(), ['cords', 'personal']);
  assert.ok(gating.includes('trash_bin'), 'the trash can is the whole reason this check exists');
  assert.ok(gating.includes('toiletries'));
});

test('the checks report violations only for gating categories', () => {
  // Pure shaping of the tally — no model involved, so this runs in CI.
  const found = [
    { category: 'trash_bin', verdict: 'present', where: 'beside the toilet' },
    { category: 'cords', verdict: 'present', where: 'under the TV' },
  ];
  const tally = {}, where = {};
  for (const f of found) { tally[f.category] = 3; where[f.category] = f.where; }
  const remaining = Object.entries(tally).map(([key]) => {
    const cat = scope.CLUTTER_CATEGORIES.find(c => c.key === key);
    return { key, gating: cat.gating !== false };
  });
  assert.equal(remaining.filter(r => r.gating).length, 1, 'only the bin should fail the job');
  assert.equal(remaining.filter(r => !r.gating).length, 1, 'the cord should still be recorded');
});

test('nothing removed means no over-reach question to answer', async () => {
  const r = await scope.classifyRemovals('unused-key', 'unused-model', []);
  assert.equal(r.skipped, true);
  assert.deepEqual(r.violations, []);
});

test('the declutter scope lives in the ONE judge now, declutter only', () => {
  // THE TEARDOWN (2 Sep 2026, Kyle: "rip all these judges out down to the
  // originals"): the separate clutter-left verifier and over-reach classifier
  // are out of the pipeline. Their questions moved into the one judge's own
  // checklist — declutter's list carries them, empty's must not (an empty
  // removes every movable on purpose).
  const { CHECKS, RULES } = require(join(root, 'pipeline', 'compliance.js'));
  assert.ok(CHECKS.declutter.includes('personal_clutter_all_gone'), 'the judge asks the clutter-left question itself');
  assert.ok(!CHECKS.empty.includes('personal_clutter_all_gone'), 'empty is not pulled into the declutter scope check');
  assert.match(RULES.declutter, /roughly 1\.5% or less/, 'the tiny-leftover severity rule rides in the rule text');
  assert.match(RULES.declutter, /HALF-ERASED OBJECTS AND GHOSTS/, 'and the all-or-nothing erase rule too');

  // The pipeline itself runs no separate scope verifiers any more; the one
  // classifyRemovals left is the masked segmentation's keeper filter — a
  // planning call, not a verdict gate.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.ok(!src.includes('verifyClutterGone('), 'no separate clutter-left verifier in the pipeline');
  assert.equal((src.match(/classifyRemovals\(apiKey/g) || []).length, 1, 'only the segmentation keeper-filter remains');
});

/* ------------------------------------- what Kyle grades as acceptable */

test('the checks do not fail things Kyle has graded a pass', () => {
  // Read every rejection from a day of live jobs, 26 Aug 2026. Seven of eight
  // were the model genuinely doing something wrong. ONE was us — a twilight
  // failed for soft lawn shading, which Kyle graded a PASS on his own golden set
  // ("soft residual lawn shading from daytime shadows is acceptable for what
  // we're doing"), and a declutter was marked down for completing a chair cut
  // off at the frame edge, which he also called fine.
  //
  // Both rules already SAID minor in the prose. Neither reached the checklist,
  // and the checklist is what the judge answers against — a model handed a check
  // literally named `no_daylight_residue_on_lawn` fails any shading at all,
  // because the name says none.
  const src = readFileSync(join(root, 'pipeline', 'compliance.js'), 'utf8');

  // The old name survives only inside the comment explaining why it went.
  const checks = src.slice(src.indexOf('const CHECKS = {'), src.indexOf('const UNIVERSAL'));
  assert.ok(!/'no_daylight_residue_on_lawn'/.test(checks),
    'the check name carried a stricter standard than the rule it enforces');
  assert.match(src, /no_hard_edged_sun_shadows_on_lawn/, 'the name now says what actually fails');
  assert.match(src, /4b\. \(MINOR[^)]*\) SOFT residual shading/);
  assert.match(src, /If your only complaint about an image is soft lawn shading, the image PASSES/);

  assert.match(src, /outranks checks 2 and 4 above/,
    'the frame-edge exception has to beat the checks that were firing on it');
  // Symmetric on purpose. Kyle, 27 Aug 2026, on the chair that generated ten of
  // the day's thirty-three complaint lines: "it wouldn't be the end of the world
  // if you removed a rolling chair that was full of junk along with the junk. I
  // doubt the agent wants that rolling chair there anyway." A fragment at the
  // frame edge is a fragment whether it is redrawn or dropped.
  assert.match(src, /may be completed, redrawn, OR removed entirely/);
  assert.match(src, /If your only complaints about an image concern objects at the frame edge, the image PASSES/);

  assert.match(src, /A check whose only complaint is something a rule above marks MINOR is a PASS for that check/,
    'said once, generally, so a future minor rule does not need this fight again');
});

test('a duplicate check is not a second opinion', () => {
  // twilight carried both `camera_angle_and_framing_identical` and
  // `framing_unchanged`. One fault produced two complaints and no extra safety —
  // it just made every camera problem look twice as bad in the audit.
  const src = readFileSync(join(root, 'pipeline', 'compliance.js'), 'utf8');
  const line = src.slice(src.indexOf('  twilight: ['), src.indexOf('\n', src.indexOf('  twilight: [')));
  assert.ok(!/'framing_unchanged'/.test(line));
  assert.match(line, /camera_angle_and_framing_identical/, 'the camera is still checked, once');
});

test('a shifted camera is checked first, on every transformation', () => {
  // Twilight had a dedicated camera check that runs before anything else.
  // The interiors did not — camera was one clause inside `architecture_unchanged`,
  // competing for attention with walls, trim, counters and built-ins. Kyle,
  // 27 Aug 2026: "Camera shift should absolutely be an auto fail." It is not one
  // detail among many; a moved camera is a different photograph of the property.
  const src = readFileSync(join(root, 'pipeline', 'compliance.js'), 'utf8');
  const checks = src.slice(src.indexOf('const CHECKS = {'), src.indexOf('const UNIVERSAL'));
  for (const t of ['empty', 'declutter', 'staging', 'twilight']) {
    const line = checks.slice(checks.indexOf(`  ${t}: [`), checks.indexOf('\n', checks.indexOf(`  ${t}: [`)));
    assert.match(line, /camera_angle_and_framing_identical/, `${t} must check the camera by name`);
    assert.ok(line.indexOf('camera_angle_and_framing_identical') < line.indexOf(',') + 60,
      `${t} must check it FIRST — a list is read in order`);
  }
  // And the rule text has to say it too, not just the check name.
  assert.equal((src.match(/CAMERA \(always MAJOR/g) || []).length, 4,
    'all four transformations state the camera rule in their own words');
});

test('turning a light on is still a hard failure', () => {
  // Kyle, 27 Aug 2026: "when it switched on completely unacceptable auto fail."
  // Nothing here loosens that — the MINOR exceptions are frame edges and soft
  // lawn shading, and lighting is deliberately not among them.
  const src = readFileSync(join(root, 'pipeline', 'compliance.js'), 'utf8');
  const checks = src.slice(src.indexOf('const CHECKS = {'), src.indexOf('const UNIVERSAL'));
  for (const t of ['empty', 'declutter']) {
    assert.match(checks.slice(checks.indexOf(`  ${t}: [`), checks.indexOf('\n', checks.indexOf(`  ${t}: [`))),
      /lighting_state_and_exposure_unchanged/);
  }
  assert.ok(!/MINOR[^\n]*light fixture|light fixture[^\n]*MINOR/i.test(src),
    'no minor exception may be introduced for lighting state');
});

test('THE PHANTOM CHECK: a hallucinated removal claim cannot kill a candidate', async (t) => {
  // 1 Sep 2026: a declutter was refused for "removing" a stool that was
  // plainly still in the refused frame. The claim must now survive one look
  // at the candidate itself before it may kill.
  const { classifyRemovals } = require(join(root, 'pipeline', 'scope.js'));
  const { setDeadline } = require(join(root, 'pipeline', 'gemini.js'));
  setDeadline(Date.now() + 60_000);
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const text = body.contents[0].parts[0].text;
    if (/Classify each one/.test(text)) {
      // The classifier: both items look like furnishings (kill-worthy).
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [
        { item: 'small black stool near TV stand', class: 'furnishing' },
        { item: 'floor lamp by the window', class: 'furnishing' },
      ] }) }] } }] }), { status: 200 });
    }
    // The presence check: the stool is STILL THERE; the lamp is truly gone.
    assert.ok(body.contents[0].parts.some(p => p.inline_data), 'the presence check actually looks at the candidate image');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [
      { item: 'small black stool near TV stand', present: true },
      { item: 'floor lamp by the window', present: false },
    ] }) }] } }] }), { status: 200 });
  };
  try {
    const out = await classifyRemovals('k', 'judge', ['small black stool near TV stand', 'floor lamp by the window'],
      { data: 'candB64', mime_type: 'image/jpeg' });
    assert.deepEqual(out.struck, ['small black stool near TV stand'],
      'the claim about the still-visible stool is struck');
    assert.equal(out.violations.length, 1, 'only the genuinely-gone lamp survives as a violation');
    assert.match(out.violations[0], /floor lamp/);
    assert.ok(calls >= 2, 'the second look actually happened');

    // Without a candidate image, behaviour is exactly the old behaviour: the
    // stub classifies both items as furnishings, and with no image to consult
    // BOTH claims stand — nothing is struck, nothing is second-guessed.
    const noImg = await classifyRemovals('k', 'judge', ['small black stool near TV stand', 'floor lamp by the window']);
    assert.equal(noImg.violations.length, 2, 'no candidate to check against → the claims stand as before');
    assert.deepEqual(noImg.struck, [], 'and nothing is struck without evidence');
  } finally { globalThis.fetch = real; setDeadline(null); }
});

test('TINY LEFTOVERS DELIVER: a soap bottle is not a failed job — an unboxed or large leftover still is', async (t) => {
  // 2 Sep 2026, Kyle's call after the nursery bench: masked cleared the room
  // and the frame was killed over leftover toiletries measuring well under 1%
  // of the photo. Leftovers whose measured boxes together stay within
  // LEFTOVER_DELIVER_PCT demote to noted; unmeasured stays fatal.
  const { verifyClutterGone } = require(join(root, 'pipeline', 'scope.js'));
  const { setDeadline } = require(join(root, 'pipeline', 'gemini.js'));
  setDeadline(Date.now() + 60_000);
  const real = globalThis.fetch;
  const answer = (found) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ found }) }] } }] }), { status: 200 });
  try {
    // Tiny: two bottles on OPPOSITE sides of the room, each boxed at 40×20 of
    // 1000² = 0.08%. Summed per item they are 0.16% — a single spanning box
    // would have called them half the frame (the 2 Sep bench measured 13%).
    globalThis.fetch = async () => answer([
      { category: 'toiletries', verdict: 'present', where: 'changing table and far shelf',
        boxes: [[500, 100, 540, 120], [500, 900, 540, 920]] },
    ]);
    const tiny = await verifyClutterGone('k', 'judge', 'b64', 'image/jpeg', 3);
    assert.deepEqual(tiny.violations, [], 'two 0.08% leftovers never fail the job');
    assert.equal(tiny.noted[0].demoted, 'tiny leftover', 'but it is recorded, not hidden');
    assert.ok(tiny.leftoverPct < 1);
    assert.ok(Math.abs(tiny.noted[0].areaPct - 0.16) < 0.01, 'per-item boxes are SUMMED, spread is not measured');

    // Large: a laundry pile boxed at 300×400 = 12% stays fatal.
    globalThis.fetch = async () => answer([
      { category: 'laundry', verdict: 'present', where: 'on the bed', boxes: [[300, 300, 600, 700]] },
    ]);
    const large = await verifyClutterGone('k', 'judge', 'b64', 'image/jpeg', 3);
    assert.equal(large.violations.length, 1, 'a 12% leftover still fails');
    assert.match(large.violations[0], /Still in the photo/);

    // Unboxed: the checker saw a bin but gave no box — unmeasured means
    // unproven-small, so it stays fatal.
    globalThis.fetch = async () => answer([
      { category: 'trash_bin', verdict: 'present', where: 'beside the desk' },
    ]);
    const unboxed = await verifyClutterGone('k', 'judge', 'b64', 'image/jpeg', 3);
    assert.equal(unboxed.violations.length, 1, 'no box, no mercy');
  } finally { globalThis.fetch = real; setDeadline(null); }
});
