-- Real per-job AI spend, in dollars (28 Aug 2026). The container's audit has
-- always measured exactly what each job cost Google; this puts that number on
-- the job row so the owner's dashboard can sum truth instead of estimating
-- credits × $0.45. Recorded for rejected jobs too — money spent producing
-- nothing is precisely the burn the owner needs to see. NULL = a job finished
-- before this column existed. Mirrored in schema.sql.
ALTER TABLE jobs ADD COLUMN cost_usd REAL;
