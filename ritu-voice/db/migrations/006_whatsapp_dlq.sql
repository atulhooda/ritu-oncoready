-- ═══════════════════════════════════════════════════════════════════════════
-- 006 — WhatsApp dead-letter queue (S7-T1: the token-190 class kill)
--
-- Today a failed WhatsApp send (expired token / network error / rate limit)
-- is console.error'd and gone — metaPost returns null and the confirmation
-- silently never reaches the patient (the mid-demo 190 incident). This table
-- captures every failed send with the FULL Meta /messages request payload,
-- so after the operator fixes the cause (e.g. rotates the token) the sends
-- can be replayed by hand:  node tools/redriveWhatsApp.js
--
-- Indeterminate rule (Meta provides NO send idempotency key): a timeout or
-- connection drop means Meta MAY have accepted the send and returned a wamid
-- we never saw. Those rows are stamped indeterminate = TRUE and the redrive
-- script SKIPS them by default — re-sending could double-message the patient.
-- Only definitive rejections (Meta answered with an error body — 190, 131056,
-- template errors, …) are redriven automatically. Never redrive past a wamid.
--
-- Plain CREATE TABLE — safe inside the runner's transaction, but per process
-- apply BY HAND to the DEMO database first, then the hospital. After a hand
-- apply, record it so the runner skips this file:
--   INSERT INTO schema_migrations (version) VALUES ('006_whatsapp_dlq');
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS whatsapp_dlq (
  id                 BIGSERIAL PRIMARY KEY,
  -- No FK to clinics: a dead-letter row must never itself fail to insert.
  clinic_id          UUID,
  to_phone           TEXT NOT NULL,
  message_kind       TEXT,                        -- 'text' | 'template'
  -- The exact Meta /messages POST body — everything needed to re-send.
  request_body       JSONB NOT NULL,
  phone_number_id    TEXT,                        -- sender identity used
  used_clinic_creds  BOOLEAN NOT NULL DEFAULT FALSE,
  error_code         INTEGER,                     -- Meta error.code (190, 131056, …)
  error_detail       TEXT,
  -- TRUE = no definitive rejection from Meta (timeout / connection error):
  -- a wamid may exist on Meta's side. Redrive skips these by default.
  indeterminate      BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'dead', -- 'dead' | 'redriven'
  redrive_attempts   INTEGER NOT NULL DEFAULT 0,
  last_redrive_error TEXT,
  redriven_at        TIMESTAMPTZ,
  redrive_wamid      TEXT,                        -- wamid of the successful re-send
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Redrive scans dead rows oldest-first; ops dashboards read DLQ depth.
CREATE INDEX IF NOT EXISTS idx_whatsapp_dlq_dead
  ON whatsapp_dlq (created_at)
  WHERE status = 'dead';
