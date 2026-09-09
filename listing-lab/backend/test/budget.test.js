/**
 * Listing Lab — the job's time budget.
 *
 * WHY THIS FILE EXISTS
 * On 26 Aug 2026 Kyle watched a job grind on for ten minutes and a twilight fail
 * outright. Neither was one slow thing. The job was patient in three separate
 * places that did not know about each other:
 *
 *   · three attempts, each willing to generate and re-judge from scratch
 *   · four HTTP retries inside every single call
 *   · a three-minute timeout on each of those retries
 *
 * Multiply them and a job that should take two minutes has permission to take
 * twenty. Kyle's words: "I meant a minute or two ... we're gonna be a 15 minute
 * generation."
 *
 * So there is now one clock for the whole job, and both the retry loop and the
 * attempt loop measure themselves against it. These tests hold that clock
 * honest — including the two things it must NEVER do, which are cut off the
 * first attempt and cut off the checks on a generation already paid for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const gemini = require(join(root, 'pipeline', 'gemini.js'));

const OK = JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', data: 'aaa' }] }] });
const PIXEL = 'ZmFrZS1qcGVn';

/** Swap global fetch for the duration of one test, and always put it back. */
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; gemini.setDeadline(null); }
}

test('with no deadline set, nothing changes — the CLI and the tests behave as before', async () => {
  gemini.setDeadline(null);
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(OK, { status: 200 }); }, async () => {
    const out = await gemini.nanoBananaEdit('k', 'p', PIXEL, 'image/jpeg');
    assert.equal(out.data, 'aaa');
  });
  assert.equal(calls, 1);
});

test('a retry is not slept through when there is no time to use it', async () => {
  // Google returns 503 often enough that retrying is right. Retrying with 40
  // seconds left on a job that needs 90 is not retrying, it is stalling.
  gemini.setDeadline(Date.now() + 2_000);
  let calls = 0;
  const started = Date.now();
  await withFetch(async () => { calls++; return new Response('{"error":{"code":503}}', { status: 503 }); }, async () => {
    await assert.rejects(() => gemini.nanoBananaEdit('k', 'p', PIXEL, 'image/jpeg'), /Gemini 503/);
  });
  assert.equal(calls, 1, 'one try, then out of time — not four tries and 45s of backoff');
  assert.ok(Date.now() - started < 1_500, 'and it did not sit through the backoff first');
});

test('with time in hand it still retries, because most 503s do clear', async () => {
  gemini.setDeadline(Date.now() + 120_000);
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return calls === 1 ? new Response('{"error":{"code":503}}', { status: 503 }) : new Response(OK, { status: 200 });
  }, async () => {
    const out = await gemini.nanoBananaEdit('k', 'p', PIXEL, 'image/jpeg');
    assert.equal(out.data, 'aaa');
  });
  assert.equal(calls, 2, 'the transient failure was retried and the job recovered');
});

test('a call is never given more time than the job has left', async () => {
  // The per-request timeout is three minutes. A job with twenty seconds left
  // must not hand a socket three minutes of rope.
  gemini.setDeadline(Date.now() + 900);
  await withFetch(
    (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }),
    async () => {
      const started = Date.now();
      await assert.rejects(() => gemini.nanoBananaEdit('k', 'p', PIXEL, 'image/jpeg'), /timed out/);
      assert.ok(Date.now() - started < 5_000, 'it gave up at the deadline, not at the 180s default');
    });
});

test('a job past its deadline stops asking rather than queueing more work', async () => {
  gemini.setDeadline(Date.now() - 1);
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(OK, { status: 200 }); }, async () => {
    await assert.rejects(() => gemini.nanoBananaEdit('k', 'p', PIXEL, 'image/jpeg'), /ran out of time/);
  });
  assert.equal(calls, 0, 'no request should have been sent at all');
});

test('the pipeline sets the clock, and gives the checks room past it', () => {
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /setDeadline\(clampToKill\(JOB_START, JOB_START \+ \(JOB_BUDGET_S \+ JOB_DEADLINE_GRACE_S\) \* 1000\)\)/,
    'the HTTP deadline must sit BEYOND the attempt budget — an attempt begun at ' +
    'the last second still deserves to be generated and judged, or we throw away ' +
    'a photograph we have already paid Google for. Since 31 Aug 2026 it is also ' +
    'clamped INSIDE the container kill, so the pipeline concludes before SIGKILL ' +
    '— see outage-breaker.test.js');
  assert.match(src, /JOB_BUDGET_SECONDS \|\| '300'/,
    'five minutes, wall clock — raised from four when the attempt ceiling went ' +
    'from three to five, so the ceiling is reachable rather than decorative. ' +
    'Most jobs stop long before either, because a repeated failure ends them.');
});

