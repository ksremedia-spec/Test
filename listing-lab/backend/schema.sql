-- Listing Lab — database schema (Cloudflare D1 / SQLite)
--
-- Two rules this file exists to enforce, both of which cost money if they leak
-- into application code instead:
--   1. A ledger key may appear ONCE. The in-memory check in ledger.js cannot stop
--      two simultaneous webhook deliveries — both read "not present", both write.
--      The UNIQUE constraint below is the referee.
--   2. Every column that gets looked up has an index. Without one SQLite reads
--      every row to find one.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- accounts

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  company       TEXT,
  -- NULL for accounts created through an OAuth handoff rather than a password.
  password_hash TEXT,
  created_at    TEXT NOT NULL,
  -- Set when Stripe first sees this account, so a customer is not recreated.
  stripe_customer_id TEXT,
  -- 1 = the owner's own account (founder testing). Everything still works for
  -- these accounts, but the owner's dashboard leaves their jobs, credits and
  -- spend out of every statistic — the pass rate the business quotes must be
  -- measured on customers, not on the owner stress-testing his own pipeline.
  -- Mirrored in migrations/007-internal-accounts.sql.
  internal      INTEGER NOT NULL DEFAULT 0,
  -- Apple's stable user id (`sub`) for accounts created with Sign in with
  -- Apple from the iOS app. Looked up BEFORE email, because the email Apple
  -- hands over may be a private-relay address. NULL for everyone else.
  -- Mirrored in migrations/010-apple-sub.sql.
  apple_sub     TEXT
);

