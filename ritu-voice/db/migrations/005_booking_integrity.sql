-- @no-transaction
--   Required: this file uses CREATE INDEX CONCURRENTLY, which Postgres refuses
--   inside a transaction block (25001). Every statement is IF [NOT] EXISTS, so a
--   partial application is completed by simply re-running.

-- ═══════════════════════════════════════════════════════════════════════════
-- 005 — Booking integrity: is_walk_in stamp + two partial UNIQUE indexes
--
-- Closes the S7 double-book gap: today idx_appointments_doctor is a plain
-- INDEX, availability.js never counts existing bookings, and the tool's
-- dedup SELECT→INSERT runs as separate autocommit statements — so two
-- different patients (or a caller racing staff on Ritu Desk) can land on the
-- same scheduled doctor+slot. The fix lives in the DB so it binds EVERY
-- writer of the appointments table, including Ritu Desk's Prisma (Desk code
-- changes are out of scope here — these indexes protect against its writes
-- at the DB layer with zero coordination code).
--
--   uniq_active_patient_doctor  — one active booking per patient per doctor
--                                 (today's JS dedup, made a guarantee)
--   uniq_doctor_slot            — no two SCHEDULED patients on one slot;
--                                 walk-in/token doctors exempt by predicate
--                                 (overlap is intended clinic behavior there)
--
-- ⚠ HAND-RUN ONLY — DO NOT apply via `node db/migrate.js`.
--   The runner wraps each file in BEGIN/COMMIT, and CREATE INDEX CONCURRENTLY
--   cannot run inside a transaction — each statement below must run
--   standalone in psql. Apply to the DEMO database first, soak with the new
--   bookAppointment.js, then hand-run on the hospital during LOW-TRAFFIC
--   hours. After applying by hand, record it so the runner skips this file:
--     INSERT INTO schema_migrations (version) VALUES ('005_booking_integrity');
--
-- Order of operations (each statement standalone, in this order):
--   1. ALTER TABLE — adds is_walk_in (instant on PG 11+; no table rewrite)
--   2. Backfill is_walk_in for walk-in doctors' existing rows
--   3. PRE-FLIGHT duplicate detection (queries below) — BOTH must return
--      0 rows; resolve any hits with clinic staff BEFORE step 4
--   4. The two CREATE UNIQUE INDEX CONCURRENTLY statements
--
-- If a CONCURRENTLY build fails midway it leaves an INVALID index behind.
-- Find it with:
--   SELECT c.relname FROM pg_class c
--     JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;
-- then DROP INDEX <name>; fix the duplicates it tripped on, and re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── PRE-FLIGHT: rows that would violate each index (run READ-ONLY first) ──
-- Run these BEFORE step 4 and resolve every hit (cancel / correct the extra
-- rows with staff). Both are written to work even before step 1's column
-- exists: walk-in is derived from doctor_schedules, exactly mirroring the
-- step-2 backfill.
--
-- Would-violate uniq_active_patient_doctor (same patient, same doctor, >1
-- active row — pick the row the patient actually wants, cancel the rest):
--
--   SELECT clinic_id, patient_id, doctor_id, count(*) AS dup_rows,
--          array_agg(id ORDER BY appointment_time) AS appointment_ids
--     FROM appointments
--    WHERE status = 'booked'
--    GROUP BY 1, 2, 3
--   HAVING count(*) > 1;
--
-- Would-violate uniq_doctor_slot (two scheduled patients on one slot;
-- walk-in doctors excluded — their overlap is intended):
--
--   SELECT a.doctor_id, a.appointment_time, count(*) AS dup_rows,
--          array_agg(a.id) AS appointment_ids
--     FROM appointments a
--    WHERE a.status = 'booked'
--      AND NOT EXISTS (SELECT 1 FROM doctor_schedules s
--                       WHERE s.doctor_id = a.doctor_id AND s.is_walk_in)
--    GROUP BY 1, 2
--   HAVING count(*) > 1;

-- ─── 1. Stamp the walk-in policy on the appointment row ────────────────────
-- Index predicates can only see the row's own columns, so the per-doctor
-- walk-in policy (doctor_schedules.is_walk_in) is stamped onto each booking.
-- New rows are stamped by bookAppointment.js from the matched availability
-- window; existing rows are backfilled below.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS is_walk_in BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── 2. Backfill existing rows for walk-in doctors ─────────────────────────
-- Conservative: a doctor with ANY walk-in schedule window gets all existing
-- rows stamped TRUE (exempt from uniq_doctor_slot), so legitimate historical
-- walk-in overlaps can never fail the index build or a later status change
-- back to 'booked'. New rows are stamped precisely per matched window by the
-- tool. All statuses backfilled, not just 'booked' — a Desk resurrection of
-- an old walk-in row must not trip the slot index.
UPDATE appointments a
   SET is_walk_in = TRUE
 WHERE EXISTS (SELECT 1 FROM doctor_schedules s
                WHERE s.doctor_id = a.doctor_id AND s.is_walk_in);

-- ─── 3. Invariant A — one active appointment per patient per doctor ────────
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_active_patient_doctor
  ON appointments (clinic_id, patient_id, doctor_id)
  WHERE status = 'booked';

-- ─── 4. Invariant B — THE double-book fix (scheduled doctors only) ─────────
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_doctor_slot
  ON appointments (doctor_id, appointment_time)
  WHERE status = 'booked' AND NOT is_walk_in;
