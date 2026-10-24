-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — A COURSE OF TREATMENT IS NOT ONE APPOINTMENT.
--
-- THE BUG. uniq_active_patient_doctor is UNIQUE (clinic_id, patient_id,
-- doctor_id) WHERE status='booked' — one active booking per patient per
-- doctor, full stop. tools/bookAppointment.js resolves the collision with
-- ON CONFLICT ... DO UPDATE SET appointment_time. So when a patient books a
-- SECOND appointment with the SAME doctor, the first one is silently MOVED to
-- the new time. The caller is told both dates are held. The database holds
-- one, and it is the later one, with reminder_sent and confirmed reset.
--
-- WHY IT MATTERS NOW. Skin Essence is an aesthetic clinic: a laser course is
-- six sittings with the same dermatologist, and a chemical-peel series is
-- three. Booking sitting 2 would erase sitting 1. It is not aesthetic-only —
-- any clinic with returning patients hits this the moment two future
-- appointments exist, which is why it is being fixed for the whole fleet.
--
-- THE FIX. Scope the uniqueness to the DAY. Same patient, same doctor, same
-- day stays idempotent (the mid-call "actually make it 4pm" correction still
-- moves the row, which is the behaviour that path was built for). A different
-- day becomes a genuinely new row.
--
-- WHY A LITERAL TIME ZONE. An index expression cannot reach clinics.timezone
-- with a subquery. Under silo — one deploy and one database per clinic —
-- Asia/Kolkata is a constant, the same reasoning applied in 29c3b9f. The
-- literal is duplicated exactly once, in tools/bookAppointment.js's ON CONFLICT
-- target, and tests/test-multi-visit-driven.js asserts the two agree: if they
-- ever diverge, Postgres cannot infer the index and every booking fails loudly
-- rather than quietly writing to the wrong day.
--
-- timezone(text, timestamptz) is IMMUTABLE (verified: provolatile='i' on
-- PostgreSQL 18.6), so the expression is indexable.
--
-- SAFE TO AUTO-RUN. No CONCURRENTLY here, unlike 005 — the appointments table
-- is small and a plain CREATE INDEX takes a brief lock. That is what lets this
-- file go through `node db/migrate.js` at prestart instead of needing the
-- hand-run dance that 005 documents.
--
-- NO PRE-FLIGHT CHECK IS NEEDED. The new index is strictly WEAKER than the one
-- it replaces: any data satisfying "at most one booked row per (clinic,
-- patient, doctor)" trivially satisfies "at most one per (clinic, patient,
-- doctor, day)". Existing rows cannot violate it.
--
-- uniq_doctor_slot IS DELIBERATELY UNTOUCHED. It enforces one scheduled
-- patient per doctor per slot, which is exactly the capacity the clinic
-- launches at. Per-slot capacity above 1 (Skin Essence asked for 2, and 1 on
-- Mondays) needs a counting trigger that this index would contradict — that
-- arrives with the capacity work, not here. Nothing in this file changes how
-- many patients can hold a slot.
-- ═══════════════════════════════════════════════════════════════════════════

-- Create the replacement BEFORE dropping the incumbent, so there is no window
-- in which neither is enforcing anything. (Both statements are in one
-- transaction anyway — db/migrate.js wraps each file — but the order is the
-- part that would matter if that ever changed.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_patient_doctor_day
  ON appointments (clinic_id, patient_id, doctor_id,
                   ((appointment_time AT TIME ZONE 'Asia/Kolkata')::date))
  WHERE status = 'booked';

DROP INDEX IF EXISTS uniq_active_patient_doctor;
