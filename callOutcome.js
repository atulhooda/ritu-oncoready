// ═══════════════════════════════════════════════════════════════════════════
// WHY DIDN'T THIS CALL BOOK?
//
// Until now a call ended with exactly one line:
//     [CALL <sid>] Call ended. Duration: 102s, Booked: false
// and one of two strings in the database, chosen by callHandler.js:3553-3559:
//     shouldEndCall ? 'System hung up (silence/error/wrapup)' : 'Patient hung up'
//
// Those two strings hide everything that matters:
//   · a patient who asked a question, got an answer and left HAPPY is recorded
//     identically to one who went silent and timed out — both "System hung up"
//   · a DEPLOY that restarted the server is recorded as "Patient hung up",
//     blaming the caller for our redeploy and poisoning every deploy day
//   · a caller we could not HEAR is indistinguishable from one who never spoke,
//     though the fixes are completely different — one is the phone line, the
//     other is the STT
//
// The consequence is that production teaches us nothing. Working out why ONE
// call failed on 2026-07-30 meant a human reading 400 log lines. This makes the
// answer a column.
//
// DESIGN RULES
//  1. PURE. No I/O, no instance, no clock — a plain object in, a verdict out.
//     Testable without a websocket, a database or a phone call.
//  2. NEVER THROWS. Wrapped by the caller too, but it is written so it cannot:
//     every read is defensive and the cascade ends in a default. A classifier
//     that breaks endCall() would cost more than the insight is worth.
//  3. EXHAUSTIVE. The final branch is `unclassified`, which must never appear.
//     It is the canary: a row carrying it means the cascade has a hole.
//  4. `outcome` only ever takes a value the live CHECK constraint already
//     allows — booked | callback_requested | inquiry_only | emergency | hangup |
//     failed. The detail goes in `not_booked_reason`, which has NO constraint,
//     so a new reason can never reject an INSERT and lose the call record.
//
// NOT A FAILURE, and the metric must not treat them as one: `booked`,
// `emergency` (a correct refusal) and `just_asking` (answered, left happy).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// Ordered most-specific first. Each entry: [reason, outcome, test].
// Read top to bottom; the first match wins.
const CASCADE = [
  // ── succeeded ────────────────────────────────────────────────────────────
  ['booked', 'booked', (s) => s.appointmentBooked === true],

  // ── our fault, and today invisible ───────────────────────────────────────
  // A redeploy currently records "Patient hung up". Every deploy day looks like
  // a day patients hung up. This must be distinguishable or the numbers lie.
  ['server_restart', 'failed', (s) => s.endTrigger === 'shutdown'],

  // ── correct refusals ─────────────────────────────────────────────────────
  // Emergency is a SUCCESS: she recognised it and told them to dial 108.
  ['emergency', 'emergency', (s) => s.emergencyDetected === true],

  // ── we tried to book and could not ───────────────────────────────────────
  // Split deliberately: "no time the patient could take" is a ROSTER problem the
  // clinic can fix by opening slots. Anything else is an engineering ticket.
  ['no_time_offered', 'inquiry_only', (s) => s.bookFailKind === 'slot_unavailable'],
  ['booking_broke', 'failed', (s) => !!s.bookFailKind],

  // ── the machinery broke mid-call ─────────────────────────────────────────
  ['system_error', 'failed', (s) => (s.criticalErrors || 0) > 0],

  // ── the patient never really arrived ─────────────────────────────────────
  // These two look identical in the old data and need OPPOSITE fixes.
  // never_spoke  → nothing reached us at all: telephony, or the greeting itself.
  // couldnt_hear → speech DID arrive and every utterance was filtered out as
  //                echo/ghost/garble. That is the line quality or the STT.
  ['never_spoke', 'hangup', (s) => (s.patientTurns || 0) === 0 && (s.dropped || 0) === 0],
  ['couldnt_hear', 'failed', (s) => (s.patientTurns || 0) === 0 && (s.dropped || 0) > 0],

  // ── engaged, then stopped ────────────────────────────────────────────────
  ['went_quiet', 'hangup', (s) => s.endTrigger === 'silence_hangup'],

  // ── engaged and chose not to book — NOT a failure ────────────────────────
  // Ritu answered the question and said goodbye. Today this is stamped with the
  // same string as a silence timeout, which is the single worst conflation here.
  ['just_asking', 'inquiry_only', (s) => s.endTrigger === 'llm_end_call'],

  // ── engaged, then the line dropped ───────────────────────────────────────
  ['hung_up_midway', 'hangup', (s) => s.endTrigger === 'ws_close' || s.endTrigger === 'exotel_stop'],

  // ── engaged, ended, no trigger recorded ──────────────────────────────────
  // Found by the exhaustiveness test: a caller who SPOKE and whose call ended
  // without any terminal path setting a trigger fell through to `unclassified`.
  // Named honestly rather than folded into hung_up_midway — we know they
  // engaged and that the call ended, and we do NOT know how. Folding it in
  // would quietly inflate "patient hung up" with cases that are really a gap in
  // our own instrumentation, which is the exact failure this module exists to
  // end. If this reason starts appearing often, a terminal path is missing its
  // _endTrigger.
  ['ended_unknown', 'hangup', (s) => (s.patientTurns || 0) > 0],
];

