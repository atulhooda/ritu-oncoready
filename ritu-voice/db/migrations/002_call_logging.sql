-- ─── 002: richer call logging for the dashboard Calls screen ─────────────────
-- The calls table already has a `transcript JSONB` column (defined in 001 but
-- never written). This migration adds the few fields the Calls screen needs and
-- the indexes to list/filter calls fast, then the app starts populating them.
-- Idempotent: ADD COLUMN IF NOT EXISTS, re-running is a no-op.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS language       TEXT;   -- detected reply language (hi-IN/mr-IN/en-IN)
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reason         TEXT;   -- patient's stated complaint/symptom
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url  TEXT;   -- Exotel call-recording URL (fetched by Call SID)

-- List newest-first per clinic (the Calls screen default view).
CREATE INDEX IF NOT EXISTS idx_calls_clinic_recent ON calls (clinic_id, created_at DESC);
-- Filter by outcome within a clinic (Booked / Inquiry / Callback / …).
CREATE INDEX IF NOT EXISTS idx_calls_clinic_outcome ON calls (clinic_id, outcome);
