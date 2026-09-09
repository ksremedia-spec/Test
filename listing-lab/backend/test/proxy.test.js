/**
 * Listing Lab — the Google proxy, and the ceiling it puts on every job.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT WAS WRONG
 * The container cannot reach Google directly (Round 27: Google refuses its egress
 * addresses), so every call goes through the Worker. When Google slowed to
 * minutes per frame on 26 Aug 2026, every job came back `Gemini 524: error code:
 * 524`, and 524 is Cloudflare's error, not Google's. I concluded the edge was
 * killing our slow REPLY and built a keepalive that streamed whitespace until
 * Google answered — plus an envelope, because a streamed response has to send its
 * status before the answer exists.
 *
 * Then I measured it, with a throwaway probe Worker:
 *
 *   silent for 150s, no keepalive   → HTTP 200 in 150.4s
 *   forwarding a real generation    → {"status":524,"ms":125037}
 *
 * The reply side was never the problem. The 524 arrives on the OUTBOUND leg:
 * Cloudflare cuts a Worker's own fetch at the proxy read timeout of 125 seconds
 * and hands back a synthesised 524. The keepalive could not have helped, and the
 * envelope broke a live job the first time the Worker and container deployed out
 * of step. Both are gone.
 *
 * What remains is the ceiling itself, which is real and worth naming in a test:
 * any generation Google takes longer than ~2 minutes to produce fails on this hop
 * regardless of the pipeline. The fix is not being on the hop — Vertex AI, called
 * from the container directly — which is a decision, not a patch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { unwrapProxy } = require(join(root, 'pipeline', 'gemini.js'));

const env = db => ({
  DB: db, PHOTOS: new TestR2(), PIPELINE_SECRET: 'shh',
  GEMINI_API_KEY: 'the-real-key', SITE_URL: 'https://example.test',
});
const proxyReq = (tail, headers = { 'x-goog-api-key': 'shh' }) =>
  new Request(`https://example.test/internal/gemini/${tail}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  });

test('Google\'s reply is passed through exactly as it came', async () => {
  // The pipeline's retry logic reads the status. Anything this hop invents —
  // a wrapper, a rewritten code — is a lie about what Google said.
  const db = new TestD1();
  const realFetch = globalThis.fetch;
  let sawKey = null;
  globalThis.fetch = (url, init) => {
    sawKey = init.headers['x-goog-api-key'];
    return Promise.resolve(new Response('{"steps":[{"type":"model_output"}]}', { status: 200 }));
  };
  try {
    const res = await worker.fetch(proxyReq('interactions'), env(db), testCtx());
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(text, '{"steps":[{"type":"model_output"}]}');
    assert.ok(!text.includes('__proxy'), 'no envelope, no wrapper — the reply is the reply');
    assert.equal(sawKey, 'the-real-key', 'the shared secret is swapped for the real key here');
  } finally { globalThis.fetch = realFetch; db.close(); }
});

test('a 524 reaches the pipeline as a 524, so it retries', async () => {
  // This is the shape of a slow Google: Cloudflare cuts the Worker's own fetch at
  // 125s and synthesises this. It must arrive retryable, not as a success.
  const db = new TestD1();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('error code: 524\n', { status: 524 }));
  try {
    const res = await worker.fetch(proxyReq('interactions'), env(db), testCtx());
    assert.equal(res.status, 524);
  } finally { globalThis.fetch = realFetch; db.close(); }
});

test('the client still tolerates an enveloped reply from an older Worker', () => {
  // The envelope is gone from the Worker, but a container in the field may still
  // meet one during a rollout. Unwrapping stays until every container is rolled.
  const enveloped = '   ' + JSON.stringify({ __proxy: { status: 503 }, body: '{"error":{"code":503}}' });
  assert.deepEqual(unwrapProxy(200, enveloped), { status: 503, text: '{"error":{"code":503}}' });
  const plain = '{"candidates":[]}';
  assert.deepEqual(unwrapProxy(429, plain), { status: 429, text: plain });
});

test('nothing streams a keepalive any more', () => {
  // Measured dead: a Worker that says nothing for 150 seconds still returns 200.
  // Code kept "just in case" against a disproved theory is code that will be
  // maintained, deployed and eventually broken for no reason.
  const src = readFileSync(join(root, 'src', 'worker.js'), 'utf8');
  assert.ok(!/KEEPALIVE_MS/.test(src), 'the keepalive constant should be gone');
  assert.ok(!/TransformStream/.test(src), 'the streamed proxy response should be gone');
  assert.match(src, /125 seconds/, 'the real ceiling should be written down where it bites');
});

test('the proxy still refuses anything but the two endpoints it exists for', async () => {
  const db = new TestD1();
  const e = env(db);
  for (const tail of ['files', 'models/x:streamGenerateContent', 'upload/v1beta/files']) {
    const res = await worker.fetch(proxyReq(tail), e, testCtx());
    assert.equal(res.status, 404, `${tail} should not be proxied`);
  }
  // Traversal never reaches the route: the URL parser resolves
  // `/internal/gemini/models/../../secret` to `/internal/secret` before routing,
  // where it is refused for having no session. Not a 404, still not proxied.
  const traversal = await worker.fetch(proxyReq('models/../../secret'), e, testCtx());
  assert.ok(traversal.status === 401 || traversal.status === 404, `traversal returned ${traversal.status}`);
  const wrongSecret = await worker.fetch(proxyReq('interactions', { 'x-goog-api-key': 'nope' }), e, testCtx());
  assert.equal(wrongSecret.status, 404, 'and it is an open proxy to a paid API without the secret');
  db.close();
});
