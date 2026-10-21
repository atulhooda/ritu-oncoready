-- ═══════════════════════════════════════════════════════════════════════════
-- 018 — WHAT META SAID ABOUT EACH OUTBOUND MESSAGE.
--
-- Every outbound row recorded "we handed it to Meta". Whether Meta delivered
-- it lived only in raw webhook_events JSON, and nobody read it: between 27 Aug
-- and 5 Sep every booking confirmation went out as plain text and Meta failed
-- all of them (131047 — outside the 24-hour window) while the desk, the Sheet
-- and the call log said "WhatsApp sent". The status webhook now writes the
-- verdict onto the row itself: delivery_status (sent/delivered/read/failed),
-- delivery_error (Meta's code, e.g. 131047), delivery_at.
--
-- Additive, transactional.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS delivery_error  INTEGER;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS delivery_at     TIMESTAMPTZ;