test('the budget stops RETRIES, and never the first attempt', () => {
  // A job that has generated nothing has nothing to show for stopping. Refusing
  // to start attempt one would turn a slow queue into a silent failure.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const loop = src.slice(src.indexOf('for (let attempt = 1;'));
  const guard = loop.slice(0, loop.indexOf('console.log(`\\n— Attempt'));
  assert.match(guard, /attempt > 1 &&/, 'attempt one always runs');
  // jobBudgetS, not the constant, since the coverage router (2 Sep 2026):
  // when masked led and failed, classic runs on the extended clock.
  assert.match(guard, /elapsed\(\) \+ ATTEMPT_COST_S > jobBudgetS/,
    'the question is "is there time for another go", not "am I over time"');
  assert.match(guard, /audit\.stoppedForTime/, 'and the audit records why it stopped');
});

test('running out of time is a rejection, so the credit goes back', () => {
  // Delivering whatever the last attempt produced because the clock ran out
  // would be the one outcome worse than being slow.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const guard = src.slice(src.indexOf('audit.stoppedForTime = {'));
  assert.match(guard.slice(0, 400), /break;/, 'it leaves the loop without delivering');
  assert.match(src, /audit\.creditCharged = delivered \? true : false/,
    'and anything not delivered is refunded, which covers this too');
});

test('an upstream outage stops after two attempts, not three', () => {
  // Measured during the real 26 Aug outage: three attempts, twelve requests,
  // 139 seconds of spinner, to be told what the first attempt already knew.
  // The HTTP client has retried five times before the pipeline even sees a
  // generation failure — a third full attempt is the same experiment again.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /audit\.upstreamDown = \{/, 'the audit must say Google was down, not that we rejected the work');
  assert.match(src, /UPSTREAM_STRIKES \|\| '2'/);
  // And the classifier below must still call it an outage rather than a
  // rejection, so the customer is told the truth about why they got nothing.
  assert.match(src, /neverGenerated \? 'error' : 'rejected'/);
});

test('the outage pattern recognises what Google actually says', () => {
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const m = src.match(/const UPSTREAM_DOWN = (\/.*\/i);/);
  assert.ok(m, 'the pattern should be findable');
  const re = new RegExp(m[1].slice(1, -2), 'i');
  // Verbatim from the 26 Aug 2026 outage and from the 125s ceiling before it.
  for (const said of [
    'Gemini 500: {"error":{"message":"gemini-3-pro-image is currently experiencing high demand"}}',
    'Gemini 503: {"error":{"code":503,"status":"UNAVAILABLE"}}',
    'Gemini 524: ',
    'Gemini 429: quota',
    'Gemini request timed out after 180s',
    'Gemini call abandoned: the job ran out of time',
  ]) assert.ok(re.test(said), `should recognise: ${said.slice(0, 60)}`);
  // And must NOT swallow our own faults — those deserve a real retry.
  for (const ours of [
    'No image in response: {"steps":[]}',
    'Gemini 400: {"error":{"message":"Invalid argument"}}',
  ]) assert.ok(!re.test(ours), `should NOT treat as an outage: ${ours.slice(0, 50)}`);
});

test('the retry budget is overridable, because patience depends on the alternative', async () => {
  // Five tries over 25 seconds is right when this is the only way in. With a
  // second provider standing open it is 25 seconds of a customer's wait spent
  // on a door that has already said no.
  gemini.setDeadline(Date.now() + 120_000);
  let calls = 0;
  await withFetch(async () => { calls++; return new Response('{"error":{"code":503}}', { status: 503 }); }, async () => {
    await assert.rejects(() => gemini.nanoBananaEdit('k', 'p', PIXEL, 'image/jpeg', { retries: 1 }), /Gemini 503/);
  });
  assert.equal(calls, 2, 'knock twice, then give up and let the caller try elsewhere');
});

test('a container refused by location routes through the Worker, by itself', async () => {
  // Cloudflare places containers across its network and each egresses from
  // wherever it landed. On 26 Aug 2026 one instance answered from ATL and worked
  // while another — same image, same key, same minute — was refused outright and
  // killed a staging job five seconds in. Pinning placement does not fix it,
  // because placement is not egress. So the container works it out for itself.
  gemini.setDeadline(null);
  process.env.GEMINI_PROXY_URL = 'https://listinglab.test/internal/gemini';
  process.env.GEMINI_PROXY_KEY = 'shared-secret';
  gemini._resetRouting();
  const g = gemini;

  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, key: init.headers['x-goog-api-key'] });
    return seen.length === 1
      ? new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION',
          message: 'User location is not supported for the API use.' } }), { status: 400 })
      : new Response(OK, { status: 200 });
  };
  try {
    const out = await g.nanoBananaEdit('real-google-key', 'p', PIXEL, 'image/jpeg');
    assert.equal(out.data, 'aaa', 'the call succeeded on the second route');
  } finally {
    globalThis.fetch = real;
    delete process.env.GEMINI_PROXY_URL; delete process.env.GEMINI_PROXY_KEY;
    gemini._resetRouting();
  }

  assert.equal(seen.length, 2, 'refused once, then routed and retried — not abandoned');
  assert.match(seen[0].url, /generativelanguage\.googleapis\.com/, 'direct first, which is faster and has no ceiling');
  assert.equal(seen[0].key, 'real-google-key');
  assert.match(seen[1].url, /listinglab\.test\/internal\/gemini/, 'then out through the Worker');
  assert.equal(seen[1].key, 'shared-secret', 'and with the Worker\'s own credential, not Google\'s key');
});

