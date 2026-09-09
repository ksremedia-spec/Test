/**
 * The owner's live view (31 Aug 2026) and the customer's "run it again".
 *
 * Built the afternoon a beta client texted Kyle about a job "working" for an
 * hour: he found out from her, not from his own product. The live page is the
 * other direction — every job of the last 24h with the log's errors turned
 * into sentences — and the rerun button is the customer's own road back after
 * a failure, instead of a re-upload and a text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { explainError, plainStatus } from '../src/live-page.js';
import { TestD1, testCtx } from './helpers/d1.js';

const SECRET = 'diag-secret-for-tests';
function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: 'https://example.test',
    DIAG_SECRET: SECRET,
    ASSETS: { fetch: async () => new Response('asset') },
  };
}
const get = (path) => new Request('https://example.test' + path);

test('the live page and its feed hide behind the same secret as the board', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  assert.equal((await worker.fetch(get('/internal/board/live'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board/live?s=wrong'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(get('/internal/board/live.json?s=wrong'), env, ctx)).status, 404);
  const ok = await worker.fetch(get(`/internal/board/live?s=${SECRET}`), env, ctx);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /refreshes itself/);
  const feed = await worker.fetch(get(`/internal/board/live.json?s=${SECRET}`), env, ctx);
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), [], 'an empty database is an empty feed, not an error');
});

test('raw log errors come out as sentences Kyle can act on', () => {
  assert.match(explainError('pipeline exceeded 600000ms and was killed'),
    /full time limit .* Google was refusing/i);
  assert.match(explainError('Gemini 503: {"error":{"message":"This model is currently experiencing high demand."}}'),
    /overloaded .* their capacity/i);
  assert.match(explainError('Gemini 429: rate limit exceeded'),
    /slow down .* flash model/i);
  assert.match(explainError('Gemini 503: upstream outage — 8 consecutive transient failures (circuit breaker)'),
    /refusing everything.*stopped early/i);
  assert.match(explainError('pipeline exited null: SIGKILL'),
    /interrupted mid-render.*deploy/i);
  assert.equal(explainError(''), null, 'no error, no sentence');
});

test('the status column speaks in outcomes and minutes, not enum values', () => {
  const now = Date.parse('2026-08-31T16:00:00Z');
  const base = { created_at: '2026-08-31T15:50:00Z', outage_retries: 0, retry_after: null, finished_at: null };
  assert.match(plainStatus({ ...base, status: 'running' }, now), /Working — 10 min in/);
  assert.match(plainStatus({ ...base, status: 'running', outage_retries: 2 }, now), /survived 2 Google waits/);
  assert.match(plainStatus({ ...base, status: 'queued', retry_after: 'soon', outage_retries: 1 }, now), /Parked \(1 wait/);
  assert.match(plainStatus({ ...base, status: 'delivered', finished_at: '2026-08-31T15:54:30Z' }, now), /Delivered in 4\.5 min/);
  assert.match(plainStatus({ ...base, status: 'failed', finished_at: '2026-08-31T15:56:00Z' }, now), /credits back/);
});

test("the jobs API hands the client what a rerun needs, and the app wires the tap", async () => {
  const { readFileSync } = await import('node:fs');
  const w = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(w, /photoId: j\.photo_id/, 'jobList exposes the photo behind each job');
  const app = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(app, /if \(j\.photoId\) \{/,
    'rerun choices only appear when the photo is still on file');
  assert.match(app, /rerunJob/, 'and the tap starts the same photo + transformation again');
  assert.match(app, /if \(t === j\.transformation && j\.style\) body\.style = j\.style/,
    'style carries over so a staging reruns as itself — but never across transformations');
});

test('tapping a job serves its full story — gated, and honest about what images exist', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  assert.equal((await worker.fetch(get('/internal/board/live/job.json?id=job_x'), env, ctx)).status, 404,
    'no secret, no story');
  assert.equal((await worker.fetch(get(`/internal/board/live/job.json?s=${SECRET}&id=job_nope`), env, ctx)).status, 404,
    'an unknown job is a 404, not an empty story');
});

test('the detail turns attempt records into events: waits translated, objections verbatim', async () => {
  const { liveJobJson } = await import('../src/live-page.js');
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  // A job with one outage wait and one rejected attempt, planted directly.
  db.db.prepare("INSERT INTO accounts (id, email, password_hash, created_at) VALUES ('acct_1','liz@example.com','x','2026-08-31')").run();
  db.db.prepare("INSERT INTO listings (id, account_id, address, created_at) VALUES ('lst_1','acct_1','Uploads','2026-08-31')").run();
  db.db.prepare("INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES ('pho_1','lst_1','acct_1','acct_1/pho_1/orig.jpg','2026-08-31')").run();
  db.db.prepare(`INSERT INTO jobs (id, account_id, photo_id, transformation, status, created_at, reject_key, rejection_note)
                 VALUES ('job_1','acct_1','pho_1','declutter','rejected','2026-08-31T15:00:00Z','acct_1/pho_1/job_1-rejected.jpg','No result passed our compliance checks.')`).run();
  db.db.prepare(`INSERT INTO job_attempts (id, job_id, attempt_no, outcome, audit_json, created_at) VALUES
    ('att_1','job_1',1000,'error','{"error":"Gemini 503: high demand"}','2026-08-31T15:02:00Z')`).run();
  db.db.prepare(`INSERT INTO job_attempts (id, job_id, attempt_no, outcome, audit_json, created_at) VALUES
    ('att_2','job_1',1,'rejected','{"attempts":[{"attempt":1,"pass":false,"violations":["Laundry basket still in frame"]}]}','2026-08-31T15:06:00Z')`).run();

  const d = await liveJobJson(env, 'job_1');
  assert.equal(d.rejectKey, 'acct_1/pho_1/job_1-rejected.jpg', 'the refused frame is offered as evidence');
  assert.equal(d.events.length, 2);
  assert.equal(d.events[0].kind, 'wait');
  assert.match(d.events[0].text, /overloaded/, 'the wait is a translated sentence, not a status code');
  assert.equal(d.events[1].kind, 'attempt');
  assert.deepEqual(d.events[1].candidates[0].violations, ['Laundry basket still in frame'],
    "the judges' objection reaches Kyle word for word");
  void ctx;
});

test('every gallery card answers its tap: watch, why, or view', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(app, /else if \(working\) resumeWatching\(j\)/,
    'a working card returns to the progress screen instead of doing nothing');
  assert.match(app, /state\.started = Date\.parse\(j\.startedAt\)/,
    'and the progress clock resumes from when the job really started');
  assert.match(app, /else if \(returned\) openReturnedSheet\(j, el\)/,
    'a returned card opens the why-and-what-now sheet');
  // Select mode (9 Sep 2026): a finished card toggles its tick instead of
  // opening the viewer, and the set can leave as one share or one ZIP.
  assert.match(app, /if \(state\.selecting\) \{ if \(j\.status === 'delivered'\) togglePick\(j\.jobId, el\); return; \}/,
    'in select mode a finished card toggles, an unfinished one is inert');
  assert.match(app, /\/api\/jobs\/zip\?ids=/, 'the ZIP download points at the set endpoint');
  assert.match(app, /Credits returned — tap to see why/,
    'the card itself says the credits came back');
  assert.match(app, /rerunReason'\)\.textContent = j\.note \|\|/,
    'the sheet leads with the actual reason, verbatim');
  assert.match(app, /\[\['empty', btn\('Try Empty Room', true\)\], \['declutter'/,
    'a rejected declutter leads with Empty Room — the checks already refused every tidy-up');
  assert.match(app, /\[\['declutter', btn\('Run Declutter again', true\)\], \['empty'/,
    'a failed declutter leads with the same declutter — the run never got a fair shot');
  assert.match(app, /if \(t === j\.transformation && j\.style\) body\.style = j\.style/,
    'options never leak across transformations — an empty rerun carries no staging style');
});

test('a candidate killed after the judges names its killer, all the way to the board', async () => {
  // Kyle, 31 Aug: a Luxury staging candidate 'passed' with no violations and
  // never delivered — realism had killed it off the record. Every later gate
  // now names itself in the stored audit and the Live detail.
  const { auditSummary } = await import('../src/worker.js');
  const summary = auditSummary({
    type: 'staging', outcome: 'rejected',
    attempts: [
      { candidate: 1, verdict: { pass: true, violations: [] }, killedBy: 'realism',
        realism: { worst: 'severe' } },
      { candidate: 2, verdict: { pass: true, violations: [] }, killedBy: 'structure',
        structure: { violations: ['built-in kitchen island: is missing from the result'] } },
    ],
  });
  assert.equal(summary.attempts[0].killedBy, 'realism');
  assert.equal(summary.attempts[1].killedBy, 'structure');
  assert.deepEqual(summary.attempts[1].structure.violations,
    ['built-in kitchen island: is missing from the result']);

  const { liveJobJson } = await import('../src/live-page.js');
  const db = new TestD1(); const env = makeEnv(db);
  db.db.prepare("INSERT INTO accounts (id, email, password_hash, created_at) VALUES ('acct_k','k@example.com','x','2026-08-31')").run();
  db.db.prepare("INSERT INTO listings (id, account_id, address, created_at) VALUES ('lst_k','acct_k','Uploads','2026-08-31')").run();
  db.db.prepare("INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES ('pho_k','lst_k','acct_k','k/orig.jpg','2026-08-31')").run();
  db.db.prepare("INSERT INTO jobs (id, account_id, photo_id, transformation, status, created_at) VALUES ('job_k','acct_k','pho_k','staging','rejected','2026-08-31T20:00:00Z')").run();
  db.db.prepare("INSERT INTO job_attempts (id, job_id, attempt_no, outcome, audit_json, created_at) VALUES ('att_k','job_k',1,'rejected',?,'2026-08-31T20:05:00Z')")
    .run(JSON.stringify(summary));
  const d = await liveJobJson(env, 'job_k');
  const cand = d.events[0].candidates[1];
  assert.equal(cand.killedBy, 'structure', 'the Live detail carries the killer');
  assert.deepEqual(cand.structViolations, ['built-in kitchen island: is missing from the result'],
    'with the structural objection verbatim');
});

test('the pipeline stamps killedBy at every post-judge gate', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../pipeline/transform.js', import.meta.url), 'utf8');
  // One stamp since the teardown (2 Sep 2026): structure, realism, and the
  // design-score REJECTION were model gates and are gone — the one judge's
  // verdict needs no stamp (its violations ARE the record), and the design
  // score only chooses now, never kills. Watermark remains the sole
  // post-judge gate, and it is arithmetic.
  assert.match(src, /aWm\.killedBy = 'watermark'/);
  assert.ok(!/killedBy = 'structure'/.test(src), 'the structural gate is gone');
  assert.ok(!/killedBy = 'realism'/.test(src), 'the realism gate is gone');
  assert.ok(!/killedBy = 'design-score'/.test(src), 'the design score no longer rejects');
});
