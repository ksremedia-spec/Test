-- Applied to live D1 on 1 Sep 2026 (heartbeat) and 31 Aug 2026 (checkpoints)
-- directly from schema.sql; recorded here so migrations/ matches the live
-- database (audit, 3 Sep 2026). On a database that already has these, the
-- ALTER fails harmlessly ("duplicate column") — run the CREATE alone.

-- The container's pulse: stamped every 45s while a job runs; no pulse for
-- 3 minutes means provably lost and the sweep restarts the job.
ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT;

-- Ledger balance checkpoints so a long history is not re-summed on every read.
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  through_at TEXT NOT NULL,
  balance    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, through_at)
);
