-- Caller-confirmed medications.
--
-- WHY THIS EXISTS. Until now there was NO medication column anywhere in the
-- schema — not in 001-006, not in appointments.reason, nowhere. callHandler.js
-- pushed every confirmed drug into `this.confirmedMeds`, an in-memory array
-- that is grepped in exactly one place in the whole repo: the line that writes
-- it. Nothing ever read it. It died with the call object.
--
-- So the entire read-back layer — the matcher, the 116k brand index, the
-- Devanagari romanizer, the confirmation dialogue, every accuracy point we have
-- ever measured — was being multiplied by zero. This table is the difference
-- between a metric and a product.
--
-- WHAT IT IS FOR. The number that matters is not per-mention transcript recall
-- (whose arithmetic ceiling on our corpus is 69.2%, measured) but per-PATIENT:
-- does this patient's record hold at least one correct, caller-confirmed
-- molecule and zero wrong ones? That can exceed the acoustic ceiling because it
-- accumulates across visits and admits the WhatsApp prescription photo, which
-- no microphone bounds.
--
-- Additive only — no existing table is touched.
CREATE TABLE IF NOT EXISTS patient_medications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  patient_id UUID REFERENCES patients(id),
  phone TEXT,
  call_sid TEXT,

  -- The canonical molecule our lexicon resolved to. This is what a doctor
  -- reads, and it is the only field that should ever be treated as clinical.
  canonical TEXT NOT NULL,
  -- The brand head that matched, when the hit came via the brand index
  -- (Telma → Telmisartan). Kept because patients say brands: an Indian
  -- prescription audit found 57.4% of prescriptions use brand names, so the
  -- brand is often the only string the patient can actually repeat.
  brand TEXT,
  -- What the STT actually produced. NEVER show this to a doctor — it exists so
  -- a wrong record can be traced back to the string that caused it.
  heard_surface TEXT,

  -- HOW SURE ARE WE. These three carry the difference between "the patient
  -- named this drug and confirmed it" and "we guessed and they said haan":
  --   affirmed        caller confirmed a confident (<=0.34) match
  --   affirmed-weak   caller confirmed a WEAK guess — real evidence, weaker
  --   corrected       caller denied and named a different drug
  --   unverified      heard but never confirmed; flagged for doctor review
  resolution TEXT NOT NULL,
  match_score NUMERIC(4,3),
  via_brand BOOLEAN NOT NULL DEFAULT FALSE,

  -- Offset from call start, so the exact turn can be located in the Exotel
  -- recording. Without it a confirmed (audio -> drug) pair can never be tied
  -- back to its audio, and audio you did not point at is unrecoverable.
  turn_offset_ms INTEGER,
  language TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The read path a doctor and the next call both use: this patient's current
-- medications, newest first.
CREATE INDEX IF NOT EXISTS idx_patient_medications_patient
  ON patient_medications (patient_id, created_at DESC);
-- Returning callers are resolved by (clinic_id, phone) before a patient row is
-- guaranteed to exist, so that lookup needs its own index.
CREATE INDEX IF NOT EXISTS idx_patient_medications_phone
  ON patient_medications (clinic_id, phone, created_at DESC);
-- Feeds the clinic formulary: measured, a 200-item local drug list picks the
-- RIGHT molecule 56.1% of the time against the global 118k index's 47.4%, and
-- collapses the confusable set from a mean of 10.1 decoys to 3.41.
CREATE INDEX IF NOT EXISTS idx_patient_medications_canonical
  ON patient_medications (clinic_id, canonical);
