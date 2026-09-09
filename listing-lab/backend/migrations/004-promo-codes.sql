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