/**
 * @param {object} s  a flat snapshot of the call at end. Every field optional.
 *   appointmentBooked, emergencyDetected : boolean
 *   endTrigger    : 'shutdown'|'silence_hangup'|'llm_end_call'|'ws_close'|'exotel_stop'|null
 *   bookFailKind  : 'slot_unavailable'|'unknown_doctor'|'no_appointment_id'|'threw'|null
 *   patientTurns, dropped, criticalErrors : number
 * @returns {{outcome:string, reason:string}}
 */
function classifyCall(s) {
  const snap = s && typeof s === 'object' ? s : {};
  for (const [reason, outcome, test] of CASCADE) {
    let hit = false;
    try { hit = !!test(snap); } catch (_) { hit = false; }   // a bad field must not end the call
    if (hit) return { outcome, reason };
  }
  // Must never happen. Alarm on it rather than silently inventing a category.
  return { outcome: 'inquiry_only', reason: 'unclassified' };
}

// Reasons that are NOT failures — for the desk, so "why calls didn't book" does
// not shame the product for correctly handling an emergency or answering a
// question. Kept beside the cascade so the two cannot drift.
const NOT_A_FAILURE = new Set(['booked', 'emergency', 'just_asking']);

// Plain-language labels. The reader is a front-desk operator, not a developer;
// an enum dump is not a dashboard.
const REASON_LABEL = {
  booked:         { en: 'Booked',                    hi: 'बुक हुई' },
  server_restart: { en: 'Our server restarted',      hi: 'सर्वर रीस्टार्ट' },
  emergency:      { en: 'Emergency — sent to 108',   hi: 'इमरजेंसी' },
  no_time_offered:{ en: 'No suitable time',          hi: 'समय नहीं मिला' },
  booking_broke:  { en: 'Booking failed',            hi: 'बुकिंग विफल' },
  system_error:   { en: 'Something broke',           hi: 'तकनीकी समस्या' },
  never_spoke:    { en: 'Caller never spoke',        hi: 'कुछ नहीं बोला' },
  couldnt_hear:   { en: "Couldn't hear the caller",  hi: 'आवाज़ नहीं आई' },
  went_quiet:     { en: 'Went quiet mid-call',       hi: 'बीच में चुप' },
  just_asking:    { en: 'Just asking — answered',    hi: 'सिर्फ़ पूछताछ' },
  hung_up_midway: { en: 'Hung up mid-call',          hi: 'बीच में काटा' },
  ended_unknown:  { en: 'Ended — cause unknown',     hi: 'कारण अज्ञात' },
  unclassified:   { en: 'Unclassified',              hi: 'अवर्गीकृत' },
};

module.exports = { classifyCall, CASCADE, NOT_A_FAILURE, REASON_LABEL };
