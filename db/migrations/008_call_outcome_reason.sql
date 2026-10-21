-- ═══════════════════════════════════════════════════════════════════════════
-- 008 — why a call did not book
--
-- Until now a call ended with `outcome` (booked | inquiry_only | …) and a
-- free-text bookingFailureReason that only ever held one of TWO strings, chosen
-- by callHandler.js: "System hung up (silence/error/wrapup)" or "Patient hung
-- up". That collapsed a patient who was helped and left happy, a patient who
-- went silent, and OUR OWN redeploy into indistinguishable records — so
-- production taught us nothing and diagnosing a single call meant a human
-- reading 400 log lines.
--
-- NO CHECK CONSTRAINT on not_booked_reason, deliberately. `outcome` already has
-- one, and the classifier only ever emits values inside it. This column is the
-- detail, and an unconstrained column can never reject an INSERT — a new reason
-- must never be able to lose a call record. The taxonomy lives in callOutcome.js
-- where it can be tested; the database just stores what it decided.
--
-- diagnostics is JSONB so the countable signals (patient turns, dropped
-- utterances, garble re-asks, critical errors, end trigger) can grow without a
-- migration each time. They are already computed at runtime and thrown away.
--
-- ADD COLUMN only — nullable, no default, no rewrite, transaction-safe. Applied
-- automatically by prestart (db/migrate.js) against whichever database the
-- server actually uses, and gated by tools/check-migration-safety.js.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE calls ADD COLUMN IF NOT EXISTS not_booked_reason TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS diagnostics       JSONB;

-- The dashboard's question is "yesterday's calls that did not book, grouped by
-- reason", so the index matches that access pattern.
CREATE INDEX IF NOT EXISTS idx_calls_reason ON calls (clinic_id, not_booked_reason);
