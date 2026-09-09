/**
 * The backup judge (31 Aug 2026).
 *
 * On 31 Aug a Google outage took the flash-family JUDGE models down together
 * with the image model, stranding a paid, finished generation that nothing
 * could approve. These tests pin the fallback: when Google's answer is an
 * outage and ANTHROPIC_API_KEY is set, the identical judge call goes to
 * Anthropic — wearing Gemini's request and response shapes, so no caller
 * changes — and image generation NEVER routes there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { geminiGenerateContent, setDeadline, _outageBreaker } = require(join(root, 'pipeline', 'gemini.js'));
const { toAnthropic } = require(join(root, 'pipeline', 'anthropic.js'));

const GEMINI_BODY = {
  contents: [{ role: 'user', parts: [
    { text: 'Judge this. Respond with ONLY JSON.' },
    { inline_data: { mime_type: 'image/jpeg', data: 'b64original' } },
    { inline_data: { mime_type: 'image/jpeg', data: 'b64candidate' } },
  ] }],
  generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
};
const BUSY_503 = JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } });

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}
const resp = (status, body) => new Response(body, { status });

test('the translation keeps every part: prompt text and both images, in order', () => {
  const req = toAnthropic(GEMINI_BODY);
  assert.equal(req.messages[0].content[0].type, 'text');
  assert.equal(req.messages[0].content[1].type, 'image');
  assert.equal(req.messages[0].content[1].source.data, 'b64original');
  assert.equal(req.messages[0].content[2].source.data, 'b64candidate');
  assert.equal(req.temperature, 0.1, 'the judge temperature carries over');
  assert.match(req.system, /ONLY the JSON/, 'the JSON-only demand replaces response_mime_type');
});

test('a Google outage on a judge call falls through to the backup, in Gemini’s envelope', async () => {
  _outageBreaker.reset();
  setDeadline(Date.now() + 120_000);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const asked = { google: 0, anthropic: 0 };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('anthropic.com')) {
      asked.anthropic++;
      return resp(200, JSON.stringify({ content: [{ type: 'text', text: '```json\n{"pass":true,"violations":[]}\n```' }] }));
    }
    asked.google++;
    return resp(503, BUSY_503);
  });
  try {
    const out = await geminiGenerateContent('gkey', 'gemini-3.6-flash', GEMINI_BODY);
    assert.ok(asked.google >= 1, 'Google was tried first');
    assert.equal(asked.anthropic, 1, 'then the backup judge was asked once');
    const text = out.candidates[0].content.parts[0].text;
    assert.deepEqual(JSON.parse(text), { pass: true, violations: [] },
      'the verdict arrives in Gemini’s envelope with the markdown fences stripped');
    assert.equal(out.__judgedBy, 'anthropic', 'and the response is marked as a backup verdict');
    assert.ok(_outageBreaker.count() > 0,
      'a backup success must NOT reset the Gemini breaker — Google is still down');
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset(); delete process.env.ANTHROPIC_API_KEY;
  }
});

test('a Google outage with only FAL_KEY set falls through to the fal judge door', async () => {
  // 1 Sep 2026, Kyle: "Can't we do it through fal?" — measured live first:
  // fal's any-llm/vision judged a full 2K delivery in 2.1s under the same key
  // the third generation door already uses. No Anthropic account required.
  _outageBreaker.reset();
  setDeadline(Date.now() + 120_000);
  delete process.env.ANTHROPIC_API_KEY;
  process.env.FAL_KEY = 'fal-test-key';
  const asked = { google: 0, fal: 0 };
  let falBody = null;
  const restore = stubFetch(async (url, init) => {
    if (String(url).includes('fal.run')) {
      asked.fal++; falBody = JSON.parse(init.body);
      return resp(200, JSON.stringify({ output: '```json\n{"pass":true,"violations":[]}\n```\nExtra commentary.', error: null }));
    }
    asked.google++;
    return resp(503, BUSY_503);
  });
  try {
    const out = await geminiGenerateContent('gkey', 'gemini-3.6-flash', GEMINI_BODY);
    assert.ok(asked.google >= 1, 'Google was tried first');
    assert.equal(asked.fal, 1, 'then the fal judge door was knocked once');
    assert.deepEqual(JSON.parse(out.candidates[0].content.parts[0].text), { pass: true, violations: [] },
      'fences AND post-fence commentary are stripped for Gemini-shaped parsers');
    assert.equal(out.__judgedBy, 'fal-llm', 'marked as a fal backup verdict');
    assert.equal(falBody.image_urls.length, 2, 'both images crossed over, in order');
    assert.ok(falBody.image_urls[0].endsWith('b64original'), 'original first');
    assert.match(falBody.prompt, /ONLY the JSON/, 'the JSON-only demand rides along');
    assert.ok(_outageBreaker.count() > 0, 'a fal verdict must NOT reset the Gemini breaker');
    assert.ok(asked.google <= 2,
      `with a backup available Google gets TWO brisk tries, not five slow ones (got ${asked.google}) — ` +
      'the morning batch lost a bedroom staging to a job clock that died inside Google\'s retry ladder');
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset(); delete process.env.FAL_KEY;
  }
});

test('with BOTH keys set, the direct Anthropic door wins — no middleman when one exists', async () => {
  _outageBreaker.reset();
  setDeadline(Date.now() + 120_000);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.FAL_KEY = 'fal-test-key';
  const asked = { anthropic: 0, fal: 0 };
  const restore = stubFetch(async (url) => {
    if (String(url).includes('anthropic.com')) { asked.anthropic++; return resp(200, JSON.stringify({ content: [{ type: 'text', text: '{}' }] })); }
    if (String(url).includes('fal.run')) { asked.fal++; return resp(200, JSON.stringify({ output: '{}' })); }
    return resp(503, BUSY_503);
  });
  try {
    await geminiGenerateContent('gkey', 'gemini-3.6-flash', GEMINI_BODY);
    assert.equal(asked.anthropic, 1);
    assert.equal(asked.fal, 0);
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset();
    delete process.env.ANTHROPIC_API_KEY; delete process.env.FAL_KEY;
  }
});

test('without the key, and on non-outage errors, nothing changes', async () => {
  _outageBreaker.reset();
  setDeadline(Date.now() + 120_000);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FAL_KEY;
  let anthropicAsked = 0;
  const restore = stubFetch(async (url) => {
    if (String(url).includes('anthropic.com')) { anthropicAsked++; return resp(200, '{}'); }
    return resp(503, BUSY_503);
  });
  try {
    await assert.rejects(() => geminiGenerateContent('gkey', 'gemini-3.6-flash', GEMINI_BODY), /503/,
      'no key: the outage surfaces exactly as before');
    assert.equal(anthropicAsked, 0, 'and the backup is never contacted');

    // A 400 (our own bad request) must never be laundered through a second vendor.
    _outageBreaker.reset();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const restore2 = stubFetch(async (url) => {
      if (String(url).includes('anthropic.com')) { anthropicAsked++; return resp(200, '{}'); }
      return resp(400, JSON.stringify({ error: { code: 400, message: 'INVALID_ARGUMENT' } }));
    });
    try {
      await assert.rejects(() => geminiGenerateContent('gkey', 'gemini-3.6-flash', GEMINI_BODY), /400/);
      assert.equal(anthropicAsked, 0, 'a non-outage error goes nowhere near the backup');
    } finally { restore2(); }
  } finally {
    restore(); setDeadline(null); _outageBreaker.reset(); delete process.env.ANTHROPIC_API_KEY;
  }
});

test('image generation never routes to the backup — a judge cannot draw', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(root, 'pipeline', 'gemini.js'), 'utf8');
  const gen = src.slice(src.indexOf('async function nanoBananaEdit'), src.indexOf('async function geminiGenerateContent'));
  assert.ok(!/anthropic/i.test(gen), 'nanoBananaEdit has no path to Anthropic');
  const idx = src.indexOf('const { anthropicGenerateContent }');
  const inGGC = src.indexOf('async function geminiGenerateContent') < idx;
  assert.ok(inGGC, 'the fallback lives inside geminiGenerateContent only');
  const w = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  assert.match(w, /env\.ANTHROPIC_API_KEY \? \{ ANTHROPIC_API_KEY/,
    'the container receives the key the same way it receives the Gemini keys');
});
