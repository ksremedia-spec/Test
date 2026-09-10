/**
 * Listing Lab — data access over Cloudflare D1.
 *
 * Every query lives here so the route handlers stay readable and so there is one
 * place to look when asking "what touches the ledger?".
 *
 * The important thing this file does NOT do is trust itself. `ledger.js` checks
 * the business rules and `schema.sql` enforces them again at the database. When
 * an INSERT trips a constraint we translate it into the same error the
 * application layer would have raised, so a concurrent duplicate and a sequential
 * one look identical to the caller.
 */

import { Ledger, LedgerError, ENTRY_TYPES } from './ledger.js';

/** SQLite reports a tripped UNIQUE/PRIMARY KEY constraint in the message. */
const isUniqueViolation = err => /UNIQUE constraint failed|SQLITE_CONSTRAINT_PRIMARYKEY|constraint failed: ledger_entries/i.test(String(err?.message || err));

/**
 * ONE RETRY ON A D1 HICCUP (soak re-test, 3 Sep 2026). An upload answered
 * 500 with "D1_ERROR: D1 DB storage operation exceeded timeout which caused
 * object to be reset" — D1's own transient, gone a moment later. Every query
 * the Store runs gets one second try, 150ms later, on that class of error
 * only. A retried INSERT that had in fact committed fails its UNIQUE key,
 * which is the same 500 the customer would have seen anyway — never a
 * duplicate row. Every other error is thrown straight through.
 */
const D1_TRANSIENT = /exceeded timeout|caused object to be reset|D1_ERROR: (Network|internal error)|overloaded/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function retryingD1(db) {
  if (!db || typeof db.prepare !== 'function' || db.__retrying) return db;
  const once = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (!D1_TRANSIENT.test(String(e?.message || e))) throw e;
      console.warn('d1 transient, retrying once:', String(e?.message || e).slice(0, 120));
      await sleep(150);
      return fn();
    }
  };
  const wrap = (stmt) => ({
    __stmt: stmt,
    bind: (...args) => wrap(stmt.bind(...args)),
    first: (...a) => once(() => stmt.first(...a)),
    all: (...a) => once(() => stmt.all(...a)),
    run: (...a) => once(() => stmt.run(...a)),
    raw: (...a) => once(() => stmt.raw(...a)),
  });
  const out = {
    __retrying: true,
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: (stmts) => once(() => db.batch(stmts.map(s => s.__stmt || s))),
  };
  if (typeof db.exec === 'function') out.exec = (...a) => once(() => db.exec(...a));
  return out;
}

export class Store {
  constructor(db) { this.db = retryingD1(db); }

  /* ------------------------------------------------------------- accounts */

  async accountByEmail(email) {
    return this.db.prepare('SELECT * FROM accounts WHERE lower(email) = ?').bind(email).first();
  }

  async accountById(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
  }

  /** Sign in with Apple looks an account up by Apple's stable id, never by email. */
  async accountByAppleSub(sub) {
    return this.db.prepare('SELECT * FROM accounts WHERE apple_sub = ?').bind(sub).first();
  }

