/**
 * The poisoned-slots defense (2 Sep 2026). The midday battery failed 8/20
 * jobs — every one on one of four sick container slots, retried to death on
 * the same slot. Three layers now stand: retry slot-hopping, the dispatch
 * health probe with quarantine, and the deploy cycle signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = readFileSync(join(root, 'src', 'worker.js'), 'utf8');
const container = readFileSync(join(root, 'container', 'server.js'), 'utf8');
const store = readFileSync(join(root, 'src', 'store.js'), 'utf8');
const schema = readFileSync(join(root, 'schema.sql'), 'utf8');

test('retries hop slots — a poisoned slot can never eat every attempt', () => {
  assert.match(worker, /function poolSlot\(jobId, spread = 0\)/, 'the slot hash takes a spread');
  assert.match(worker, /poolSlot\(jobId, \(spread \|\| 0\) \+ hop\)/, 'each probe hop tries a different slot');
});

test('dispatch knocks before handing a job over, and sick slots are quarantined', () => {
  assert.match(worker, /pickHealthySlot\(env, store, job\.id, job\.outage_retries \|\| 0\)/,
    'dispatch goes through the probe, retry count as the spread');
  assert.match(worker, /https:\/\/pipeline\.internal\/health/, 'the knock is the health endpoint');
  assert.match(worker, /if \(body\.draining\) return \{ ok: false/, 'a draining instance reads as unavailable');
  assert.match(worker, /quarantined\.has\(slotName\) && hop < 3/, 'quarantined slots are skipped without knocking — but the last hop still tries');
  assert.match(worker, /return poolSlot\(jobId, spread \|\| 0\);/, 'when everything looks sick, dispatch proceeds anyway — parking stays the backstop');
  assert.match(store, /ON CONFLICT\(slot\) DO UPDATE/, 'probe results accumulate per slot');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS slot_health/, 'and the table is in the schema');
});

test('the cycle signal drains, refuses, and exits — never kills a running job', () => {
  assert.match(container, /req\.url === '\/cycle'/, 'the container accepts the cycle order');
  assert.match(container, /if \(draining\) \{/, 'a draining instance refuses new jobs');
  assert.match(container, /draining && inFlight === 0/, 'it exits only when idle');
  assert.match(container, /inFlight--; exitIfDrained\(\);/, 'the last finishing job triggers the exit');
  assert.match(container, /ok: true, draining, inFlight/, 'health reports the drain so the probe routes around it');
  assert.match(worker, /\/internal\/board\/cycle/, 'the owner can cycle the whole fleet after a deploy');
  const index = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  assert.match(index, /r\.status !== 404\) return r/, 'a modern instance drains politely');
  assert.match(index, /this\.ctx\.container\.destroy\(\)/,
    'an instance too old to know /cycle is destroyed outright — no straggler survives a cycle');
});
