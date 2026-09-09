/**
 * The meter exists to answer one question Kyle asked before the 88-frame golden
 * run: where did the time go, and what did it cost. These tests hold it to that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const meter = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'meter.js'));

test('time spent is reported as durations, biggest first — not as cumulative marks', () => {
  const m = meter.newMeter();
  m.phases.push({ name: 'manifest', ms: 2100 }, { name: 'gen1', ms: 31000 }, { name: 'checks1', ms: 9500 });
  const s = meter.summarise(m);
  assert.deepEqual(s.timeSpent.map(p => p.name), ['gen1', 'checks1', 'manifest']);
  assert.equal(s.timeSpent[0].seconds, 31);
});

test('repeated phases across attempts add up rather than overwrite', () => {
  const m = meter.newMeter();
  m.phases.push({ name: 'gen', ms: 30000 }, { name: 'gen', ms: 25000 });
  assert.equal(meter.summarise(m).timeSpent[0].seconds, 55);
});

test('cost counts images at the size actually rendered', () => {
  const m = meter.newMeter();
  meter.record(m, { kind: 'image', model: 'gemini-3-pro-image', ms: 1 });
  // No usageMetadata came back, so the image bills at its documented token count
  // for the size asked for: 1,120 tokens at 2K, 2,000 at 4K, $120/M output.
  assert.equal(+meter.summarise(m, { imageSize: '2K' }).cost.toFixed(3), 0.134);
  assert.equal(+meter.summarise(m, { imageSize: '4K' }).cost.toFixed(3), 0.240);
});

test('when the API reports tokens, cost is measured from them rather than assumed', () => {
  const m = meter.newMeter();
  meter.record(m, { kind: 'flash', model: 'gemini-3.6-flash', promptTokens: 2000, outputTokens: 300, ms: 1 });
  // 2000 in at $0.75/M + 300 out at $3.75/M. Asserted on costOf rather than the
  // summary, which rounds to four places for reporting.
  // Float arithmetic, so compare at cent-fractions rather than exact bits.
  assert.equal(+meter.costOf(m.calls[0]).toFixed(8), 0.002625);
});

test('a vision check is cents, not tens of cents — the bug that overstated a run by 3x', () => {
  const m = meter.newMeter();
  for (let i = 0; i < 14; i++) meter.record(m, { kind: 'flash', model: 'gemini-3.6-flash', promptTokens: 2000, outputTokens: 300, ms: 1 });
  const cost = meter.summarise(m).cost;
  assert.ok(cost < 0.06, `14 checks should be well under six cents, got $${cost}`);
});

test('a call that failed is not billed, but is reported', () => {
  const m = meter.newMeter();
  meter.record(m, { kind: 'image', model: 'gemini-3-pro-image', ms: 4000, ok: false, status: 429, door: 'vertex' });
  const s = meter.summarise(m);
  assert.equal(s.cost, 0, 'Google does not charge for a 429 and neither do we');
  assert.equal(s.images, 0);
  assert.equal(s.failedCalls.length, 1);
  assert.equal(s.failedCalls[0].status, 429);
});

test('twilight costs two images an attempt, and the meter shows it', () => {
  const m = meter.newMeter();
  meter.record(m, { kind: 'image', model: 'gemini-3-pro-image', ms: 30000 });  // overcast neutralisation
  meter.record(m, { kind: 'image', model: 'gemini-3-pro-image', ms: 32000 });  // dusk relight
  const s = meter.summarise(m, { imageSize: '2K' });
  assert.equal(s.images, 2);
  assert.equal(+s.cost.toFixed(3), 0.269);
});

test('which door served the work is recorded, so a silent failover is visible', () => {
  const m = meter.newMeter();
  meter.record(m, { kind: 'image', door: 'vertex', ms: 1 });
  meter.record(m, { kind: 'image', door: 'direct', ms: 1 });
  meter.record(m, { kind: 'flash', door: 'direct', ms: 1 });
  assert.deepEqual(meter.summarise(m).doors, { vertex: 1, direct: 2 });
});

test('start() returns its own stop, so a phase cannot be closed against the wrong timer', async () => {
  const m = meter.newMeter();
  const stop = meter.start(m, 'generate');
  await new Promise(r => setTimeout(r, 20));
  const ms = stop();
  assert.ok(ms >= 15, `expected ~20ms, got ${ms}`);
  assert.equal(m.phases[0].name, 'generate');
});

test('the current-job meter is per process, and note() is safe with no job running', () => {
  meter.setMeter(null);
  assert.doesNotThrow(() => meter.note({ kind: 'flash', ms: 1 }));
  const m = meter.setMeter(meter.newMeter());
  meter.note({ kind: 'flash', ms: 1 });
  assert.equal(meter.summarise(m).flashCalls, 1);
  meter.setMeter(null);
});

test('an image is priced by the model that drew it, not by the default', () => {
  // The meter used to read the model name out of the request URL. That works for
  // /models/<name>:generateContent and returns null for every image call, because
  // nanoBananaEdit posts to /interactions with the model in the body. Null fell
  // through to the pro-image rate table, so a run on the cheaper flash model was
  // billed at pro's price. Found by the fallback evaluation, 27 Aug 2026.
  const pro = meter.newMeter(), flash = meter.newMeter();
  meter.record(pro,   { kind: 'image', model: 'gemini-3-pro-image', ms: 1 });
  meter.record(flash, { kind: 'image', model: 'gemini-3.1-flash-image', ms: 1 });
  const p = meter.summarise(pro,   { imageSize: '2K' }).cost;
  const f = meter.summarise(flash, { imageSize: '2K' }).cost;
  assert.ok(f < p, `flash (${f}) must price below pro (${p})`);
  assert.equal(+p.toFixed(3), 0.134);
  assert.equal(+f.toFixed(3), 0.101);   // 1,680 tokens at $60/M
});

test('a 4K image is not priced with the 2K token count', () => {
  const m = meter.newMeter();
  meter.record(m, { kind: 'image', model: 'gemini-3.1-flash-image', ms: 1 });
  const two = meter.summarise(m, { imageSize: '2K' }).cost;
  const four = meter.summarise(m, { imageSize: '4K' }).cost;
  assert.ok(four > two, `4K (${four}) must cost more than 2K (${two})`);
});
