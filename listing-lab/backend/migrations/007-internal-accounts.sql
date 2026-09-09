-- Internal accounts (30 Aug 2026). The owner's dashboard percentages — pass
-- rate above all — are what the business will quote, so they must be measured
-- on customers only. The owner's own accounts carry ~75 founder test jobs
-- (kept deliberately at the test-data wipe), and those were skewing every
-- number on the board.
--
-- Nothing is deleted: the accounts keep their history and credits and work
-- exactly as before. They are only flagged, and boardMetrics() skips flagged
-- accounts in every statistic. Future founder testing stays excluded
-- automatically. Mirrored in schema.sql.
ALTER TABLE accounts ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;

UPDATE accounts SET internal = 1
 WHERE lower(email) IN ('kyle@horizonhomemedia.com', 'horizonhomemedia508@gmail.com');
