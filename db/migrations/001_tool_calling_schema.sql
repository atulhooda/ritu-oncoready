-- ═══════════════════════════════════════════════════════════════════════════
-- 001 — Tool-calling architecture schema
--
-- Replaces the flat single-clinic voice-agent tables (patients, appointments,
-- calls) with a multi-tenant UUID-PK schema. Adds new tables that the 5
-- tool-calling functions in tools/ will query:
--
--   clinics              — tenant root
--   doctors              — per-clinic doctor roster (with is_on_call flag)
--   doctor_schedules     — recurring weekly availability (day_of_week + times)
--   doctor_exceptions    — one-off leave / extra-hours / closure overrides
--   patients             — per-clinic patient identity (phone + name composite)
--   appointments         — bookings with optional google_calendar_event_id
--   callbacks            — async requests for on-call specialists (handled by
--                          clinic staff out-of-band, status=pending|resolved)
--   calls                — per-call record, links to appointment_id / callback_id
--
-- INTENTIONALLY NOT TOUCHED:
--   whatsapp_conversations  — still used by whatsappBrain.js
--   whatsapp_messages       — same
--
-- Run via: node db/migrate.js
-- Transaction handling is done by the migrate runner; this file is plain DDL.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop legacy tables. CASCADE clears foreign keys from the old schema.
-- The whatsapp tables are dropped too because their legacy patient_id was
-- INTEGER and must become UUID to reference the new patients table.
DROP TABLE IF EXISTS whatsapp_messages       CASCADE;
DROP TABLE IF EXISTS whatsapp_conversations  CASCADE;
DROP TABLE IF EXISTS calls         CASCADE;
DROP TABLE IF EXISTS appointments  CASCADE;
DROP TABLE IF EXISTS patients      CASCADE;

-- ─── clinics ───────────────────────────────────────────────────────────────
CREATE TABLE clinics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  timezone    TEXT DEFAULT 'Asia/Kolkata',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── doctors ───────────────────────────────────────────────────────────────
CREATE TABLE doctors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  name        TEXT NOT NULL,
  specialty   TEXT NOT NULL,
  is_on_call  BOOLEAN DEFAULT FALSE,
  fee_inr     INTEGER,
  notes       TEXT,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── doctor_schedules ──────────────────────────────────────────────────────
-- Recurring weekly availability. day_of_week: 0=Sunday … 6=Saturday.
-- No clinic_id column — reach it via doctor_id → doctors.clinic_id when needed.
CREATE TABLE doctor_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id    UUID NOT NULL REFERENCES doctors(id),
  day_of_week  INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  is_walk_in   BOOLEAN DEFAULT FALSE,
  notes        TEXT
);

-- ─── doctor_exceptions ─────────────────────────────────────────────────────
-- One-off overrides on top of doctor_schedules:
--   'leave'        — doctor unavailable that day (start/end ignored)
--   'extra_hours'  — additional availability outside normal schedule
--   'closed'       — clinic-side closure (different from individual leave)
CREATE TABLE doctor_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       UUID NOT NULL REFERENCES doctors(id),
  exception_date  DATE NOT NULL,
  exception_type  TEXT NOT NULL CHECK (exception_type IN ('leave', 'extra_hours', 'closed')),
  start_time      TIME,
  end_time        TIME,
  notes           TEXT
);

-- ─── patients ──────────────────────────────────────────────────────────────
-- UNIQUE (clinic_id, phone, name) intentionally allows multiple patient rows
-- per phone when family members share a number. find_patient_appointment
-- returns ALL matches when no name is supplied so the LLM can disambiguate
-- ("Aap [name1] hain ya [name2]?").
CREATE TABLE patients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  phone       TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clinic_id, phone, name)
);

-- ─── appointments ──────────────────────────────────────────────────────────
CREATE TABLE appointments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                 UUID NOT NULL REFERENCES clinics(id),
  patient_id                UUID NOT NULL REFERENCES patients(id),
  doctor_id                 UUID NOT NULL REFERENCES doctors(id),
  appointment_time          TIMESTAMPTZ NOT NULL,
  reason                    TEXT,
  status                    TEXT NOT NULL DEFAULT 'booked'
                              CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
  google_calendar_event_id  TEXT,
  source                    TEXT DEFAULT 'ritu',
  -- WhatsApp scheduler flags (24h reminder, post-visit follow-up, confirm).
  reminder_sent             BOOLEAN DEFAULT FALSE,
  follow_up_sent            BOOLEAN DEFAULT FALSE,
  confirmed                 BOOLEAN DEFAULT FALSE,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- ─── callbacks ─────────────────────────────────────────────────────────────
-- Async requests for on-call specialists. The clinic resolves these manually;
-- Ritu just records the intent and tells the patient the ETA.
CREATE TABLE callbacks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  patient_name TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  specialty    TEXT NOT NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'resolved')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);

-- ─── calls ─────────────────────────────────────────────────────────────────
CREATE TABLE calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id),
  exotel_call_sid   TEXT UNIQUE,
  patient_phone     TEXT,
  patient_name      TEXT,
  patient_id        UUID REFERENCES patients(id),
  duration_seconds  INTEGER,
  outcome           TEXT CHECK (outcome IN ('booked', 'callback_requested', 'inquiry_only', 'emergency', 'hangup', 'failed')),
  appointment_id    UUID REFERENCES appointments(id),
  callback_id       UUID REFERENCES callbacks(id),
  transcript        JSONB,
  whatsapp_sent     BOOLEAN DEFAULT FALSE,   -- missed-call follow-up tracking
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── whatsapp_conversations + whatsapp_messages ──────────────────────────────
-- WhatsApp messaging state. patient_id is UUID here (matches the new patients
-- table) — the legacy versions used INTEGER, which is why they're recreated
-- as part of this migration rather than carried over.
CREATE TABLE whatsapp_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID REFERENCES clinics(id),
  patient_id      UUID REFERENCES patients(id),
  phone_number    TEXT UNIQUE NOT NULL,
  state           TEXT DEFAULT 'idle',
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE whatsapp_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES whatsapp_conversations(id),
  patient_id      UUID REFERENCES patients(id),
  appointment_id  UUID REFERENCES appointments(id),
  direction       TEXT NOT NULL,
  message_sid     TEXT,
  body            TEXT NOT NULL,
  type            TEXT DEFAULT 'general',
  status          TEXT DEFAULT 'sent',
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── indices ───────────────────────────────────────────────────────────────
CREATE INDEX idx_patients_phone        ON patients(clinic_id, phone);
CREATE INDEX idx_appointments_time     ON appointments(clinic_id, appointment_time);
CREATE INDEX idx_appointments_patient  ON appointments(patient_id);
CREATE INDEX idx_appointments_doctor   ON appointments(doctor_id, appointment_time);
CREATE INDEX idx_callbacks_pending     ON callbacks(clinic_id, status) WHERE status = 'pending';
CREATE INDEX idx_doctor_schedules_doc  ON doctor_schedules(doctor_id, day_of_week);
CREATE INDEX idx_doctor_exceptions_doc ON doctor_exceptions(doctor_id, exception_date);
CREATE INDEX idx_appointments_reminder ON appointments(appointment_time) WHERE status = 'booked' AND reminder_sent = FALSE;
CREATE INDEX idx_calls_followup        ON calls(created_at) WHERE whatsapp_sent = FALSE;
CREATE INDEX idx_wa_conversations_phone ON whatsapp_conversations(phone_number);
