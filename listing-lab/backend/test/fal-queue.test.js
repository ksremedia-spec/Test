/**
 * THE QUEUE FALLBACK (2 Sep 2026). fal's direct endpoint answers 429 when
 * saturated; under a Google jam a whole batch funnels to fal at once, and
 * that was the last way pure traffic could kill a job. A saturated direct
 * call now takes a queue ticket and waits its turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { setDeadline } = require(join(root, 'pipeline', 'gemini.js'));
const { falEdit } = require(join(root, 'pipeline', 'fal.js'));

const IMG_B64 = Buffer.from('img').toString('base64');

test('a saturated direct call falls to the queue, polls, and returns the finished image', async () => {
  setDeadline(Date.now() + 120_000);
  const real = globalThis.fetch;
  const calls = [];
  let statusPolls = 0;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const u = String(url);
    if (u.startsWith('https://fal.run/')) {
      return new Response('{"detail":"Too many requests"}', { status: 429 });
    }
    if (u.includes('/status/')) {
      statusPolls++;
      return new Response(JSON.stringify({ status: statusPolls < 2 ? 'IN_QUEUE' : 'COMPLETED' }), { status: 200 });
    }
    if (u.includes('/result/')) {
      return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal.example/img.jpg', content_type: 'image/jpeg' }] }), { status: 200 });
    }
    if (u.startsWith('https://queue.fal.run/')) {
      assert.equal(JSON.parse(init.body).num_images, 1, 'the queue gets the identical payload');
      return new Response(JSON.stringify({ request_id: 'r1', status_url: 'https://queue.fal.run/status/r1', response_url: 'https://queue.fal.run/result/r1' }), { status: 200 });
    }
    if (u.includes('cdn.fal')) return new Response(Buffer.from('JPEGDATA'), { status: 200 });
    throw new Error('unexpected url ' + u);
  };
  try {
    const out = await falEdit('k', 'remove the sofa', IMG_B64, 'image/jpeg', { imageSize: '2K' });
    assert.equal(Buffer.from(out.data, 'base64').toString(), 'JPEGDATA', 'the queued image is the delivered image');
    assert.ok(statusPolls >= 2, 'it actually waited in line');
    assert.ok(calls.some(u => u.startsWith('https://queue.fal.run/fal-ai/nano-banana-pro/edit')), 'the ticket goes to the same app path on the queue host');
  } finally { globalThis.fetch = real; setDeadline(null); }
});

test('a clear day never touches the queue — direct answers, done', async () => {
  setDeadline(Date.now() + 120_000);
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://fal.run/')) {
      return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal.example/a.jpg', content_type: 'image/jpeg' }] }), { status: 200 });
    }
    if (String(url).includes('cdn.fal')) return new Response(Buffer.from('DIRECT'), { status: 200 });
    throw new Error('unexpected url ' + url);
  };
  try {
    const out = await falEdit('k', 'p', IMG_B64, 'image/jpeg', {});
    assert.equal(Buffer.from(out.data, 'base64').toString(), 'DIRECT');
    assert.ok(!calls.some(u => u.includes('queue.fal.run')), 'no queue call was made');
  } finally { globalThis.fetch = real; setDeadline(null); }
});

test('a real error (not saturation) still fails fast — 4xx is not a reason to queue', async () => {
  setDeadline(Date.now() + 120_000);
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{"detail":"unauthorized"}', { status: 401 });
  };
  try {
    await assert.rejects(() => falEdit('bad-key', 'p', IMG_B64, 'image/jpeg', {}), /fal 401/);
    assert.ok(!calls.some(u => u.includes('queue.fal.run')), 'a 401 never takes a ticket');
  } finally { globalThis.fetch = real; setDeadline(null); }
});
