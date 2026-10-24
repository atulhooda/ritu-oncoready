-- Patient-uploaded documents (WhatsApp report intake).
-- Patients photograph old reports/prescriptions on WhatsApp after booking;
-- the server stores the image + a vision-structured pre-read for the doctor.
-- Additive only — no existing table is touched.
CREATE TABLE IF NOT EXISTS patient_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  patient_id UUID REFERENCES patients(id),
  phone TEXT,
  wa_media_id TEXT,
  mime_type TEXT,
  caption TEXT,
  content BYTEA NOT NULL,
  summary TEXT,
  summary_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_patient_documents_patient
  ON patient_documents (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_documents_clinic
  ON patient_documents (clinic_id, created_at DESC);
