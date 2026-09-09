-- Listing Lab — founder-account history zero. Run 29 Aug 2026 on Kyle's
-- explicit "yes please", immediately after the launch wipe.
--
-- NOT RUN — Kyle declined 29 Aug ("not a big deal"); kept for reference only.
--
-- Goal: Kyle's two real accounts start launch with ONLY the real purchase.
--   kyle@horizonhomemedia.com  — dev account: +100 adjustment, 75 test jobs,
--                                debits/returns. All test. → balance 0, 0 jobs.
--   horizonhomemedia508@gmail.com — keeps ONLY today's live purchase (+10,
--                                cs_live_...). The Aug 28 TEST-mode fixture
--                                purchase (+75, cs_test_...) is removed.
--
-- Verified before writing: all 75 remaining jobs belong to the dev account
-- (newest 28 Aug, none after the live purchase); ledger_checkpoints is empty,
-- so balances are pure sums of ledger_entries.

-- 1. Dev account: every ledger row is test history.
DELETE FROM ledger_entries
 WHERE account_id = (SELECT id FROM accounts WHERE email = 'kyle@horizonhomemedia.com');

-- 2. Google account: drop only the TEST-mode purchase; the live one stays.
DELETE FROM ledger_entries
 WHERE key LIKE 'checkout.session.completed:cs_test%';

-- 3. All remaining listings/photos/jobs are dev-test runs (cascade cleans
--    photos, job_attempts, grades; ledger job_id refs already deleted above).
DELETE FROM listings;
DELETE FROM jobs;

-- 4. Verify (run separately):
-- SELECT a.email, COALESCE(SUM(le.delta),0) AS balance
--   FROM accounts a LEFT JOIN ledger_entries le ON le.account_id=a.id
--  GROUP BY a.email;
-- SELECT COUNT(*) FROM jobs;
