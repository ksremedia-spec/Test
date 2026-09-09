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
