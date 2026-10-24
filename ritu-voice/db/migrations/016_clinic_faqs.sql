-- ═══════════════════════════════════════════════════════════════════════════
-- 016 — THE ANSWERS THE CLINIC WROTE ITSELF.
--
-- Section E3 of the setup form is the highest-value table in it: whatever the
-- clinic types there is what Ritu says, word for word. The form invites more
-- over time — what to bring on a first visit, when reports are ready, whether a
-- female attendant is available, waiting time, EMI, directions from the station.
--
-- SKIN ESSENCE SEEDS EXACTLY ONE ROW: parking. Its other two E3 answers are
-- already carried by structures that render them live, and duplicating them
-- here would be the same-fact-in-two-places defect with the worse copy winning:
--   · "the doctor is available 10:30 to 8" is a STATIC string that contradicts
--     the 14:00–16:00 lunch break, Dr. Jigisha's 19:00 finish, Sundays and the
--     three holidays. doctor_schedules answers it correctly and per-doctor.
--   · "consultation ₹700, follow-up free within 5 days then ₹400" is
--     doctors.fee_inr plus migration 015's columns, rendered by the code-built
--     fee block.
-- Parking is the one with no structured twin, and that is the test for what
-- belongs here.
--
-- The answer is spoken VERBATIM — the prompt block carries the same "only from
-- this list" rule as treatments and the roster, which is the mechanism behind
-- the 0-invented-doctors record.
--
-- An empty table renders no block at all, so a clinic that adds none is
-- byte-identical to one without this migration.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clinic_faqs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  question   TEXT NOT NULL CHECK (length(trim(question)) > 0),
  answer     TEXT NOT NULL CHECK (length(trim(answer))   > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The same duplicate guard treatments carries: two rows answering the same
-- question differently is a coin flip the caller never sees being tossed.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_faq_question_per_clinic
  ON clinic_faqs (clinic_id, LOWER(question)) WHERE active;
