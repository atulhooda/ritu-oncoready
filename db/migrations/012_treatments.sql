-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — TREATMENTS, BECAUSE A PRICE IS AS DANGEROUS TO INVENT AS A DOCTOR
--
-- An aesthetic / dermatology clinic takes a different call from a GP clinic.
-- Nobody rings to say what hurts; they ring to ask what laser hair removal
-- costs, how many sittings it takes, and whether there is downtime. Today Ritu
-- has no concept of a treatment at all — only doctors and their consultation
-- fee — so every one of those questions is either refused or, worse, answered
-- from the model's imagination.
--
-- WHY THIS TABLE LOOKS LIKE `doctors`, ON PURPOSE.
-- The roster is a solved problem: a table, rendered to prompt text, under one
-- rule — "SIRF inhi mein se doctor bol; list ke bahar koi doctor/naam/time
-- KABHI mat bana" — and the measured result is zero invented doctors across
-- 137 production calls. A quoted price has exactly the same failure mode and
-- exactly the same blast radius: a caller told ₹15,000 for a course who is
-- charged ₹40,000 at the desk is a lost customer and a complaint, and the
-- clinic will blame the receptionist that said it. So treatments are carried
-- by the same mechanism rather than a new one, and inherit the same guarantee.
--
-- PRICE IS A RANGE, NOT A NUMBER. Aesthetic pricing genuinely varies by area,
-- skin type and session count, and a clinic that cannot express "₹3,000-6,000
-- per session depending on area" will either be forced to quote a single wrong
-- number or leave the field empty. Both are worse than the truth. price_max
-- NULL means a flat price; both NULL means "the clinic will confirm", which
-- Ritu must say rather than guess.
--
-- NOTHING HERE IS MEDICAL ADVICE. `notes` is for logistics a receptionist
-- would legitimately repeat — "avoid sun 48h before", "not during pregnancy" —
-- never for suitability. Ritu books and informs; she does not advise, and the
-- medical-advice guard still refuses "will this work for my skin".
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS treatments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,

  name          TEXT NOT NULL,              -- "Laser hair removal — full face"
  category      TEXT,                       -- "Laser", "Injectables", "Peels"

  -- Money. Both NULL = "clinic will confirm" — an honest answer Ritu can give.
  price_min     INTEGER,                    -- rupees, per session unless price_unit says otherwise
  price_max     INTEGER,                    -- NULL = flat price
  price_unit    TEXT DEFAULT 'session',     -- 'session' | 'course' | 'sitting'

  -- What a caller actually asks after the price.
  sessions_min  INTEGER,
  sessions_max  INTEGER,
  duration_min  INTEGER,                    -- minutes in the chair
  downtime      TEXT,                       -- "none", "2-3 days redness"

  notes         TEXT,                       -- logistics only — never suitability
  active        BOOLEAN NOT NULL DEFAULT TRUE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One clinic's treatments, in the order they will be spoken. Mirrors
-- idx_doctors-by-clinic; the roster read is the hot path and so is this one.
CREATE INDEX IF NOT EXISTS idx_treatments_clinic
  ON treatments (clinic_id, active, category, name);

-- A clinic cannot list the same treatment twice. Without this, a doctor filling
-- the form on two devices produces two rows and Ritu reads both aloud — the
-- same defect the roster would have had without its own uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_treatment_name_per_clinic
  ON treatments (clinic_id, LOWER(name)) WHERE active;
