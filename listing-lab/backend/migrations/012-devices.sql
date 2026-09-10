-- Push notifications for the iPhone app (10 Sep 2026): the phones that want
-- to hear when a photo finishes. One row per Apple device token; a phone that
-- signs into another account moves with it. `environment` says which of
-- Apple's two push services the token belongs to (an Xcode build talks to
-- the sandbox one). Deleted with the account. Mirrored in schema.sql.
CREATE TABLE IF NOT EXISTS devices (
  token       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at  TEXT NOT NULL,
  seen_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_account ON devices (account_id);
