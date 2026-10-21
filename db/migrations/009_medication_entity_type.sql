-- ═══════════════════════════════════════════════════════════════════════════
-- 009 — AN ALLERGY IS NOT A PRESCRIPTION
--
-- VERIFIED BY EXECUTION, 2026-08-10:
--
--     findAllDrugMentions("मुझे penicillin से allergy hai")  ->  ["Penicillin"]
--     Ritu: "आप Penicillin ले रहे हैं — मैंने सही सुना ना?"
--           ("You are TAKING Penicillin — did I hear that right?")
--
-- The patient answers "हाँ" truthfully — she asked whether she heard the NAME
-- right — and it persisted as a drug they take. Before this migration there was
-- no column that could have held the truth: `grep -rin allerg db/migrations`
-- returned ZERO across 001-008. 007 calls `canonical` "the only field that
-- should ever be treated as clinical" and indexes it as "this patient's current
-- medications", so the pre-visit view told a doctor the patient TOLERATES a
-- beta-lactam. A stopped-drug row makes a doctor ask a question; that one made
-- them stop asking.
--
-- The capture path was fixed first (callHandler ALLERGY_RE, clause-scoped) so an
-- allergen is no longer recorded AT ALL. That converted a confidently wrong row
-- into a missing one — the right direction, but it throws away a clinically
-- important fact the patient volunteered. This column is what lets us keep it.
--
-- readback.js:1263 has carried the copy the whole time, already translated —
-- `आपको ${v} से एलर्जी है — सही?` — and readbackLine already dispatches on
-- entityType. Only callHandler's hard-coded type:'meds' stood between them.
-- Speaking that line before this column existed would have been WORSE than
-- silence: the patient confirms "yes, I'm allergic" and it still lands as a
-- medication.
--
-- DEFAULT 'medication' SO EVERY EXISTING ROW KEEPS ITS MEANING. The five rows
-- live today (four Paracetamol, one Cetirizine) are genuine medications. One
-- sixth row read `unverified | dentist` — the dentist-as-a-drug bug written into
-- a real patient record before a3cf0ec landed — and was deleted by hand on
-- 2026-08-10.
--
-- WHY THE PRIOR MUST FILTER ON THIS. db.js getPatientMedications feeds
-- confirmed molecules back as a matcher prior at PRIOR_MAX_DIST 0.50, twice the
-- general bar, under a comment reading "the worst case is echoing back a
-- molecule they really do take". An allergen in that prior makes the matcher
-- MORE likely to hear the very drug the patient cannot have.
--
-- NO @no-transaction DIRECTIVE, AND NO CONCURRENTLY — both were wrong here, and
-- the combination crash-looped production on 2026-08-10 12:32.
--
-- db/migrate.js:66 sends the WHOLE FILE as a single client.query(sql). Postgres
-- runs a multi-statement simple query inside an IMPLICIT transaction, so
-- CREATE INDEX CONCURRENTLY raises 25001 whether or not the runner adds its own
-- BEGIN/COMMIT. The @no-transaction directive skips the EXPLICIT transaction and
-- cannot escape the implicit one. CONCURRENTLY simply cannot work through this
-- runner as written.
--
-- patient_medications holds six rows. A plain CREATE INDEX takes a brief lock
-- that is, at this size, unmeasurable — and it runs inside the transaction the
-- rest of the file wants anyway, so the migration is atomic again.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE patient_medications
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'medication';

-- A CHECK rather than an enum: adding a value to an enum is its own migration
-- and a clinic on an older deploy must never fail to write a row it understands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patient_medications_entity_type_ck'
  ) THEN
    ALTER TABLE patient_medications
      ADD CONSTRAINT patient_medications_entity_type_ck
      CHECK (entity_type IN ('medication', 'allergy'));
  END IF;
END $$;

-- The prior reads WHERE entity_type = 'medication'; without this it degrades to
-- a filter on a full scan of every row this phone ever produced.
CREATE INDEX IF NOT EXISTS idx_patient_medications_entity
  ON patient_medications (clinic_id, phone, entity_type);
