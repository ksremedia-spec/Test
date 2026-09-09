/**
 * The outage circuit breaker + the deadline/kill ordering (31 Aug 2026).
 *
 * During a broad "high demand" incident every stage's calls fail transiently,
 * each politely retrying its own ladder — so no stage ever concluded anything,
 * attempts crawled to the container's 10-minute SIGKILL, the kill carried no
 * verdict, and the Worker re-ran the identical crawl. Seen live: seven
 * consecutive 10-minute runs on one declutter, 77 minutes of "working".
 *
 * These tests pin the two halves of the fix: (a) consecutive transient
 * failures across ALL calls trip a breaker that fails the attempt in seconds
 * with an error the reporting chain already reads as "image service busy";
 * (b) the pipeline's own deadline always expires before the container's kill,
 * so an attempt always gets to finish its sentence.
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
const { geminiGenerateContent, setDeadline, _outageBreaker } = require(join(root, 'pipeline', 'gemini.js'));

const BUSY_503 = JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } });
const OK_BODY = JSON.stringify({ candidates: [] });

function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = { n: 0 };
  globalThis.fetch = async (...args) => { calls.n++; return handler(...args); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const resp = (status, body) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

test('consecutive transient failures across calls trip the breaker, which then fails instantly', async () => {
  _outageBreaker.reset();
  const { calls, restore } = stubFetch(() => resp(503, BUSY_503));
  try {
    // A short deadline keeps each call to one un-slept try, exactly like the
    // tail of a real crawling attempt.
    for (let i = 0; i < 20 && _outageBreaker.count() < 8; i++) {
      setDeadline(Date.now() + 3000);
      await geminiGenerateContent('key', 'gemini-3.6-flash', {}).catch(() => {});
    }
    assert.ok(_outageBreaker.count() >= 8, `the failures accumulated (${_outageBreaker.count()})`);

    const before = calls.n;
    setDeadline(Date.now() + 3000);
    await assert.rejects(
      () => geminiGenerateContent('key', 'gemini-3.6-flash', {}),
      /circuit breaker|upstream outage/i,
      'an open breaker fails the call with an outage error');
    assert.equal(calls.n, before, 'and no request was actually sent — the failure is instant');
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset();
  }
});

test('one successful response closes the breaker — a hiccup is not an outage', async () => {
  _outageBreaker.reset();
  let fail = true;
  const { restore } = stubFetch(() => (fail ? resp(503, BUSY_503) : resp(200, OK_BODY)));
  try {
    for (let i = 0; i < 3; i++) {
      setDeadline(Date.now() + 3000);
      await geminiGenerateContent('key', 'gemini-3.6-flash', {}).catch(() => {});
    }
    assert.ok(_outageBreaker.count() >= 3, 'transients were counted');
    fail = false;
    setDeadline(Date.now() + 5000);
    await geminiGenerateContent('key', 'gemini-3.6-flash', {});
    assert.equal(_outageBreaker.count(), 0, 'a single success resets the count to zero');
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset();
  }
});

test("the breaker's error reads as an outage to every layer above it", () => {
  // The whole point is that nothing new has to learn a new error: the message
  // must match the pipeline's UPSTREAM_DOWN (strike counting), the container's
  // RETRYABLE/UPSTREAM_DOWN (parks, honest customer note), and the worker's
  // MODEL_DOWN never sees it (it is thrown below the model-fallback layer).
  _outageBreaker.trip();
  let message;
  try {
    // Reach the throw through the public API shape: an open breaker refuses at entry.
    message = (() => { try { _outageBreaker.count(); } catch {} return null; })();
  } finally { _outageBreaker.reset(); }
  const src = readFileSync(join(root, 'pipeline', 'gemini.js'), 'utf8');
  const m = src.match(/const outageBreakerError[\s\S]*?new Error\(([\s\S]*?)\);/);
  assert.ok(m, 'the breaker error is built in one visible place');
  assert.match(m[1], /503/, "carries '503' so UPSTREAM_DOWN and RETRYABLE match it");
  assert.match(m[1], /high demand/, "carries 'high demand' so the customer note says busy, not broken");
});

test('the pipeline deadline is clamped inside the container kill, at both set points', () => {
  const t = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(t, /const KILL_CEILING_MS = Number\(process\.env\.RUN_TIMEOUT_MS \|\| 600000\) - 45000/,
    'the ceiling is the kill setting minus a reporting margin');
  const clamped = t.match(/setDeadline\(clampToKill\(/g) || [];
  // Three since the coverage router (2 Sep 2026): classic at job start, the
  // extended-clock handoff after a failed masked lead, and the masked rescue.
  assert.equal(clamped.length, 3, 'every deadline site is clamped inside the container kill');
  assert.ok(!/setDeadline\(JOB_START \+/.test(t), 'no unclamped deadline remains');
  const s = readFileSync(join(root, 'container', 'server.js'), 'utf8');
  assert.match(s, /RUN_TIMEOUT_MS: String\(RUN_TIMEOUT_MS\)/,
    'the container tells the pipeline its actual kill setting');
});

test('the breaker is PER MODEL: a dead pro model never gags the flash fallback', async () => {
  // The evening's lesson, 31 Aug 2026: one shared count meant the pro outage
  // opened the breaker before flash was ever asked — two beta stagings died at
  // the cutoff with the fallback model possibly healthy the whole time.
  _outageBreaker.reset();
  _outageBreaker.trip('gemini-3-pro-image');
  const { calls, restore } = stubFetch(() => resp(200, OK_BODY));
  try {
    setDeadline(Date.now() + 10_000);
    // The dead model fails instantly, without a request…
    await assert.rejects(
      () => geminiGenerateContent('key', 'gemini-3-pro-image', {}),
      /circuit breaker|upstream outage/i);
    assert.equal(calls.n, 0, 'no request went to the model that is known dead');
    // …while another model sails through untouched.
    setDeadline(Date.now() + 10_000);
    await geminiGenerateContent('key', 'gemini-3.1-flash-image', {});
    assert.equal(calls.n, 1, 'the healthy model was actually asked');
    assert.equal(_outageBreaker.count('gemini-3.1-flash-image'), 0, 'and its own count stays clean');
    assert.ok(_outageBreaker.count('gemini-3-pro-image') >= 8, 'the dead model stays tripped');
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset();
  }
});
