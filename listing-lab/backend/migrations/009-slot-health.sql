-- Applied to live D1 on 2 Sep 2026 (the poisoned-slots defense). Dispatch
-- probes each container slot before handing a job over; two consecutive
-- failed probes quarantine the slot for 10 minutes. Mirrored in schema.sql.
CREATE TABLE IF NOT EXISTS slot_health (
  slot          TEXT PRIMARY KEY,
  consec_fails  INTEGER NOT NULL DEFAULT 0,
  quarantined   INTEGER NOT NULL DEFAULT 0,
  last_ok_at    TEXT,
  last_fail_at  TEXT,
  last_fail_why TEXT
);
