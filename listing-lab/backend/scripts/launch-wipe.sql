-- Listing Lab — launch-day test-data wipe. RUN ONCE, ON LAUNCH DAY, AFTER KYLE
-- SAYS GO. Removes every test account and everything hanging off it (jobs,
-- photos, ledger entries, sessions, reports all cascade via foreign keys), so
-- the dashboard starts counting real money from zero.
--
--   npx wrangler d1 execute listinglab --remote --file scripts/launch-wipe.sql -y
--
-- What counts as test data: the golden-run accounts (goldenrun+*@ksremedia.com)
-- and any obvious internal test signups. Kyle's own real account (if he wants
-- to keep it) is NOT matched by these patterns — check the SELECT below first.
--
-- Rehearsed locally against the real schema on 28 Aug 2026 (scripts/ rehearsal
-- notes in LAUNCH.md). R2 photo objects for wiped accounts are orphaned, not
-- deleted — they are pennies of storage and deleting R2 by prefix is a separate
-- manual step if ever wanted.

-- 1. LOOK BEFORE LEAPING — run this alone first and eyeball the list:
-- SELECT id, email, created_at FROM accounts
--  WHERE email LIKE 'goldenrun+%@ksremedia.com' OR email LIKE '%@example.com';

-- 2. The wipe (FKs cascade to sessions, photos, jobs, ledger, reports):
DELETE FROM accounts
 WHERE email LIKE 'goldenrun+%@ksremedia.com'
    OR email LIKE '%@example.com';

-- 3. Test promo codes minted during development:
DELETE FROM promo_codes WHERE code LIKE 'LL-%' AND note = 'pipeline test';

-- 4. Stripe TEST-mode webhook receipts (live mode gets a fresh ledger):
DELETE FROM stripe_events;

-- 5. Verify the store is empty of test traffic:
-- SELECT (SELECT COUNT(*) FROM accounts)  AS accounts,
--        (SELECT COUNT(*) FROM jobs)      AS jobs,
--        (SELECT COUNT(*) FROM ledger_entries) AS ledger,
--        (SELECT COUNT(*) FROM reports)   AS reports;
