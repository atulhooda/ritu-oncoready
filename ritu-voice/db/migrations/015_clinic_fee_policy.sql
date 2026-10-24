-- ═══════════════════════════════════════════════════════════════════════════
-- 015 — THE TWO FACTS A RECEPTIONIST IS ASKED FOR ALL DAY.
--
-- "How much is it?" and "which doctor will I see?" are the commonest questions
-- on a clinic's phone, and Ritu could answer neither properly.
--
-- THE FOLLOW-UP FEE HAD NOWHERE TO LIVE. doctors.fee_inr holds one number, and
-- Skin Essence's form gives two: ₹700 for a first visit, free within 5 days,
-- ₹400 after that. Writing the policy into doctors.notes would have been
-- invisible — getDoctorsRoster (db.js) SELECTs id, name, specialty, fee_inr and
-- is_on_call, and nothing else. A prompt cannot render a column nobody reads.
--
-- THE DEFAULT DOCTOR IS A CLINIC'S DECISION, NOT THE MODEL'S. The form names
-- Dr. Daksha Patel when the caller expresses no preference. With two doctors,
-- leaving it to the model is a coin flip on every call — and the clinic has an
-- opinion about who fields new patients.
--
-- ON clinics, not on a new policy table. These are three facts a clinic owns
-- and a desk will eventually edit. A configuration table can be built when
-- there is a second clinic disagreeing about something; building it for the
-- first one is designing a schema against a sample of one.
--
-- ALL NULLABLE, AND NULL MEANS SILENT. A clinic that has not answered gets the
-- behaviour it has today: no follow-up sentence, and the model choosing the
-- doctor as it does now. Absent stays distinguishable from zero — a clinic with
-- followup_fee_inr = 0 is telling us follow-ups are free, which is a different
-- statement from having not been asked.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS followup_free_days INTEGER
    CHECK (followup_free_days IS NULL OR followup_free_days BETWEEN 0 AND 90),
  ADD COLUMN IF NOT EXISTS followup_fee_inr   INTEGER
    CHECK (followup_fee_inr IS NULL OR followup_fee_inr >= 0),
  ADD COLUMN IF NOT EXISTS default_doctor_id  UUID REFERENCES doctors(id);
