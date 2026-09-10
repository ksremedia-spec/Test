-- The lock-screen card for a job in progress (10 Sep 2026). While the app is
-- closed, the website flips the card to "Ready" with a push of its own kind,
-- addressed by a token the card issues for itself. One row per job, gone
-- once the job finishes. Mirrored in schema.sql.
CREATE TABLE IF NOT EXISTS activity_tokens (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at  TEXT NOT NULL
);