  async createAccount({ id, email, name, company, passwordHash, appleSub, at }) {
    try {
      await this.db.prepare(
        'INSERT INTO accounts (id, email, name, company, password_hash, apple_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, email, name ?? null, company ?? null, passwordHash ?? null, appleSub ?? null, at).run();
    } catch (err) {
      if (isUniqueViolation(err)) throw new LedgerError('EMAIL_TAKEN', 'That email already has an account.');
      throw err;
    }
    return this.accountById(id);
  }

  /**
   * DELETE AN ACCOUNT (the iOS app's "Delete my account", 9 Sep 2026 — Apple
   * requires in-app deletion). Different from eraseAccountData above, which
   * is the owner's tool and keeps an anonymised row for the ledger: this is
   * the customer's own request and the whole row goes. schema.sql's
   * ON DELETE CASCADE takes sessions, listings, photos, jobs, attempts,
   * grades, reports, ledger entries and checkpoints with it. The caller has
   * already deleted the R2 objects — see deleteAccountRoute in worker.js.
   */
  async deleteAccount(accountId) {
    await this.db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run();
  }

  /** Sign an account out everywhere: every session, not only the caller's. */
  async deleteSessionsForAccount(accountId) {
    await this.db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(accountId).run();
  }

  /* ------------------------------------------------------------- sessions */

  async putSession(record) {
    await this.db.prepare(
      'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(record.token_hash, record.account_id, record.created_at, record.expires_at).run();
  }

  async sessionByHash(tokenHash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  }

  async deleteSession(tokenHash) {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }

  /** Housekeeping. Cheap, and stops the table growing without limit. */
  async purgeExpiredSessions(nowISO) {
    await this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowISO).run();
  }

  /* ---------------------------------------------- the iPhone app's sign-in codes */

  /**
   * Google sign-in from the iPhone app (10 Sep 2026): the code Google's
   * callback hands the app, stored hashed, with the challenge the app sent
   * when it started. See googleExchange in worker.js.
   */
  async putAppSignin(record) {
    await this.db.prepare(
      'INSERT INTO app_signins (code_hash, account_id, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(record.code_hash, record.account_id, record.challenge, record.created_at, record.expires_at).run();
  }

  /**
   * Take a code out of the table and return it — one statement, so a code
   * can only ever be used once, whatever the outcome of the checks that follow.
   */
  async takeAppSignin(codeHash) {
    return this.db.prepare('DELETE FROM app_signins WHERE code_hash = ? RETURNING *').bind(codeHash).first();
  }

  /** Codes live five minutes; sweep the ones nobody used. */
  async purgeExpiredAppSignins(nowISO) {
    await this.db.prepare('DELETE FROM app_signins WHERE expires_at <= ?').bind(nowISO).run();
  }

  /* --------------------------------------------------------------- ledger */

  /**
   * Load an account's ledger.
   *
   * Reads from the most recent checkpoint forward rather than from the beginning
   * of time, so an account with years of history costs the same as a new one.
   */
  async ledgerFor(accountId) {
    const cp = await this.db.prepare(
      'SELECT through_at, balance FROM ledger_checkpoints WHERE account_id = ? ORDER BY through_at DESC LIMIT 1'
    ).bind(accountId).first();

    const rows = cp
      ? (await this.db.prepare('SELECT * FROM ledger_entries WHERE account_id = ? AND at > ? ORDER BY at')
          .bind(accountId, cp.through_at).all()).results
      : (await this.db.prepare('SELECT * FROM ledger_entries WHERE account_id = ? ORDER BY at')
          .bind(accountId).all()).results;

    const entries = (rows || []).map(rowToEntry);
    if (cp) {
      // A synthetic opening entry carrying the checkpoint balance. It is never
      // written back — it exists only so `balance` still means "sum of entries".
      entries.unshift({
        key: `checkpoint:${accountId}:${cp.through_at}`,
        type: ENTRY_TYPES.ADJUSTMENT,
        delta: cp.balance,
        reason: 'balance brought forward',
        jobId: null,
        at: cp.through_at,
        checkpoint: true,
      });
    }
    return Ledger.from(entries);
  }

  async balanceFor(accountId) {
    return (await this.ledgerFor(accountId)).balance;
  }

  /**
   * Write one ledger entry.
   *
   * The caller has already run it through `Ledger` for the business rules; this
   * is where the database gets the last word. A UNIQUE violation here means
   * another request won the race, which is not an error — it is the duplicate
   * protection working. Report it as "already applied" rather than a failure.
   */
  async appendEntry(accountId, entry) {
    try {
      await this.db.prepare(
        `INSERT INTO ledger_entries
           (key, account_id, type, delta, job_id, transformation, pack_id, stripe_object_id, code, reason, actor, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        entry.key, accountId, entry.type, entry.delta,
        entry.jobId ?? null, entry.transformation ?? null, entry.packId ?? null,
        entry.stripeObjectId ?? null, entry.code ?? null, entry.reason ?? null,
        entry.actor ?? null, entry.at
      ).run();
      return { applied: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { applied: false, reason: 'already applied' };
      throw err;
    }
  }

  /**
   * Write a job DEBIT, but only if the account can actually afford it — decided
   * by the database in one statement, so two simultaneous transforms can never
   * both pass a stale in-memory balance check and drive the account negative
   * (security review, 31 Aug 2026).
   *
   * The balance is computed exactly the way `ledgerFor` computes it — the latest
   * checkpoint's carried-forward balance plus every entry written after it — but
   * here it lives inside the INSERT's WHERE, so the read and the write are one
   * atomic operation the DB serialises. `INSERT … SELECT … WHERE <balance> >=
   * cost` inserts one row when affordable, zero rows when not, and still throws
   * a UNIQUE violation if this exact debit key was already written (idempotent).
   *
   * Returns {applied:true} | {applied:false, insufficient:true} |
   * {applied:false, duplicate:true}.
   */
  async debitForJobIfAffordable(accountId, entry, cost) {
    const cpBalance =
      `COALESCE((SELECT balance FROM ledger_checkpoints WHERE account_id = ? ORDER BY through_at DESC LIMIT 1), 0)`;
    const sinceCp =
      `COALESCE((SELECT SUM(delta) FROM ledger_entries WHERE account_id = ? AND at > ` +
      `COALESCE((SELECT through_at FROM ledger_checkpoints WHERE account_id = ? ORDER BY through_at DESC LIMIT 1), '')), 0)`;
    try {
      const res = await this.db.prepare(
        `INSERT INTO ledger_entries
           (key, account_id, type, delta, job_id, transformation, pack_id, stripe_object_id, code, reason, actor, at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (${cpBalance} + ${sinceCp}) >= ?`
      ).bind(
        entry.key, accountId, entry.type, entry.delta,
        entry.jobId ?? null, entry.transformation ?? null, entry.packId ?? null,
        entry.stripeObjectId ?? null, entry.code ?? null, entry.reason ?? null,
        entry.actor ?? null, entry.at,
        accountId, accountId, accountId, cost
      ).run();
      const changed = res?.meta?.changes ?? 0;
      return changed > 0 ? { applied: true } : { applied: false, insufficient: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { applied: false, duplicate: true };
      throw err;
    }
  }

  async deleteJob(id) {
    await this.db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
  }

  /* ------------------------------------------------------------ promo codes */

  async createPromoCode({ code, credits, maxUses = 1, note = null, expiresAt = null, at }) {
    await this.db.prepare(
      'INSERT INTO promo_codes (code, credits, max_uses, uses, note, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
    ).bind(code, credits, maxUses, note, expiresAt, at).run();
  }

  async promoCodeByCode(code) {
    return this.db.prepare('SELECT * FROM promo_codes WHERE code = ?').bind(code).first();
  }

  async listPromoCodes() {
    return (await this.db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all()).results || [];
  }

  /**
   * Who redeemed what. The ledger already knows — every promo grant carries its
   * code and its account — so even an anonymous code names its redeemer here.
   * This is what lets Kyle hand out FIRST5-A..E and still see exactly which
   * agent used which one.
   */
  async promoRedemptions() {
    const rows = (await this.db.prepare(
      `SELECT le.code, le.at, a.email, a.name
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE le.type = 'promo' ORDER BY le.at DESC`
    ).all()).results || [];
    const byCode = {};
    for (const r of rows) (byCode[r.code] = byCode[r.code] || []).push({ email: r.email, name: r.name, at: r.at });
    return byCode;
  }

  /**
   * Claim one use of a code, atomically. Two agents racing for the last use of
   * a one-time code cannot both win: the WHERE clause is the referee, exactly
   * like the ledger's UNIQUE key.
   */
  async claimPromoUse(code, now) {
    const res = await this.db.prepare(
      `UPDATE promo_codes SET uses = uses + 1
        WHERE code = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)`
    ).bind(code, now).run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Has this exact ledger key been written before? (per-account redemption check) */
  async ledgerKeyExists(key) {
    return !!(await this.db.prepare('SELECT 1 AS x FROM ledger_entries WHERE key = ?').bind(key).first());
  }

  /* -------------------------------------------------------------- reports */

  async createReport({ id, jobId, accountId, message, at }) {
    try {
      await this.db.prepare(
        "INSERT INTO reports (id, job_id, account_id, message, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)"
      ).bind(id, jobId, accountId, message, at).run();
      return { created: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { created: false };   // already reported — that's fine
      throw err;
    }
  }

  async listReports() {
    return (await this.db.prepare(
      `SELECT r.*, a.email, a.name AS account_name, j.transformation, j.status AS job_status,
              j.rejection_note, j.cost_usd, j.created_at AS job_created_at
         FROM reports r
         JOIN accounts a ON a.id = r.account_id
         JOIN jobs j ON j.id = r.job_id
        ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT 200`
    ).all()).results || [];
  }

  async resolveReport(id, at) {
    const res = await this.db.prepare(
      "UPDATE reports SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'"
    ).bind(at, id).run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /* ------------------------------------------------- listings and photos */

  async createListing({ id, accountId, address, at }) {
    await this.db.prepare(
      'INSERT INTO listings (id, account_id, address, created_at) VALUES (?, ?, ?, ?)'
    ).bind(id, accountId, address, at).run();
    return id;
  }

  /** The catch-all listing so an agent can upload without inventing one first. */
  async inboxListing(accountId) {
    return this.db.prepare(
      "SELECT * FROM listings WHERE account_id = ? AND address = 'Uploads' LIMIT 1"
    ).bind(accountId).first();
  }

  async createPhoto({ id, listingId, accountId, originalKey, at }) {
    await this.db.prepare(
      'INSERT INTO photos (id, listing_id, account_id, original_key, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, listingId, accountId, originalKey, at).run();
    return this.photoById(id);
  }

  async setPhotoScene(id, scene) {
    await this.db.prepare('UPDATE photos SET scene = ? WHERE id = ?').bind(scene, id).run();
  }

  async photoById(id) {
    return this.db.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
  }

  /* ----------------------------------------------------------------- jobs */

  async createJob({ id, accountId, photoId, transformation, style, roomType, options, attemptsAllowed, at }) {
    await this.db.prepare(
      `INSERT INTO jobs (id, account_id, photo_id, transformation, style, room_type, options_json,
                         status, attempts_used, attempts_allowed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`
    ).bind(id, accountId, photoId, transformation, style ?? null, roomType ?? null,
           options ? JSON.stringify(options) : null, attemptsAllowed, at).run();
    return this.jobById(id);
  }

  async jobById(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  }

  /**
   * Everything this account has run, newest first.
   *
   * Joined to `photos` so the caller gets the ORIGINAL's key alongside the
   * result's. A list of finished work is useless without something to look at,
   * and a job row on its own has only a photo_id in it.
   */
  async jobsForAccount(accountId, limit = 50) {
    const { results } = await this.db.prepare(
      `SELECT j.*, p.original_key
         FROM jobs j
         LEFT JOIN photos p ON p.id = j.photo_id
        WHERE j.account_id = ?
        ORDER BY j.created_at DESC
        LIMIT ?`
    ).bind(accountId, limit).all();
    return results || [];
  }

  /**
   * Claim one attempt.
   *
   * The increment and the ceiling are one statement on purpose. Reading
   * attempts_used, comparing it, then writing it back would let two concurrent
   * regenerate requests both read 2, both decide there is room, and both spend
   * the third attempt — running up a Google bill on a credit that allowed three.
   * `WHERE attempts_used < attempts_allowed` makes the database arbitrate: exactly
   * one UPDATE reports a row changed.
   */
  async claimAttempt(jobId) {
    const res = await this.db.prepare(
      `UPDATE jobs SET attempts_used = attempts_used + 1, status = 'running'
       WHERE id = ? AND attempts_used < attempts_allowed`
    ).bind(jobId).run();
    const changed = res?.meta?.changes ?? res?.changes ?? 0;
    if (!changed) throw new LedgerError('ATTEMPTS_EXHAUSTED', 'All attempts for this credit have been used.');
    return this.jobById(jobId);
  }

  async recordAttempt({ id, jobId, attemptNo, outcome, rawKey, audit, at }) {
    await this.db.prepare(
      `INSERT INTO job_attempts (id, job_id, attempt_no, outcome, raw_key, audit_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, jobId, attemptNo, outcome, rawKey ?? null, audit ? JSON.stringify(audit) : null, at).run();
  }

  /**
   * Record what the pipeline actually spent, once it reports back.
   * Capped at attempts_allowed so a miscounting container cannot make a job look
   * like it used more than a credit buys.
   */
  async setAttemptsUsed(jobId, used) {
    await this.db.prepare(
      'UPDATE jobs SET attempts_used = MIN(?, attempts_allowed) WHERE id = ?'
    ).bind(used, jobId).run();
  }

  /**
   * Park a job to be tried again, instead of finishing it.
   *
   * Used for one thing only: the upstream image model refusing work. The job is
   * NOT finished, the credit is NOT returned, and nothing about the result is
   * written — because there is going to be a result, just not yet.
   *
   * `status = 'queued'` puts it back where it started, which is what it is: work
   * waiting to be dispatched. `finished_at` stays NULL so the callback guard in
   * pipelineResult still treats a late report from the dead attempt as stale.
   */
  async parkJobForRetry({ jobId, retryAfter, attemptCostUsd }) {
    // `retry_after IS NULL` makes this idempotent. A container can report the
    // same dead attempt twice — a retried callback, two instances racing — and
    // without it each report would burn another slot out of the retry budget and
    // push the next attempt further away.
    //
    // A parked attempt still SPENT money: the container ran classify/critic/
    // compliance and often an image generation before the upstream 500. That
    // spend is added to the job's running cost_usd here, so the budget meter
    // sees the real Google bill during an outage instead of zero. The idempotent
    // guard means a duplicate park never double-adds. (Reliability review, 31
    // Aug 2026.)
    const cost = (typeof attemptCostUsd === 'number' && isFinite(attemptCostUsd)) ? attemptCostUsd : null;
    const res = await this.db.prepare(
      `UPDATE jobs SET status = 'queued', retry_after = ?, outage_retries = outage_retries + 1,
         cost_usd = CASE WHEN ? IS NOT NULL THEN COALESCE(cost_usd, 0) + ? ELSE cost_usd END
       WHERE id = ? AND finished_at IS NULL AND retry_after IS NULL`
    ).bind(retryAfter, cost, cost, jobId).run();
    const changed = res?.meta?.changes ?? res?.changes ?? 0;
    return { parked: changed > 0, job: await this.jobById(jobId) };
  }

  /**
   * Claim jobs whose retry time has come.
   *
   * Claim, not list. The sweep runs every minute and a slow dispatch must not let
   * the next sweep pick the same job up again, so the UPDATE that marks a job
   * taken is the same statement that decides it was available — the database
   * arbitrates, exactly as it does for claimAttempt. `retry_after` is cleared by
   * the claim, so a job is only ever in the sweep's sights once per parking.
   */
  async claimJobsDueForRetry(nowIso, limit = 10) {
    const { results } = await this.db.prepare(
      `SELECT * FROM jobs
        WHERE finished_at IS NULL AND retry_after IS NOT NULL AND retry_after <= ?
        ORDER BY retry_after LIMIT ?`
    ).bind(nowIso, limit).all();
    const claimed = [];
    for (const job of results || []) {
      const res = await this.db.prepare(
        `UPDATE jobs SET retry_after = NULL, status = 'running'
          WHERE id = ? AND retry_after IS NOT NULL AND finished_at IS NULL`
      ).bind(job.id).run();
      const changed = res?.meta?.changes ?? res?.changes ?? 0;
      if (changed) claimed.push(job);
    }
    return claimed;
  }

  /**
   * Every unfinished job older than the cutoff — heartbeating, parked, queued,
   * silent, whatever. The 15-minute rule's third and final path (soak test,
   * 3 Sep 2026): a stuffed-closet declutter heartbeated through two 10-minute
   * container kills and showed "working" for 21 minutes, because the silent-job
   * path never saw it (it was not silent) and the queue path only saw it for
   * the seconds between park and re-dispatch. The wait cutoff is a promise
   * about the customer's clock, so it has to be checked against the customer's
   * clock alone.
   */
  async jobsPastGiveUp(createdBeforeIso, limit = 20) {
    const { results } = await this.db.prepare(
      `SELECT * FROM jobs
        WHERE finished_at IS NULL AND created_at <= ?
        ORDER BY created_at LIMIT ?`
    ).bind(createdBeforeIso, limit).all();
    return results || [];
  }

  /**
   * Jobs that have gone quiet.
   *
   * Everything in this system reports back: the pipeline on success, on
   * rejection, on outage, and even on its own hard kill. A job that has said
   * nothing at all for this long did not fail — it VANISHED, and the usual
   * reason is that the container instance running it went away underneath it. A
   * deploy does exactly that: new image rolls out, instances cycle, and whatever
   * was mid-render dies without a word.
   *
   * Seen on 26 Aug 2026: job_4b91edc5 sat at 'queued' for twenty minutes with
   * the credit spent and nothing to show the customer. Which is the worst
   * outcome available — worse than a failure, because a failure at least ends.
   *
   * `staleBefore` is a timestamp: anything unfinished and untouched since then
   * is a candidate. `retry_after IS NULL` keeps this out of the way of jobs that
   * are deliberately waiting on an outage.
   */
  /**
   * noFirstBeatBefore (9 Sep 2026): every container image in service pulses
   * the moment a run starts, so a job with NO pulse at all is not "an older
   * image being quiet" any more — it is a hand-off that never took. Measured
   * from the dispatch stamp when there is one, else from creation (a hand-off
   * that hung before it could be stamped). Callers that pass nothing keep
   * the old patient window.
   */
  async claimStalledJobs(staleBefore, hbStaleBefore = null, limit = 10, noFirstBeatBefore = null) {
    // Two tiers of "silent" (1 Sep 2026, tightened 9 Sep). A job whose
    // container has a pulse (heartbeat_at set) is provably lost after a few
    // missed beats — hbStaleBefore applies. A job with NO pulse never started:
    // noFirstBeatBefore applies (or the patient staleBefore when not given).
    const { results } = await this.db.prepare(
      `SELECT * FROM jobs
        WHERE finished_at IS NULL AND retry_after IS NULL
          AND ( (heartbeat_at IS NOT NULL AND heartbeat_at <= ?)
             OR (heartbeat_at IS NULL AND COALESCE(last_dispatch_at, created_at) <= ?) )
        ORDER BY created_at LIMIT ?`
    ).bind(hbStaleBefore || staleBefore, noFirstBeatBefore || staleBefore, limit).all();
    return results || [];
  }

  /** The container's pulse while a run is in flight. Finished jobs stay quiet. */
  /**
   * SLOT HEALTH (2 Sep 2026, the poisoned-slots incident). One row per pool
   * slot, written by the dispatch-time health probe. `consec_fails` drives the
   * quarantine; a success wipes it. The board reads this table so a sick slot
   * is VISIBLE, not deduced from an autopsy.
   */
  async recordSlotProbe(slot, ok, why, quarantineAfter) {
    await this.db.prepare(
      `INSERT INTO slot_health (slot, consec_fails, last_ok_at, last_fail_at, last_fail_why, quarantined)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         consec_fails = CASE WHEN ?2 = 0 THEN 0 ELSE slot_health.consec_fails + 1 END,
         last_ok_at   = CASE WHEN ?2 = 0 THEN ?3 ELSE slot_health.last_ok_at END,
         last_fail_at = CASE WHEN ?2 = 0 THEN slot_health.last_fail_at ELSE ?4 END,
         last_fail_why= CASE WHEN ?2 = 0 THEN slot_health.last_fail_why ELSE ?5 END,
         quarantined  = CASE WHEN ?2 = 0 THEN 0
                             WHEN slot_health.consec_fails + 1 >= ?7 THEN 1
                             ELSE slot_health.quarantined END`
    ).bind(slot, ok ? 0 : 1, ok ? new Date().toISOString() : null,
           ok ? null : new Date().toISOString(), why, 0, quarantineAfter).run();
  }

  /** Slots currently under quarantine (recent enough failures). */
  async quarantinedSlots(cooldownMinutes) {
    const cutoff = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
    const { results } = await this.db.prepare(
      `SELECT slot FROM slot_health WHERE quarantined = 1 AND last_fail_at > ?`
    ).bind(cutoff).all();
    return new Set((results || []).map(r => r.slot));
  }

  async slotHealth() {
    const { results } = await this.db.prepare(
      `SELECT slot, consec_fails, quarantined, last_ok_at, last_fail_at, last_fail_why FROM slot_health ORDER BY slot`
    ).all();
    return results || [];
  }

  async recordHeartbeat(jobId, at) {
    await this.db.prepare(
      'UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND finished_at IS NULL'
    ).bind(at, jobId).run();
  }

  /**
   * Stamp the moment a job was handed to a container, and mark it running.
   *
   * The status half was missing and nothing noticed, because until there was a
   * queue screen nobody ever LOOKED at a job's status while it ran — the single
   * job page had its own progress bar. `claimAttempt` sets 'running' and is dead
   * code; nothing on the normal path ever moved a job off 'queued', so a job sat
   * at "Waiting to start" for three minutes and then jumped straight to
   * delivered. Accurate in the database, a lie on the screen.
   *
   * Safe for the reaper and the retry queue: both select on `finished_at` and
   * `retry_after`, not on status, and parking a job correctly sets it back to
   * 'queued' — which is what it then is.
   */
  async markDispatched(jobId, at) {
    // heartbeat_at resets on every dispatch: a stale pulse from a previous
    // run must never make a job freshly handed to a pulse-less container look
    // "provably lost" three minutes into honest work.
    await this.db.prepare(
      "UPDATE jobs SET last_dispatch_at = ?, heartbeat_at = NULL, status = 'running' WHERE id = ? AND finished_at IS NULL"
    ).bind(at, jobId).run();
  }

  async finishJob({ jobId, status, resultKey, rejectKey, rejectionNote, variantKeys, costUsd, at }) {
    // `AND finished_at IS NULL` makes finishing atomic: two callbacks racing to
    // finish the same job (a retried container callback, or a late real result
    // arriving just as the reaper gives up) — only the first writes. Without it
    // the second could overwrite the result AND double-add to cost_usd.
    //
    // cost_usd ACCUMULATES across attempts rather than overwriting. A job that
    // outaged and retried spent real Google money on every attempt; the old
    // code kept only the last attempt's figure, so the budget meter undercounted
    // exactly when spend spiked. Each attempt's spend is added as it is recorded
    // (here, and in parkJobForRetry). A null cost (pre-meter, or an attempt that
    // reported none) leaves the running total untouched. (Security/reliability
    // review, 31 Aug 2026.)
    const cost = (typeof costUsd === 'number' && isFinite(costUsd)) ? costUsd : null;
    const res = await this.db.prepare(
      `UPDATE jobs SET status = ?, result_key = ?, reject_key = ?, rejection_note = ?, variant_keys = ?,
         cost_usd = CASE WHEN ? IS NOT NULL THEN COALESCE(cost_usd, 0) + ? ELSE cost_usd END,
         finished_at = ?
       WHERE id = ? AND finished_at IS NULL`
    ).bind(status, resultKey ?? null, rejectKey ?? null, rejectionNote ?? null,
      variantKeys?.length ? JSON.stringify(variantKeys) : null,
      cost, cost, at, jobId).run();
    const changed = (res?.meta?.changes ?? res?.changes ?? 0) > 0;
    return { job: await this.jobById(jobId), changed };
  }

  /**
   * ERASE A CUSTOMER'S PHOTOGRAPHS (the privacy policy's promise, built
   * 3 Sep 2026). Removes every photo, job, attempt, grade, report and session
   * for the account and anonymises the account row. The credit ledger and
   * Stripe events stay — the policy names purchase records as the exception —
   * and they still reconcile because they reference the (now anonymous)
   * account id. The caller deletes the R2 objects; this is the database half.
   * Returns the R2 keys the account owned so the caller can delete them.
   */
  async eraseAccountData(accountId, at) {
    const photos = await this.db.prepare('SELECT id, original_key FROM photos WHERE account_id = ?').bind(accountId).all();
    const jobs = await this.db.prepare('SELECT id, result_key, reject_key, variant_keys FROM jobs WHERE account_id = ?').bind(accountId).all();
    const keys = new Set();
    for (const p of photos.results || []) if (p.original_key) keys.add(p.original_key);
    for (const j of jobs.results || []) {
      if (j.result_key) { keys.add(j.result_key); keys.add(j.result_key.replace(/\.jpg$/, '-clean.jpg')); }
      if (j.reject_key) keys.add(j.reject_key);
      try { for (const k of JSON.parse(j.variant_keys || '[]')) keys.add(k); } catch {}
    }
    const jobIds = (jobs.results || []).map(j => j.id);
    const stmts = [];
    if (jobIds.length) {
      const marks = jobIds.map(() => '?').join(',');
      stmts.push(this.db.prepare(`DELETE FROM grades WHERE job_id IN (${marks})`).bind(...jobIds));
      stmts.push(this.db.prepare(`DELETE FROM job_attempts WHERE job_id IN (${marks})`).bind(...jobIds));
      stmts.push(this.db.prepare(`DELETE FROM reports WHERE job_id IN (${marks})`).bind(...jobIds));
    }
    stmts.push(this.db.prepare('DELETE FROM jobs WHERE account_id = ?').bind(accountId));
    stmts.push(this.db.prepare('DELETE FROM photos WHERE account_id = ?').bind(accountId));
    stmts.push(this.db.prepare('DELETE FROM listings WHERE account_id = ?').bind(accountId));
    stmts.push(this.db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(accountId));
    stmts.push(this.db.prepare(
      "UPDATE accounts SET email = ?, name = NULL, company = NULL, password_hash = '$erased$' WHERE id = ?"
    ).bind(`erased+${accountId}@deleted.invalid`, accountId));
    await this.db.batch(stmts);
    return { keys: [...keys], photos: (photos.results || []).length, jobs: jobIds.length, erasedAt: at };
  }

  /* -------------------------------------------------------------- grading */

  /** Kyle's verdict. Re-grading the same job replaces the old answer. */
  async saveGrade({ jobId, verdict, note, at }) {
    await this.db.prepare(
      `INSERT INTO grades (job_id, verdict, note, graded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, graded_at = excluded.graded_at`
    ).bind(jobId, verdict, note ?? null, at).run();
  }

  /**
   * Everything gradeable, with his verdict where he has given one.
   *
   * Rejections are included deliberately — they are half the point. A set of only
   * the jobs that passed measures nothing except how often we agree with
   * ourselves.
   */
  async gradingQueue(limit = 300, since = null) {
    const { results } = await this.db.prepare(
      `SELECT j.id, j.transformation, j.style, j.room_type, j.status, j.rejection_note,
              j.result_key, j.reject_key, j.created_at, p.original_key,
              g.verdict, g.note AS grade_note
         FROM jobs j
         LEFT JOIN photos p ON p.id = j.photo_id
         LEFT JOIN grades g ON g.job_id = j.id
        WHERE j.status IN ('delivered','rejected')
          AND (j.result_key IS NOT NULL OR j.reject_key IS NOT NULL)
          AND (?2 IS NULL OR j.created_at >= ?2)
        ORDER BY j.created_at
        LIMIT ?1`
    ).bind(limit, since).all();
    return results || [];
  }

  /* ------------------------------------------------------- stripe events */

  /**
   * Record a delivery before doing anything with it.
   * This is what lets the webhook answer Stripe in milliseconds: write the
   * receipt, return 200, grant the credits afterwards.
   * Returns false if we have seen this event id before.
   */
  async recordStripeEvent({ eventId, eventType, objectId, payload, at }) {
    try {
      await this.db.prepare(
        'INSERT INTO stripe_events (event_id, event_type, object_id, payload, received_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(eventId, eventType, objectId, payload, at).run();
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async markStripeEventProcessed(eventId, at, error = null) {
    await this.db.prepare(
      'UPDATE stripe_events SET processed_at = ?, error = ? WHERE event_id = ?'
    ).bind(at, error, eventId).run();
  }

  /* ------------------------------------------------------ owner switches */

  /** Read one flag; absent means false. Values are stored as '1' / '0'. */
  async getFlag(key) {
    const row = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return row ? row.value === '1' : false;
  }

  async setFlag(key, on, at) {
    await this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, on ? '1' : '0', at || new Date().toISOString()).run();
  }

  /** String-valued settings (the budget watcher's numbers live here). */
  async getSetting(key) {
    const row = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return row ? row.value : null;
  }

  async setSetting(key, value, at) {
    await this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, String(value), at || new Date().toISOString()).run();
  }

  /* --------------------------------------------------- owner's dashboard */

  /** Recent deliveries to real customers, with the keys the board needs to
   *  show original beside result. Internal (founder) accounts excluded, same
   *  as every other board number. */
  async deliveredForBoard(limit = 60) {
    const r = await this.db.prepare(
      `SELECT j.id, j.transformation, j.style, j.room_type, j.finished_at,
              j.result_key, j.variant_keys, p.original_key, a.email
         FROM jobs j
         JOIN photos p ON p.id = j.photo_id
         JOIN accounts a ON a.id = j.account_id
        WHERE j.status = 'delivered' AND a.internal = 0
        ORDER BY j.finished_at DESC LIMIT ?`
    ).bind(limit).all();
    return r.results || [];
  }


  /**
   * Every number the dashboard shows, in one round trip of queries. Weeks are
   * ISO date strings (Monday) for the last `weeks` weeks, oldest first.
   */
  async boardMetrics({ weeks = 12, now = new Date() } = {}) {
    const weekMs = 7 * 86_400_000;
    const day = now.getUTCDay();
    const monday = new Date(now.getTime() - ((day + 6) % 7) * 86_400_000);
    monday.setUTCHours(0, 0, 0, 0);
    const starts = Array.from({ length: weeks }, (_, i) => new Date(monday.getTime() - (weeks - 1 - i) * weekMs));
    const since = starts[0].toISOString();

    // The owner's own flagged accounts (accounts.internal = 1) are left out of
    // EVERY number on the board. The pass rate here is the one the business
    // quotes, and founder stress-tests would poison it — see migration 007.
    const notInternal = col =>
      `${col} NOT IN (SELECT id FROM accounts WHERE internal = 1)`;
    const [jobs, ledger, accounts, failures, audit] = await Promise.all([
      this.db.prepare(
        `SELECT transformation, status, created_at FROM jobs
          WHERE created_at >= ? AND ${notInternal('account_id')}`
      ).bind(since).all().then(r => r.results || []),
      this.db.prepare(
        `SELECT type, delta, pack_id, at FROM ledger_entries
          WHERE at >= ? AND ${notInternal('account_id')}`
      ).bind(since).all().then(r => r.results || []),
      this.db.prepare(
        `SELECT a.email,
                COUNT(j.id) AS tx,
                MAX(j.created_at) AS last,
                (SELECT COALESCE(SUM(delta),0) FROM ledger_entries le WHERE le.account_id = a.id AND le.type IN ('purchase','promo')) AS credits
           FROM accounts a LEFT JOIN jobs j ON j.account_id = a.id
          WHERE a.internal = 0
          GROUP BY a.id ORDER BY tx DESC LIMIT 6`
      ).all().then(r => r.results || []),
      this.db.prepare(
        `SELECT j.created_at, j.transformation, j.rejection_note, l.address
           FROM jobs j
           LEFT JOIN photos p ON p.id = j.photo_id
           LEFT JOIN listings l ON l.id = p.listing_id
          WHERE j.status IN ('rejected','failed') AND ${notInternal('j.account_id')}
          ORDER BY j.created_at DESC LIMIT 5`
      ).all().then(r => r.results || []),
      this.db.prepare(
        `SELECT j.created_at, j.transformation, j.style, j.room_type, j.status, j.attempts_used, l.address,
                (SELECT -MIN(delta) FROM ledger_entries le WHERE le.job_id = j.id AND le.type = 'debit') AS debit,
                (SELECT COUNT(*) FROM ledger_entries le2 WHERE le2.job_id = j.id AND le2.type = 'credit_return') AS refunded
           FROM jobs j
           LEFT JOIN photos p ON p.id = j.photo_id
           LEFT JOIN listings l ON l.id = p.listing_id
          WHERE ${notInternal('j.account_id')}
          ORDER BY j.created_at DESC LIMIT 6`
      ).all().then(r => r.results || []),
    ]);

    const weekOf = iso => {
      const t = new Date(iso).getTime();
      let idx = Math.floor((t - starts[0].getTime()) / weekMs);
      return idx < 0 ? 0 : idx >= weeks ? weeks - 1 : idx;
    };
    const zero = () => new Array(weeks).fill(0);
    const perT = { declutter: zero(), staging: zero(), twilight: zero(), empty: zero() };
    let delivered = 0, rejected = 0;
    for (const j of jobs) {
      if (perT[j.transformation]) perT[j.transformation][weekOf(j.created_at)]++;
      if (j.status === 'delivered') delivered++;
      else if (j.status === 'rejected' || j.status === 'failed') rejected++;
    }
    const revenueByWeek = zero();
    let creditsSold = 0, creditsUsed = 0, revenueCents = 0;
    for (const e of ledger) {
      if (e.type === 'purchase') {
        creditsSold += e.delta;
        const cents = PACK_PRICE_CENTS[e.pack_id] ?? 0;
        revenueCents += cents;
        revenueByWeek[weekOf(e.at)] += cents / 100;
      } else if (e.type === 'promo') creditsSold += e.delta;
      else if (e.type === 'debit') creditsUsed += -e.delta;
    }
    const finished = delivered + rejected;
    // Real AI spend: summed from the per-job meter (jobs.cost_usd, written from
    // the container's audit on every finish since 28 Aug 2026). Jobs older than
    // the column report how many credits they burned, so the caller can cover
    // just that remainder with the measured-average estimate.
    const costRow = await this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS real_cost,
              COUNT(CASE WHEN cost_usd IS NULL AND status IN ('delivered','rejected','failed') THEN 1 END) AS unmetered
         FROM jobs WHERE ${notInternal('account_id')}`
    ).first();
    return {
      weeks: starts.map(d => d.toISOString().slice(0, 10)),
      perTransformation: perT,
      delivered, rejected,
      passRate: finished ? +(100 * delivered / finished).toFixed(1) : null,
      creditsSold, creditsUsed,
      revenueCents,
      revenueByWeek: revenueByWeek.map(v => +v.toFixed(2)),
      realCostUsd: +(costRow?.real_cost ?? 0),
      unmeteredJobs: costRow?.unmetered ?? 0,
      customers: accounts,
      failures, audit,
    };
  }
}

/** Pack prices for revenue math, kept next to the query that needs them. */
const PACK_PRICE_CENTS = { pack_10: 1999, pack_30: 5699, pack_75: 13799 };

function rowToEntry(r) {
  return {
    key: r.key,
    type: r.type,
    delta: r.delta,
    jobId: r.job_id,
    transformation: r.transformation,
    packId: r.pack_id,
    stripeObjectId: r.stripe_object_id,
    code: r.code,
    reason: r.reason,
    actor: r.actor,
    at: r.at,
  };
}
