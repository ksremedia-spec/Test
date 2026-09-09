-- Staging ships up to three passing versions (28 Aug 2026). The winner stays in
-- result_key exactly as before; the runners-up that also cleared every check
-- live here as a JSON array of R2 keys (e.g. ["acct/photo/job-result-v2.jpg"]).
-- NULL or '[]' means the job delivered a single version — every job before this
-- migration, and roughly half of staging jobs after it.
ALTER TABLE jobs ADD COLUMN variant_keys TEXT;
