-- Sign in with Apple (the iOS app, 9 Sep 2026). Apple identifies a person by
-- a stable `sub` claim, not by email — the email it hands over may be a
-- private-relay address the person can turn off later. So an Apple account is
-- found by this column first and by email never. NULL for every account that
-- was not created through Apple. Unique so two accounts can never claim one
-- Apple identity. Mirrored in schema.sql.
ALTER TABLE accounts ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_apple_sub
  ON accounts (apple_sub) WHERE apple_sub IS NOT NULL;
