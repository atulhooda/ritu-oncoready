-- ═══════════════════════════════════════════════════════════════════════════
-- 020_outbox.sql — THE OUTBOX (voice copy; verbatim twin of the desk repo's
-- migrations/008_outbox.sql — its scripts/check-sync.cjs compares them).
--
-- Messages the DESK decides and the VOICE SERVICE sends. The desk never
-- talks to Meta: one WhatsApp sender, one template ladder, one delivery
-- ledger (whatsapp_messages), one retry rule. The desk inserts a row
-- (kind + positional variables); the voice scheduler drains queued rows every
-- minute through sendTemplateOrText and marks each row sent or failed once.
--
-- First use (2026-09-14): a doctor's day off → one doctor_leave row per booked
-- patient that day. Second: staff_callback_alert to clinics.staff_alert_phones
-- when a patient asks for a call back. Additive only.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS outbound_messages (
  id             BIGSERIAL PRIMARY KEY,
  clinic_id      UUID NOT NULL REFERENCES clinics(id),
  kind           TEXT NOT NULL CHECK (kind IN ('doctor_leave', 'staff_callback_alert')),
  to_phone       TEXT NOT NULL,
  patient_id     UUID REFERENCES patients(id),
  appointment_id UUID REFERENCES appointments(id),
  callback_id    UUID REFERENCES callbacks(id),
  -- Positional template variables {"1": "...", "2": "..."}. The voice service
  -- picks the template name for the kind (META_TEMPLATE_* env) and builds the
  -- plain-text fallback from the same text, so the wording lives in ONE place.
  variables      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The recipient's language code ('gu-IN'); NULL = the clinic's default.
  language       TEXT,
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sent', 'failed', 'cancelled')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  wamid          TEXT,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at        TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_due  ON outbound_messages (scheduled_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_outbox_appt ON outbound_messages (appointment_id);

-- Staff phones that get a WhatsApp when a patient asks for a call back
-- (module 2b). Empty = nobody; edited from the desk's Settings.
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS staff_alert_phones TEXT[] NOT NULL DEFAULT '{}';
