/**
 * Listing Lab — knowing when another attempt is worth paying for.
 *
 * Kyle, 26 Aug 2026: *"These customers want their photos. They don't want the
 * credit back."* Right, and the ceiling went from three attempts to five because
 * of it. But an attempt costs about $0.22 against a $1.83 credit, so the eighth
 * one spends the whole credit — which means the extra chances are only affordable
 * if none of them are spent on a job that cannot be won.
 *
 * The same day gave both cases. A bedroom failed its first attempt (a mirror
 * removed, a nightstand invented, a lamp moved) and passed its second: retrying
 * earned that photograph. An empty room, offered a declutter it should never have
 * been offered, took the same cabinet on every attempt: retrying earned nothing
 * and would have earned nothing five times.
 *
 * These tests use the real sentences the judge wrote on both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sameFailure, overlap, signature, persistentComplaint } = require(join(root, 'pipeline', 'converge.js'));

// Verbatim from the k-office run, attempts 1 and 2. One complaint, two sentences.
const CABINET_A = 'The dark brown wooden cabinet against the blue wall near the wide opening was removed in the candidate image.';
const CABINET_B = 'In Image 1, a dark brown wooden cabinet sits against the blue wall near the archway opening, but in Image 2, this cabinet has been removed.';
const CABINET_C = '[keep_list_all_present] The dark brown wooden cabinet against the blue wall near the opening, explicitly catalogued in the keep list, is missing in Image 2.';
// Verbatim from the same runs, but genuinely different complaints.
const SWITCH = 'A new white light switch panel was added to the right wall in Image 2.';
const CHAIR = 'The black office chair visible at the bottom left edge of the original image has been removed in the candidate image.';
const MIRROR = 'The tall framed leaning mirror on the right wall was removed in Image 2.';

test('the same complaint written two different ways is one complaint', () => {
  // The judge never writes it twice the same way. String equality would call
  // these two separate problems and let a hopeless job run to the ceiling.
  assert.ok(overlap(signature(CABINET_A), signature(CABINET_B)) >= 0.5,
    'both are "the cabinet by the opening is gone"');
  assert.ok(sameFailure([CABINET_A], [CABINET_B]));
});

test('genuinely different complaints are not confused for each other', () => {
  // If these matched, a job that fixed one problem and introduced another would
  // be stopped as "no progress" when it is plainly still responding.
  for (const [a, b] of [[CABINET_A, SWITCH], [CABINET_A, CHAIR], [SWITCH, CHAIR], [MIRROR, CHAIR]]) {
    assert.ok(overlap(signature(a), signature(b)) < 0.5, `${a.slice(0, 30)} vs ${b.slice(0, 30)}`);
    assert.ok(!sameFailure([a], [b]));
  }
});

test('a job stuck on the same thing is stopped', () => {
  // k-office: three generations, three identical complaints, one refund. The
  // fourth and fifth would have been three and four more.
  assert.ok(sameFailure([CABINET_A, CABINET_C], [CABINET_B, CABINET_C]));
  assert.ok(sameFailure([CABINET_A], [CABINET_C]), 'the check name and the prose describe one problem');
});

test('progress keeps going, even partial progress', () => {
  // bedroom2: three complaints down to one, then clean. Stopping after the
  // second attempt would have thrown away the photograph that was coming.
  assert.ok(!sameFailure([MIRROR, SWITCH, CHAIR], [MIRROR]), 'two of three fixed is progress');
  assert.ok(!sameFailure([MIRROR], [MIRROR, SWITCH]), 'a NEW problem means the generator is still moving');
  assert.ok(!sameFailure([], [MIRROR]), 'nothing to compare against is not a repeat');
  assert.ok(!sameFailure([MIRROR], []), 'and neither is an empty list');
  assert.ok(!sameFailure(null, [MIRROR]), 'nor a first attempt');
});

test('order does not make the same failure look like a different one', () => {
  assert.ok(sameFailure([CABINET_A, SWITCH], [SWITCH, CABINET_B]));
});

test('the pipeline actually uses it, on BOTH failure paths', () => {
  // The bug this replaced: `priorViolations` had existed since Round 19 and was
  // passed in exactly one place — the declutter scope check. Every ordinary
  // compliance rejection retried with a byte-identical prompt and learned
  // nothing, so three attempts were one instruction and two rolls of the dice.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /const prepareRetry = \(verdict\) =>/, 'one place decides what a failed attempt does');
  assert.match(src, /sameFailure\(lastViolations, verdict\.violations\)/);
  assert.match(src, /priorViolations: verdict\.violations/, 'and the judge\'s words go back to the generator');

  const loop = src.slice(src.indexOf('for (let attempt = 1;'));
  const calls = loop.match(/prepareRetry\(verdict\)/g) || [];
  // One call since the teardown (2 Sep 2026): the separate scope re-check at
  // delivery is gone — the one judge's verdict is the only failure path here.
  assert.equal(calls.length, 1, 'the ordinary compliance path goes through it');
  // Nothing may retry around it — that is how the feedback went missing before.
  const after = loop.slice(loop.indexOf('audit.delivered = outPath;'));
  assert.match(after, /if \(prepareRetry\(verdict\)\) break;/,
    'the ordinary rejection path must end at prepareRetry, not fall out of the loop body');
});

test('five attempts, because the eighth spends the whole credit', () => {
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /MAX_ATTEMPTS \|\| '5'/);
  // 30 credits for $54.99 is $1.83 each; an attempt is ~$0.134 image + ~$0.09
  // checks. The arithmetic that chose 5 should stay visible to whoever changes it.
  const note = src.slice(src.indexOf('How many times a job may try'), src.indexOf('const MAX_ATTEMPTS'));
  assert.match(note, /1\.83/, 'what a credit earns');
  assert.match(note, /0\.22/, 'what an attempt costs');
});

test('a room with nothing to declutter is refused before a single generation', () => {
  // Measured on k-office.jpg, a bare room with one small dark object against a
  // wall: attempt 1 removed it (a cabinet, on the keep list), attempt 2 left it
  // alone and returned a photo identical to the input, which "nothing was
  // actually removed" then refused. Every path ends in a refund; the only
  // question is how much of Kyle's money gets spent reaching it — five attempts
  // is about a dollar against a $1.83 credit, for an answer already paid for.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const guard = src.slice(src.indexOf('IS THERE ANYTHING HERE TO DO?'), src.indexOf('NOT APPLICABLE —') + 200);
  assert.match(guard, /Array\.isArray\(options\.inventory\?\.clutter\)/,
    'a MISSING answer is not an empty one — the model failing to answer must never refuse a job');
  assert.match(guard, /clutter\.length === 0/);
  assert.match(guard, /keep\.length >= 3/,
    'and only when the catalogue clearly looked at the room at all');
  assert.match(guard, /creditCharged = false/);

  // It has to run BEFORE anything is generated, or it saves nothing.
  assert.ok(src.indexOf('IS THERE ANYTHING HERE TO DO?') < src.indexOf('for (let attempt = 1;'),
    'the whole point is that it happens before the first generation');
});

test('the catalogue is asked what clutter it sees, and may answer "none"', () => {
  const src = readFileSync(join(root, 'pipeline', 'inventory.js'), 'utf8');
  assert.match(src, /SEPARATELY, list the clutter you can actually see/);
  assert.match(src, /has an EMPTY clutter list, and saying so is the right answer/,
    'a model that feels obliged to find something will always find something');
  assert.match(src, /Array\.isArray\(v\.clutter\) \? v\.clutter : null/,
    'unanswered must be distinguishable from empty');
});

test('"nothing to do" is not reported to the customer as a compliance failure', () => {
  // Nothing was checked, because nothing was made. Credit comes back either way;
  // the sentence should still be true.
  const src = readFileSync(join(root, 'container', 'server.js'), 'utf8');
  assert.match(src, /notApplicable: true/);
  assert.match(src, /This room already reads clean/);
  const note = src.slice(src.indexOf('out.notApplicable'), src.indexOf('out.notApplicable') + 300);
  assert.ok(!/compliance/i.test(note.split('\n')[1] || ''), 'not the compliance sentence');
});

test('a complaint that survives three rounds of feedback stops the job', () => {
  // The set-equality rule keeps going as long as anything changes. A frame can
  // lose the same coffee table every attempt while OTHER complaints churn, and
  // never trip sameFailure — the systematic declutter failure. This catches it.
  const stuck = [
    ['[keep_list_all_present] The black glass-top coffee table in the centre was removed', 'exposure slightly off'],
    ['[keep_list_all_present] The black glass-top coffee table in the centre was removed in the candidate', 'a doorway looks altered'],
    ['[keep_list_all_present] The glass-top coffee table in the centre foreground is missing', 'a chair moved'],
  ];
  assert.ok(!sameFailure(stuck[1], stuck[2]), 'the sets differ, so set-equality does NOT catch this');
  assert.ok(persistentComplaint(stuck, 3), 'but a persistent complaint does');
});

test('early-abort protects winnable frames: it does not stop varied or short runs', () => {
  // Genuinely different failures each round mean the generator is still moving —
  // keep paying. And two attempts is not yet three, so nothing stops early.
  const varied = [['doorway altered'], ['exposure changed'], ['a chair was moved']];
  assert.equal(persistentComplaint(varied, 3), null, 'unrelated failures keep their chances');
  const alternating = [
    ['[keep_list_all_present] coffee table removed'],
    ['[architecture_unchanged] a window was altered'],
    ['[keep_list_all_present] coffee table removed'],
  ];
  assert.equal(persistentComplaint(alternating, 3), null, 'a complaint that skips a round is not persistent');
  const twoOnly = [['coffee table removed'], ['coffee table removed']];
  assert.equal(persistentComplaint(twoOnly, 3), null, 'two attempts is not yet three');
});

test('staging candidates are staggered, not fired as a burst', () => {
  // Staging is the only transformation that generates several frames in
  // parallel, and image generation is limited per MINUTE. Measured 26 Aug 2026:
  // a staging job hit "Vertex 429: Resource exhausted" on every candidate, then
  // again on retry, and spent three rounds in the outage queue without ever
  // producing a frame — while a single generation from the same key seconds
  // later returned 200.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /CANDIDATE_STAGGER_MS \|\| '4000'/);
  const loop = src.slice(src.indexOf('const results = await Promise.all(slots.map'));
  assert.match(loop.slice(0, 1400), /if \(i > 0\) await new Promise\(r => setTimeout\(r, i \* CANDIDATE_STAGGER_MS\)\)/,
    'the first candidate waits for nothing; each later one starts a little after');
  // They must still run concurrently — serialising three 60s generations would
  // put staging past its own budget.
  assert.match(loop.slice(0, 200), /Promise\.all\(slots\.map/, 'still parallel, just not simultaneous');
});
