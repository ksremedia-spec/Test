-- Owner service switches (and any future flags). One row per flag; absent row
-- means "not paused". Written only from the owner's dashboard, read on the two
-- customer paths that spend money: buying credits and starting a job.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