-- Sign-in looks up by email, and two accounts must never share one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_stripe_customer
  ON accounts (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
-- One Apple identity, one account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_apple_sub
  ON accounts (apple_sub) WHERE apple_sub IS NOT NULL;

-- ---------------------------------------------------------------- sessions

CREATE TABLE IF NOT EXISTS sessions (
  -- The hash of the cookie value, never the value itself. A leaked database
  -- backup must not hand someone a working session.
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry  ON sessions (expires_at);

-- ------------------------------------------------------- listings and photos

CREATE TABLE IF NOT EXISTS listings (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_account ON listings (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- R2 object key of the ORIGINAL. Never overwritten, ever — a transformation
  -- always writes a new object and leaves this one alone.
  original_key TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  -- What kind of photograph this is, decided once at upload by a cheap vision
  -- call. Drives which transformations the app offers, so an empty room is never
  -- offered "declutter" and stamped with a disclosure for work never done.
  scene        TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_listing ON photos (listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_photos_account ON photos (account_id);

-- -------------------------------------------------------------------- jobs

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  photo_id       TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  transformation TEXT NOT NULL CHECK (transformation IN ('declutter','empty','twilight','staging')),
  -- Closed vocabulary only. The customer's free-text note is parsed into these
  -- before it gets here; their raw words never reach the image model.
  style          TEXT,
  room_type      TEXT,
  options_json   TEXT,
  status         TEXT NOT NULL CHECK (status IN ('queued','running','delivered','rejected','failed'))
                 DEFAULT 'queued',
  attempts_used  INTEGER NOT NULL DEFAULT 0,
  attempts_allowed INTEGER NOT NULL DEFAULT 3,
  -- R2 key of the delivered, watermarked result. NULL until something passes.
  result_key     TEXT,
  -- Runner-up versions that ALSO passed every check (staging ships up to two
  -- extras as "Version 2"/"Version 3"). JSON array of R2 keys; NULL = one
  -- version. Mirrored by migrations/003-variants.sql for existing databases.
  variant_keys   TEXT,
  -- Why it was rejected, in the customer's language.
  rejection_note TEXT,
  -- Real AI spend for this job in dollars, from the container's audit meter.
  -- Recorded for rejections too (burn with nothing to show is still burn).
  -- NULL = finished before migrations/005-job-cost.sql. See boardMetrics.
  cost_usd       REAL,
  created_at     TEXT NOT NULL,
  finished_at    TEXT,
  -- ------------------------------------------------- waiting out an outage
  -- Google's image model returns 500 "gemini-3-pro-image is currently
  -- experiencing high demand" from a shared inference pool. It is not our quota
  -- and no paid tier buys past it — it hits everyone at once, and on 26 Aug 2026
  -- it hit for over an hour. Telling an agent "that one did not finish" because
  -- Google was busy is the product failing at the one thing it promises. So a
  -- job that dies on an outage is not finished: it stays 'queued', with the time
  -- to try again, and a scheduled sweep picks it back up.
  --
  -- 'queued' rather than a new status word, deliberately. A job waiting to be
  -- dispatched is queued, which is both true and already in the CHECK above —
  -- and changing a CHECK constraint in SQLite means rebuilding a live table.
  retry_after    TEXT,
  outage_retries INTEGER NOT NULL DEFAULT 0,
  -- What a REJECTED job produced. Deliberately not `result_key`: that one means
  -- "delivered, downloadable, paid for", and a rejected frame is none of those.
  -- Kept so the work can be reviewed and the checks themselves can be graded —
  -- without it, a rejection is a sentence with no evidence behind it.
  reject_key     TEXT,
  -- When the job was last handed to a container. Staleness is measured from
  -- HERE and not from created_at: a job that was revived two minutes ago is not
  -- stale just because it was started twenty minutes ago, and measuring from
  -- creation makes the reaper revive the same job on every single sweep.
  last_dispatch_at TEXT,
  -- The container's pulse (1 Sep 2026). Containers used to speak only at the
  -- END of a run, so a lost job was indistinguishable from a working one for
  -- 12 minutes — a customer watched 17 minutes for a 4-minute staging. Now a
  -- running container stamps this every 45 seconds; no pulse for 3 minutes
  -- means provably lost, and the sweep restarts the job. Cleared on every
  -- dispatch so a job handed to an older, pulse-less container falls back to
  -- the patient 12-minute rule instead of being stolen mid-run.
  heartbeat_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_retry ON jobs (retry_after) WHERE retry_after IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_photo   ON jobs (photo_id);
-- The queue worker asks for unfinished jobs constantly; give it an index.
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs (status) WHERE status IN ('queued','running');

-- Every generation attempt, kept whether it passed or failed. This is the audit
-- trail behind the compliance claim — if a result is ever challenged, the record
-- of what was checked and what it said is here.
CREATE TABLE IF NOT EXISTS job_attempts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('delivered','rejected','error')),
  raw_key      TEXT,
  audit_json   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (job_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts (job_id, attempt_no);

-- ------------------------------------------------------------------ grading

-- Kyle's own verdict on a job, recorded independently of the system's.
--
-- The whole value of a golden set is in the DISAGREEMENT. Where he passes and we
-- rejected, our strictness is costing him money. Where he fails and we
-- delivered, we shipped something he would never send a client — the dangerous
-- direction. Neither is visible without both verdicts stored side by side.
--
-- `verdict` is a closed set on purpose. 'wrong_job' separates a bad
-- classification (we ran declutter on a room that needed staging) from a bad
-- result (right job, poor execution) — two different failures with two different
-- fixes, which a single pass/fail button would blur together.
CREATE TABLE IF NOT EXISTS grades (
  job_id     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN ('pass','fail','wrong_job')),
  note       TEXT,
  graded_at  TEXT NOT NULL
);

-- ------------------------------------------------------------------ ledger

-- Append-only. Nothing in the application is permitted to UPDATE or DELETE a row
-- here; a correction is a new ADJUSTMENT entry, so the history stays readable.
CREATE TABLE IF NOT EXISTS ledger_entries (
  -- The idempotency key. PRIMARY KEY is the whole point of this table: a second
  -- INSERT with the same key fails at the database, whatever the application
  -- believed. This is what makes a duplicate Stripe delivery harmless even when
  -- two of them arrive at the same instant.
  key         TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('purchase','promo','debit','credit_return','adjustment')),
  delta       INTEGER NOT NULL,
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  transformation TEXT,
  pack_id     TEXT,
  stripe_object_id TEXT,
  code        TEXT,
  reason      TEXT,
  actor       TEXT,
  at          TEXT NOT NULL
);

-- The balance is SUM(delta) for an account, so this index is the balance query.
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries (account_id, at);
-- "has this job already been charged / returned?" — asked on every job.
CREATE INDEX IF NOT EXISTS idx_ledger_job ON ledger_entries (job_id) WHERE job_id IS NOT NULL;

-- A job may be charged at most once and have its credits returned at most once.
-- Belt and braces alongside the checks in ledger.js — same reasoning as the
-- PRIMARY KEY above, because the application check cannot see a concurrent write.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_one_debit_per_job
  ON ledger_entries (job_id) WHERE type = 'debit' AND job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_one_return_per_job
  ON ledger_entries (job_id) WHERE type = 'credit_return' AND job_id IS NOT NULL;

-- Checkpoint rows so a long-lived account does not sum its whole history on every
-- page load. Not needed at launch volume; cheaper to allow for now than to
-- retrofit. `balance` is the total of every entry up to and including `through_at`.
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  through_at TEXT NOT NULL,
  balance    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, through_at)
);

-- --------------------------------------------------------- stripe webhooks

-- Every accepted webhook, recorded before any work happens. Two jobs: it is the
-- receipt that lets us answer Stripe in milliseconds and process afterwards, and
-- it is a second line of defence against replays.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id   TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_unprocessed
  ON stripe_events (received_at) WHERE processed_at IS NULL;
-- Owner service switches (and any future flags). One row per flag; absent row
-- means "not paused". Written only from the owner's dashboard, read on the two
-- customer paths that spend money: buying credits and starting a job.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Promo codes (28 Aug 2026, for the Monday beta): a code grants credits, at
-- most max_uses times across all accounts, at most once per account (that part
-- is enforced by the ledger's idempotency key, promo:CODE:account). `uses` is
-- claimed atomically — two agents racing for the last use of a code cannot
-- both win. Mirrored in schema.sql for fresh databases.
CREATE TABLE IF NOT EXISTS promo_codes (
  code       TEXT PRIMARY KEY,           -- stored uppercase
  credits    INTEGER NOT NULL CHECK (credits > 0),
  max_uses   INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses       INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
-- Customer problem reports (28 Aug 2026). A quiet "something wrong?" link on a
-- delivered photo files one of these; the owner reads them next to the job's
-- own audit trail and decides, per case, what a fair answer is. One report per
-- job per account — a second submission is answered kindly, not stored twice.
-- Mirrored in schema.sql.
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open','resolved')) DEFAULT 'open',
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_once ON reports (job_id, account_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);

-- Slot health (2 Sep 2026, the poisoned-slots incident): one row per pipeline
-- pool slot, written by the dispatch-time health probe. consec_fails drives
-- the quarantine; the board reads it so a sick slot is visible immediately.
CREATE TABLE IF NOT EXISTS slot_health (
  slot          TEXT PRIMARY KEY,
  consec_fails  INTEGER NOT NULL DEFAULT 0,
  quarantined   INTEGER NOT NULL DEFAULT 0,
  last_ok_at    TEXT,
  last_fail_at  TEXT,
  last_fail_why TEXT
);
