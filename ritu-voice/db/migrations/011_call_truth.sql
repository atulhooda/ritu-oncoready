-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — WHAT THE CALLER ACTUALLY SAID
--
-- Every accuracy number this product has produced came from calls.transcript,
-- and that column is the STT's OUTPUT. "The STT lost it" has therefore been
-- unfalsifiable: we can see what Sarvam wrote, never what the patient said.
-- capture-gap.js reports 46.2% of stated facts reaching the record, and its
-- denominator only counts facts already in the transcript — it cannot see a
-- drug or a name that never became text at all.
--
-- On 2026-08-16 that changed for the first time. Audio for 19 calls was pulled
-- from Exotel and transcribed by two models outside the live loop, and on call
-- e370519a all three systems agreed the caller said "ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ" —
-- my name is NOT Rajamma. Sarvam had heard it perfectly. The appointment was
-- still filed under ರಾಜಮ್ಮ. First measured split between vendor error and our
-- error: 0 / 1, and it took ten minutes once the audio existed.
--
-- AND THEN IT NEARLY EVAPORATED. tools/transcribe-truth.js wrote those
-- transcripts to files under --save, which on the deployment means /tmp inside
-- a container that restarts on every deploy. The most valuable data this
-- project has ever produced had a lifetime measured in hours. This table is
-- where it lives instead.
--
-- ONE ROW PER (CALL, MODEL), NOT ONE PER CALL. Disagreement between independent
-- transcribers is the signal — it marks the turns where the audio is genuinely
-- ambiguous and Ritu should read back rather than assume. Collapsing to a
-- single "truth" row would discard exactly that. Nothing here is authoritative;
-- these are opinions, and the column names say so.
--
-- NOT A TRAINING SET AND NOT PHI-FREE. These are real patients' voices
-- transcribed in full. Same retention and access rules as calls.transcript.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS call_truth (
  id              BIGSERIAL PRIMARY KEY,
  exotel_call_sid TEXT NOT NULL,
  -- The transcriber. 'sarvam-realtime' is reserved for what production acted
  -- on, so a row set is self-contained and comparable without joining back.
  source          TEXT NOT NULL,
  transcript      TEXT NOT NULL,
  -- Whatever the transcriber reported about itself: latency, token counts, the
  -- fabrication tripwire's verdict. Kept loose because the useful fields are
  -- not knowable until a transcriber surprises us.
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Re-running the tool on the same call must REPLACE that source's opinion, not
-- accumulate copies. Without this, a second run doubles every count and the
-- gap numbers quietly drift.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_truth_call_source
  ON call_truth (exotel_call_sid, source);

-- The only other access pattern: "which calls have ground truth yet?"
CREATE INDEX IF NOT EXISTS idx_call_truth_sid
  ON call_truth (exotel_call_sid);
