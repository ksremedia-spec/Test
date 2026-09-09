-- Applied to the live database on 26 Aug 2026. New databases get these columns
-- from schema.sql directly; this file exists so an existing one can be brought
-- into line without rebuilding the jobs table.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS. Running this twice fails with
-- "duplicate column name", which is harmless and means it was already applied.
ALTER TABLE jobs ADD COLUMN retry_after    TEXT;
ALTER TABLE jobs ADD COLUMN outage_retries INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_jobs_retry ON jobs (retry_after) WHERE retry_after IS NOT NULL;
ALTER TABLE jobs ADD COLUMN last_dispatch_at TEXT;
ALTER TABLE jobs ADD COLUMN reject_key TEXT;
CREATE TABLE IF NOT EXISTS grades (
  job_id     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN ('pass','fail','wrong_job')),
  note       TEXT,
  graded_at  TEXT NOT NULL
);
