/**
 * The container's pulse (1 Sep 2026).
 *
 * Kyle's staging delivered in 17.2 minutes: a 4-minute run behind a silently
 * lost dispatch that the old 12-minute silence rule took its full 12 minutes
 * to notice. Containers now beat every 45 seconds while a run is in flight,
 * and the sweep reads three minutes of silence FROM A HEARTBEATING CONTAINER
 * as provably lost. Jobs with no pulse (an older container image mid-rollout)
 * keep the patient 12-minute rule, so nothing running is ever stolen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';
import { TestD1, testCtx } from './helpers/d1.js';

const SITE = 'https://listinglab.test';
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

async function seedJob(db, { id = 'j1', dispatched = null, heartbeat = null } = {}) {
  await db.prepare("INSERT OR IGNORE INTO accounts (id, email, password_hash, created_at) VALUES ('a1', 'k@x.test', 'h', '2026-09-01')").run();
  await db.prepare("INSERT OR IGNORE INTO listings (id, account_id, address, created_at) VALUES ('l1', 'a1', 'x', '2026-09-01')").run();
  await db.prepare("INSERT OR IGNORE INTO photos (id, listing_id, account_id, original_key, created_at) VALUES ('p1', 'l1', 'a1', 'k', '2026-09-01')").run();
  await db.prepare(`INSERT INTO jobs (id, account_id, photo_id, transformation, status, attempts_allowed, created_at, last_dispatch_at, heartbeat_at)
              VALUES (?, 'a1', 'p1', 'staging', 'running', 3, ?, ?, ?)`)
    .bind(id, iso(20 * 60_000), dispatched, heartbeat).run();
}

test('a heartbeating container that goes quiet for 3 minutes is provably lost — 12 blind minutes become 3', async () => {
  const db = new TestD1(); const store = new Store(db);
  await seedJob(db, { dispatched: iso(4 * 60_000), heartbeat: iso(4 * 60_000) });
  // Old rule alone would NOT have claimed this (dispatched only 4 min ago).
  const claimed = await store.claimStalledJobs(iso(12 * 60_000), iso(3 * 60_000));
  assert.equal(claimed.length, 1, 'four minutes without a beat = lost, reclaim now');
  db.close();
});

test('a fresh pulse protects a long run; no pulse at all keeps the patient rule', async () => {
  const db = new TestD1(); const store = new Store(db);
  // 11 minutes into a run, but the last beat was 30s ago: legitimately working.
  await seedJob(db, { id: 'working', dispatched: iso(11 * 60_000), heartbeat: iso(30_000) });
  // Dispatched 5 minutes ago, never beat once: could be an old pulse-less
  // container mid-run — only the 12-minute rule may touch it.
  await seedJob(db, { id: 'unknown', dispatched: iso(5 * 60_000) });
  const claimed = await store.claimStalledJobs(iso(12 * 60_000), iso(3 * 60_000));
  assert.equal(claimed.length, 0, 'neither is stolen: one is provably alive, one is merely unknown');
  db.close();
});

test('the heartbeat route stamps the pulse, guards its secret, and dispatch resets it', async () => {
  const db = new TestD1(); const store = new Store(db);
  await seedJob(db, { dispatched: iso(60_000) });
  const env = { DB: db, PIPELINE_SECRET: 'pipeline-shared-secret', SITE_URL: SITE,
    PHOTOS: { get: async () => null }, ASSETS: { fetch: async () => new Response('x') },
    PIPELINE: { idFromName: n => n, get: () => ({ fetch: async () => new Response('{}', { status: 202 }) }) } };
  const ctx = testCtx();
  const beat = (secret) => worker.fetch(new Request(`${SITE}/internal/jobs/j1/heartbeat`, {
    method: 'POST', headers: secret ? { 'x-pipeline-secret': secret } : {},
  }), env, ctx);

  assert.equal((await beat('wrong')).status, 401, 'a beat without the secret is rejected');
  assert.equal((await beat('pipeline-shared-secret')).status, 200);
  let row = await db.prepare("SELECT heartbeat_at FROM jobs WHERE id='j1'").first();
  assert.ok(row.heartbeat_at, 'the pulse is stamped');

  await store.markDispatched('j1', new Date().toISOString());
  row = await db.prepare("SELECT heartbeat_at FROM jobs WHERE id='j1'").first();
  assert.equal(row.heartbeat_at, null,
    're-dispatch clears the old pulse — a stale beat must never mark a fresh hand-off as lost');

  db.prepare("UPDATE jobs SET finished_at='2026-09-01T00:00:00Z' WHERE id='j1'").run();
  await beat('pipeline-shared-secret');
  row = await db.prepare("SELECT heartbeat_at FROM jobs WHERE id='j1'").first();
  assert.equal(row.heartbeat_at, null, 'a finished job ignores late beats');
  db.close();
});

test('the container actually beats: at start, every 45s, and stops when the run ends', () => {
  const src = readFileSync(new URL('../container/server.js', import.meta.url), 'utf8');
  assert.match(src, /replace\(\/\\\/result\$\/, '\/heartbeat'\)/, 'the beat aims at the heartbeat route');
  assert.match(src, /beat\(\);\s*\n\s*const hbTimer = setInterval\(beat, 45_000\)/, 'one beat at start, then every 45s');
  assert.match(src, /clearInterval\(hbTimer\)/, 'and the pulse stops with the run');
  const w = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(w, /HB_STALE_MS = 3 \* 60 \* 1000/, 'three minutes of missed beats is the lost threshold');
  assert.match(w, /claimStalledJobs\(new Date\(now - STALE_AFTER_MS\)\.toISOString\(\), new Date\(now - HB_STALE_MS\)\.toISOString\(\), 10, new Date\(now - NO_FIRST_BEAT_MS\)\.toISOString\(\)\)/,
    'the sweep passes all three tiers');
});
