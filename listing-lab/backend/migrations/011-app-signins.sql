-- Google sign-in from the iPhone app (10 Sep 2026). The app shows Google's
-- own sign-in page in a sheet; when Google sends the person back, the server
-- cannot hand the app a session cookie the way it does the website, so it
-- hands over a one-time code instead. The app swaps the code for a session
-- within five minutes, proving it is the same app that started the sign-in
-- (the `challenge` is the hash of a secret only that app holds). Each row is
-- deleted the moment it is used. Mirrored in schema.sql.
CREATE TABLE IF NOT EXISTS app_signins (
  -- The hash of the code, never the code itself — as with sessions.
  code_hash  TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_signins_expiry ON app_signins (expires_at);