test('a location refusal does not spend the retry budget it did not use', () => {
  // The re-route is not a retry: the first request never happened as far as
  // Google is concerned. Spending a retry on it would leave a genuinely flaky
  // call one attempt short later in the same job.
  const src = readFileSync(join(root, 'pipeline', 'gemini.js'), 'utf8');
  const block = src.slice(src.indexOf('GEO_BLOCKED.test(text)'), src.indexOf('GEO_BLOCKED.test(text)') + 500);
  assert.match(block, /i--/, 'the attempt is given back');
  assert.match(block, /door = next/, 'and the decision sticks for this instance');
  assert.match(block, /reroutes < DOORS\.length/,
    'bounded — a rung that cannot serve this endpoint routes back to direct, and ' +
    '"give the attempt back and try again" would otherwise loop forever');
});

test('the way out is a ladder, and generation never ends up on the ceiling rung', () => {
  // direct → vertex → proxy. The proxy is last on purpose: Cloudflare cuts a
  // Worker's outbound fetch at 125 seconds, which is harmless for a judge and
  // fatal for a generation. It is what killed Kyle's twilight three times.
  const src = readFileSync(join(root, 'pipeline', 'gemini.js'), 'utf8');
  assert.match(src, /const DOORS = \['direct', 'vertex', 'proxy'\]/, 'in that order');
  // The Vertex rung rewrites /models/… only. The image endpoint has no Vertex
  // equivalent at that URL, so it must not be silently rewritten into one.
  const routeFn = src.slice(src.indexOf('function route('), src.indexOf('function nextDoor('));
  assert.match(routeFn, /\$\{DIRECT\}\/models/, 'only generateContent is re-hosted');
  assert.ok(!/interactions/.test(routeFn), 'the image endpoint is left alone here');
});

test('when Vertex is available it is preferred over the Worker proxy', async () => {
  // Both rungs get past a geo-block, but only one of them is direct. The proxy
  // carries Cloudflare's 125-second ceiling and an extra hop; Vertex carries
  // neither, and on 26 Aug 2026 it was answering from container instances the
  // developer API refused outright — including one where the proxy was refused
  // too, which is the case that makes the order matter rather than being taste.
  gemini.setDeadline(null);
  process.env.GEMINI_PROXY_URL = 'https://listinglab.test/internal/gemini';
  process.env.GEMINI_PROXY_KEY = 'shared-secret';
  process.env.VERTEX_API_KEY = 'vertex-express-key';
  gemini._resetRouting();

  const seen = [];
  let landedOn = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, key: init.headers['x-goog-api-key'] });
    return /generativelanguage/.test(url)
      ? new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION',
          message: 'User location is not supported for the API use.' } }), { status: 400 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
  };
  try {
    const out = await gemini.geminiGenerateContent('google-key', 'gemini-3.6-flash',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    assert.equal(out.candidates[0].content.parts[0].text, 'ok');
    landedOn = gemini._routing().door; // read before the cleanup below resets it
  } finally {
    globalThis.fetch = real;
    delete process.env.GEMINI_PROXY_URL; delete process.env.GEMINI_PROXY_KEY; delete process.env.VERTEX_API_KEY;
    gemini._resetRouting();
  }

  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-3\.6-flash:generateContent/,
    'the judge model is served by Vertex at the same shape, so only the host changes');
  assert.equal(seen[1].key, 'vertex-express-key', 'and with the Vertex key, not Google\'s or ours');
  assert.equal(landedOn, 'vertex', 'and that instance stays there');
});

