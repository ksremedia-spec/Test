/**
 * Listing Lab — the fleet cycles itself after a container deploy (11 Sep 2026).
 *
 * WHY THIS FILE EXISTS. Instances keep serving the old image until they are
 * cycled, so every container deploy ended with Kyle pasting a curl command
 * and the dashboard key into a terminal. He has to do that for every future
 * pipeline change too, and forgetting it means debugging code that is not
 * running. Now the deploy carries the image tag, the minute cron notices it
 * changed, and the fleet cycles itself.
 *
 * The promises held here: a new tag cycles once and only once, the same tag
 * never cycles again, a deploy that did not change the image cycles nothing,
 * and a cycle that reached no slot at all is retried rather than recorded as
 * done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from './helpers/d1.js';
import { Store } from '../src/store.js';
import { autoCycleIfNewImage, cycleFleet } from '../src/worker.js';

const POOL = 15, SLOTS = POOL + 1;   // the pool, plus the classify slot

/** A stand-in for the container binding: records who was told to cycle. */
function fakePipeline({ fail = false, failFor = () => false } = {}) {
  const cycled = [];
  return {
    cycled,
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (url, init) => {
        assert.equal(url, 'https://pipeline.internal/cycle');
        assert.equal(init.method, 'POST');
        if (fail || failFor(name)) throw new Error('instance unreachable');
        cycled.push(name);
        return new Response(JSON.stringify({ draining: true, inFlight: 0 }), { status: 200 });
      },
    }),
  };
}

const envWith = (pipeline, tag) => ({ PIPELINE: pipeline, CONTAINER_TAG: tag });

test('every slot in the pool is cycled, and the classify slot too', async () => {
  const pipeline = fakePipeline();
  const out = await cycleFleet(envWith(pipeline));
  assert.equal(out.length, SLOTS);
  assert.ok(out.every(s => s.status === 200), JSON.stringify(out.filter(s => s.status !== 200)));
  assert.deepEqual(pipeline.cycled, [...Array(POOL).keys()].map(i => `pipeline-${i}`).concat('classify'));
  assert.deepEqual(out[0].body, { draining: true, inFlight: 0 });
});

test('an unreachable instance is reported, not thrown, and the rest still cycle', async () => {
  const pipeline = fakePipeline({ failFor: (n) => n === 'pipeline-7' });
  const out = await cycleFleet(envWith(pipeline));
  assert.equal(out.length, SLOTS);
  assert.equal(out.filter(s => s.status === 200).length, SLOTS - 1);
  const bad = out.find(s => s.slot === 'pipeline-7');
  assert.match(bad.error, /unreachable/);
  assert.deepEqual(out.map(s => s.slot), [...Array(POOL).keys()].map(i => `pipeline-${i}`).concat('classify'),
    'every slot is accounted for, in order');
});

test('a slot that misses its turn is tried again, and the healthy ones are not', async () => {
  // The real 15/16: one instance was mid-creation and refused the first ask.
  let refusals = 2;
  const pipeline = fakePipeline({ failFor: (n) => n === 'pipeline-3' && refusals-- > 0 });
  const out = await cycleFleet(envWith(pipeline));
  assert.equal(out.filter(s => s.status === 200).length, SLOTS, 'the third try got it');
  assert.equal(pipeline.cycled.filter(n => n === 'pipeline-3').length, 1, 'cycled once, not three times');
  assert.equal(pipeline.cycled.filter(n => n === 'pipeline-0').length, 1, 'a healthy slot is never asked twice');
});

test('a slot that never answers is named and left, not retried forever', async () => {
  const db = new TestD1(); const store = new Store(db);
  const pipeline = fakePipeline({ failFor: (n) => n === 'pipeline-9' });
  const out = await autoCycleIfNewImage(envWith(pipeline, 'nursery1'), store);
  assert.equal(out.ok, true, 'fifteen of sixteen is a cycle, not a failure');
  assert.deepEqual(out.missed, ['pipeline-9']);
  assert.equal(await store.getSetting('cycled_container_tag'), 'nursery1', 'recorded, so the healthy slots are left alone');
  assert.equal(await autoCycleIfNewImage(envWith(pipeline, 'nursery1'), store), null);
  db.close();
});

test('a new image tag cycles the fleet once, and later ticks do nothing', async () => {
  const db = new TestD1(); const store = new Store(db);
  const pipeline = fakePipeline();
  const env = envWith(pipeline, 'nursery1');

  const first = await autoCycleIfNewImage(env, store);
  assert.equal(first.ok, true);
  assert.equal(first.tag, 'nursery1');
  assert.equal(pipeline.cycled.length, SLOTS);
  assert.equal(await store.getSetting('cycled_container_tag'), 'nursery1');

  // The cron fires every minute; the fleet must not be cycled every minute.
  for (let tick = 0; tick < 5; tick++) assert.equal(await autoCycleIfNewImage(env, store), null);
  assert.equal(pipeline.cycled.length, SLOTS, 'still just the one cycle');

  // The next container deploy carries a new tag, and that one cycles again.
  const again = await autoCycleIfNewImage(envWith(pipeline, 'nursery2'), store);
  assert.equal(again.ok, true);
  assert.equal(pipeline.cycled.length, SLOTS * 2);
  assert.equal(await store.getSetting('cycled_container_tag'), 'nursery2');
  db.close();
});

test('a deploy that did not change the image cycles nothing', async () => {
  const db = new TestD1(); const store = new Store(db);
  const pipeline = fakePipeline();
  // A Worker-only deploy carries the same tag as the running image.
  await store.setSetting('cycled_container_tag', 'nursery1', '2026-09-11T00:00:00Z');
  assert.equal(await autoCycleIfNewImage(envWith(pipeline, 'nursery1'), store), null);
  assert.equal(pipeline.cycled.length, 0);
  db.close();
});

test('no tag at all (an older deploy) cycles nothing and records nothing', async () => {
  const db = new TestD1(); const store = new Store(db);
  const pipeline = fakePipeline();
  assert.equal(await autoCycleIfNewImage({ PIPELINE: pipeline }, store), null);
  assert.equal(pipeline.cycled.length, 0);
  assert.equal(await store.getSetting('cycled_container_tag'), null);
  db.close();
});

test('a cycle that reached nothing is retried on the next tick, not recorded as done', async () => {
  const db = new TestD1(); const store = new Store(db);
  const dead = fakePipeline({ fail: true });
  const out = await autoCycleIfNewImage(envWith(dead, 'nursery1'), store);
  assert.equal(out.ok, false);
  assert.equal(await store.getSetting('cycled_container_tag'), '', 'the claim was put back');

  // The next tick, with the fleet answering again, cycles it properly.
  const alive = fakePipeline();
  const retry = await autoCycleIfNewImage(envWith(alive, 'nursery1'), store);
  assert.equal(retry.ok, true);
  assert.equal(alive.cycled.length, SLOTS);
  assert.equal(await store.getSetting('cycled_container_tag'), 'nursery1');
  db.close();
});
