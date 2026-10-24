-- ═══════════════════════════════════════════════════════════════════════════
-- 010 — A NAME THE DESK CAN READ
--
-- The receptionist desk lists callers by patients.name, which is whatever
-- script the caller spoke in. A row reading "ದೀಕ್ಷಿತ" or "পৃথ্বী" is unreadable
-- to staff who do not read that script, and a clinic's front desk is exactly
-- where several scripts meet: the 2026-08-15 list showed Kannada, Bengali and
-- Latin names stacked on top of each other.
--
-- WHY A COLUMN AND NOT A DISPLAY-TIME FUNCTION. The romanizer lives in the
-- server (devanagari.js) and the desk is a separate Next.js app. Computing it
-- in the desk would be a SIXTH copy of a rule that already exists in more than
-- one place — four sentinel lists, three patient resolvers, two phone
-- normalisers, two name parsers, three transliterators — and every previous
-- copy has cost a production defect. The server romanizes once, on write; the
-- desk reads a column.
--
-- THE ORIGINAL IS NEVER REPLACED. `name` keeps exactly what the caller said,
-- in their script. That is the patient's actual name and the doctor may need
-- it; name_latin is a reading aid, not a correction. Losing the original to
-- make a list tidier would be a worse bug than the one being fixed.
--
-- NULLABLE, AND STAYS NULLABLE. A Latin-script name romanizes to itself and
-- needs no second copy; a name we could not romanize should read as absent
-- rather than as a guess. The desk renders `name_latin ?? name`, so a null
-- degrades to today's behaviour instead of to a blank row.
--
-- NO @no-transaction AND NO CONCURRENTLY. Migration 009 crash-looped
-- production on 2026-08-10 with exactly that pairing: db/migrate.js sends the
-- whole file as one query and Postgres wraps a multi-statement simple query in
-- an implicit transaction, so CONCURRENTLY raises 25001 whichever directives
-- are present. This file is a plain ALTER plus an index on a table holding
-- fewer than a hundred rows — the lock is unmeasurable and the migration stays
-- atomic.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS name_latin TEXT;

-- The desk sorts and searches on the readable form; without this it degrades to
-- a sequential scan on every list render.
CREATE INDEX IF NOT EXISTS idx_patients_name_latin
  ON patients (clinic_id, name_latin);