test('once a door is chosen the whole job uses it — one refusal, not one per call', async () => {
  // A judge makes several calls per attempt and a job makes several attempts.
  // Re-learning the geo-block on every one of them would add a wasted round trip
  // to each, which is exactly the kind of quiet tax that turned two minutes into
  // ten in the first place.
  gemini.setDeadline(null);
  process.env.VERTEX_API_KEY = 'vertex-express-key';
  gemini._resetRouting();

  let refused = 0, served = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/generativelanguage/.test(url)) {
      refused++;
      return new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION',
        message: 'User location is not supported for the API use.' } }), { status: 400 });
    }
    served++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
  };
  try {
    for (let i = 0; i < 5; i++) {
      await gemini.geminiGenerateContent('google-key', 'gemini-3.6-flash', { contents: [] });
    }
  } finally {
    globalThis.fetch = real;
    delete process.env.VERTEX_API_KEY;
    gemini._resetRouting();
  }
  assert.equal(refused, 1, 'refused exactly once, at the start');
  assert.equal(served, 5, 'and every call after that went straight to the door that works');
});

test('the starting rung can be chosen, so the lower ones are testable for real', () => {
  // The fallback rungs are the ones that matter most and the hardest to reach on
  // purpose — you cannot ask Google to geo-block you. GEMINI_DOOR starts the
  // ladder lower, which is how the Vertex rung was proved end to end: an
  // invalid developer-API key, GEMINI_DOOR=vertex, and a full empty-room job
  // that read the room, generated, judged and watermarked in 48 seconds without
  // the developer API being reachable at all.
  process.env.GEMINI_DOOR = 'vertex';
  gemini._resetRouting();
  assert.equal(gemini._routing().door, 'vertex');

  process.env.GEMINI_DOOR = 'nonsense';
  gemini._resetRouting();
  assert.equal(gemini._routing().door, 'direct', 'a value that is not a door is ignored, not obeyed');

  delete process.env.GEMINI_DOOR;
  gemini._resetRouting();
  assert.equal(gemini._routing().door, 'direct', 'and the default is still the fast path');
});

test('a generation is not started in a window it cannot finish in', () => {
  // Every call clamps its timeout to what the job has left, which is right for a
  // judge and wrong for a generation: an image takes 30–60 seconds and cannot be
  // hurried. Seen live on 26 Aug 2026 — "Vertex request timed out after 44s", a
  // healthy provider, a valid request, and no chance of finishing. Forty-four
  // seconds of the customer's wait spent proving it.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /MIN_GENERATION_MS \|\| '75000'/, 'a generation needs a real window, not a leftover one');
  const helper = src.slice(src.indexOf('async function generateImage'), src.indexOf('const wantsVertex'));
  assert.match(helper, /msLeft\(\)/, 'checked before either door is knocked at');
  assert.match(helper, /run interrupted, not failed/,
    'and worded so the retry queue picks it up — this run did not happen, it was not refused');

  // The container must agree, or the job fails instead of being run again.
  const server = readFileSync(join(root, 'container', 'server.js'), 'utf8');
  // 900 chars, not 500 — the verdict-less-crash comment (1 Sep 2026) pushed
  // 'run interrupted' past the old window and false-failed this pin.
  const retryable = server.slice(server.indexOf('const RETRYABLE'), server.indexOf('const RETRYABLE') + 900);
  assert.match(retryable, /run interrupted/);
});

test('every render is 2K, because 4K costs two minutes and buys nothing', () => {
  // Measured across 28 real jobs on 26 Aug 2026: 2K median 2:30, 4K median 4:17,
  // and 4K is double the per-image cost. Kyle's target is 2.5–3 minutes, and his
  // own words on the big files: "once the agent downloads, it's automatically
  // downsized for them anyway. They can't use those big files on the MLS."
  // MLS standard upload is 2048x1536.
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.match(toml, /^IMAGE_SIZE = "2K"$/m, 'the whole slow half of the job list depends on this line');
  const src = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  assert.match(src, /env\.IMAGE_SIZE \? \{ IMAGE_SIZE: env\.IMAGE_SIZE \}/,
    'and the container has to actually be handed it');
});

test('a single request cannot sit on a dead socket for three minutes', () => {
  // Set when nobody had measured a generation. Measured since: 27–37s at 2K,
  // and every render is 2K now. Live on 27 Aug 2026 an `empty` job spent 412
  // seconds — a 77-second Vertex timeout, then the other door, then patient
  // retries, all inside ONE attempt. The job budget cannot stop that: it only
  // decides whether to START an attempt, because an attempt already running is
  // deliberately left alone so a paid generation is never discarded. The
  // per-request timeout is the lever that actually bounds it.
  for (const [f, v] of [['gemini.js', 'GEMINI_TIMEOUT_MS'], ['vertex.js', 'VERTEX_TIMEOUT_MS']]) {
    const src = readFileSync(join(root, 'pipeline', f), 'utf8');
    assert.match(src, new RegExp(`${v} \\\\|\\\\| '120000'`), `${f} should allow two minutes, not three`);
  }
});
