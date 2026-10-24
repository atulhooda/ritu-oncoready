-- ═══════════════════════════════════════════════════════════════════════════
-- 019 — THE RECEPTIONIST'S LOOP, UNDERNEATH.
--
-- What the desk redesign (2026-09-10 brief) needs from the shared schema:
--
--   appointments.arrived_at / arrived_by     who turned up, as a COLUMN. Never a
--                                            status value: uniq_doctor_slot and
--                                            uniq_active_patient_doctor_day key
--                                            on status = 'booked', so a status
--                                            change would free the slot to
--                                            Ritu's next caller. The no-show job
--                                            now reads arrived_at IS NULL.
--   appointments.verified_at / verified_by   "new from Ritu" as a filter, never a
--                                            gate. Arrival counts as verifying.
--   appointment_events                       every booked/moved/cancelled/arrived
--                                            with before/after and an undo chain,
--                                            so the desk's 15-minute undo is a row,
--                                            not a timer in a browser tab.
--   callbacks.outcome/attempts/…             the banded callback queue.
--   calls.is_test                            scripted test calls stay out of the
--                                            clinic's numbers.
--   clinics.slot_minutes / agent_may_cancel  the voice service writes ITS running
--                                            switches here at boot (db.reportRuntime)
--                                            so the desk shows what Ritu actually
--                                            does, not a second copy of a setting.
--   clinics.short_name / city / locale       identity is data; the desk stops
--                                            hard-coding the clinic name.
--
-- Additive, transactional, IF NOT EXISTS throughout. A VERBATIM COPY runs from
-- the desk's own runner (ritu-desk-demo/migrations/007_desk_loop.sql), kept
-- identical by the desk's `npm run check:sync`; either side may apply first.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS arrived_at  TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS arrived_by  TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS verified_by TEXT;
CREATE INDEX IF NOT EXISTS idx_appointments_unarrived
  ON appointments (clinic_id, appointment_time)
  WHERE status = 'booked' AND arrived_at IS NULL;

CREATE TABLE IF NOT EXISTS appointment_events (
  id             BIGSERIAL PRIMARY KEY,
  clinic_id      UUID NOT NULL REFERENCES clinics(id),
  appointment_id UUID NOT NULL REFERENCES appointments(id),
  action         TEXT NOT NULL CHECK (action IN (
                   'booked', 'moved', 'cancelled', 'completed', 'no_show', 'reopened',
                   'arrived', 'unarrived', 'verified', 'unverified')),
  actor          TEXT NOT NULL CHECK (actor IN ('desk', 'ritu', 'system', 'whatsapp')),
  actor_label    TEXT,
  channel        TEXT CHECK (channel IS NULL OR channel IN ('desk', 'call', 'whatsapp', 'job')),
  call_id        UUID REFERENCES calls(id),
  before         JSONB,
  after          JSONB,
  undo_of        BIGINT REFERENCES appointment_events(id),
  undone_at      TIMESTAMPTZ,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appt_events_appt   ON appointment_events (appointment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appt_events_recent ON appointment_events (clinic_id, created_at DESC);

ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS outcome         TEXT
  CHECK (outcome IS NULL OR outcome IN ('booked', 'spoke', 'unreachable', 'not_needed'));
ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS attempts        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS next_nudge_at   TIMESTAMPTZ;
ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS appointment_id  UUID REFERENCES appointments(id);
ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS notes           TEXT;

ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS short_name          TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS city                TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS locale              TEXT NOT NULL DEFAULT 'en'
  CHECK (locale IN ('en', 'hi', 'gu'));
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS slot_minutes        INTEGER NOT NULL DEFAULT 30
  CHECK (slot_minutes BETWEEN 5 AND 120);
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS agent_may_cancel    BOOLEAN;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS runtime             JSONB;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS runtime_reported_at TIMESTAMPTZ;
