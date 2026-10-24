// ═══════════════════════════════════════════════════════════════════════════
// brain-streaming.js — LLM→TTS streaming path (feature/llm-streaming)
//
// getResponseStream() is an async generator that streams the LLM response
// sentence-by-sentence so callHandler.speakStream() can start TTS on the
// first sentence while the LLM is still generating the rest. This masks
// fallback-provider latency (DeepInfra) on the afternoon path once Groq is
// throttled.
//
// SCOPE — Option B (booking turns stay non-streaming):
//   This path is ONLY invoked by callHandler for conversationPhase in
//   {greeting, reason} — phases where the LLM cannot legitimately emit
//   BOOK_APPOINTMENT / UPDATE_APPOINTMENT (booking requires a confirmed
//   slot, which only happens in the scheduling phase onward). Booking and
//   update turns run through the proven non-streaming brain.getResponse(),
//   which does the calendar I/O and only then speaks the confirmation.
//
//   A booking-sentinel sniffer runs as a DEFENSIVE backstop: if a booking
//   sentinel somehow leaks into a greeting/reason turn, we flag it
//   (bookingIntentLeaked) so the caller can re-run non-streaming. Because
//   spoken text in these phases is questions ("Aapko kya takleef hai?"),
//   not booking confirmations, a defensive re-run cannot double-speak a
//   confirmation.
//
// Yields:
//   { kind: 'sentence', text }          — a cleaned, speakable sentence
//   { kind: 'done', result }            — final, with the same fields as
//                                          getResponse's non-booking return
//                                          (text, patientName, reason,
//                                          emergency, endCall) + raw text
//   { kind: 'fallback-required', reason } — caller must run non-streaming
//                                          getResponse() instead
// ═══════════════════════════════════════════════════════════════════════════

const { streamWithFailover } = require('./llm');
const {
  buildMessages,
  cleanResponse,
  extractPatientName,
  extractPatientReason
} = require('./brain');

// Sentence-ending punctuation: Devanagari danda (। ॥) + Latin . ? !
// We split on these so each emitted unit is a natural prosodic chunk for TTS.
const SENTENCE_END = /([।॥.?!]+)/;

// ─── BOTH REGEXES DERIVE FROM brain.js SENTINEL_NAMES ───────────────────────
// They used to be hand-written copies, and on 2026-08-11 a patient heard the
// consequence. REQUEST_CALLBACK was added to brain-lean.js on 2026-08-10 and to
// neither list here, so on live call c791e4114d5658031b7b6bbdf3f81a8b the
// streaming path (a) did not recognise it as a sentinel and spoke it aloud in
// Marathi TTS, and (b) did not hand the turn to the non-streaming path, so
// processLeanRaw never ran and no callbacks row was written. Both halves of the
// fix it was meant to be, undone by the copies.
//
// A sentinel that writes to the database MUST force the non-streaming path:
// streaming speaks first and parses after, which is the wrong order when a
// promise has to be backed by a committed row.
const { SENTINEL_NAMES } = require('./brain');

const PAYLOAD_SENTINELS = SENTINEL_NAMES.map((n) => `${n}\\s*:`).join('|');

// Presence means this turn must be handled by the non-streaming path
// (DB/calendar I/O, then an ordered confirmation).
const HANDOFF_RE = new RegExp(`(${PAYLOAD_SENTINELS})`, 'i');
function scanForBookingIntent(accumulated) {
  return HANDOFF_RE.test(accumulated);
}

// Does the accumulated buffer contain a sentinel line? Used to stop emitting
// spoken sentences once the sentinel block begins (sentinels always come
// AFTER the spoken reply in our prompt format). The bare flags below carry no
// JSON payload, so they are not in SENTINEL_NAMES and are listed explicitly.
const BARE_FLAGS = ['PATIENT_NAME', 'PATIENT_REASON', 'DOCTOR_NAME', 'END_CALL',
  'EMERGENCY_DETECTED', 'NAME_CONFIRMED', 'TIME_CONFIRMED'];
const SENTINEL_LINE = new RegExp(`(${[...SENTINEL_NAMES, ...BARE_FLAGS].join('|')})\\s*:`, 'i');

// Given the spoken-text-so-far and the index already emitted, return the
// next complete sentence (cleaned) and the new emitted index — or null if
// no complete sentence is available yet.
//
// "Complete" = there is a sentence-ending punctuation mark followed by either
// more text or end-of-spoken-region. We only emit up to the LAST boundary so
// a half-formed trailing clause keeps buffering.
function nextSentence(spokenText, fromIndex) {
  const remainder = spokenText.slice(fromIndex);
  if (!remainder) return null;

  // Find the last sentence boundary in the remainder. Emitting up to the
  // last boundary (not the first) lets multiple short sentences flush
  // together and avoids choppy 2-word TTS calls.
  // A period after an honorific ("Dr." / "डॉ.") is NOT a boundary — splitting
  // there ships a lone "Dr." to TTS as its own sentence (live call 2026-07-08:
  // 3-char en-IN TTS dial mid-Kannada reply). No \b before डॉ — ASCII-only.
  let lastBoundaryEnd = -1;
  const re = new RegExp(SENTENCE_END, 'g');
  let m;
  while ((m = re.exec(remainder)) !== null) {
    if (m[0] === '.' && /(?:^|[\s('"])(?:[Dd]rs?|[Mm]rs?|[Mm]s|[Pp]rof|[A-Za-z])$|(?:डॉ|ಡಾ|ਡਾ|డా|டா|ડૉ|ডা|ഡോ|ଡା)$/.test(remainder.slice(0, m.index))) continue;
    lastBoundaryEnd = m.index + m[0].length;
  }
  if (lastBoundaryEnd === -1) return null; // no complete sentence yet

  const raw = remainder.slice(0, lastBoundaryEnd);
  const cleaned = cleanResponse(raw).trim();
  return { rawLen: lastBoundaryEnd, cleaned };
}

// Extract just the spoken region (everything before the first sentinel line).
// cleanResponse strips sentinels anyway, but we also need to STOP emitting
// once the sentinel block starts, so we slice the spoken region explicitly.
function spokenRegion(accumulated) {
  const lines = accumulated.split('\n');
  const spoken = [];
  for (const line of lines) {
    if (SENTINEL_LINE.test(line)) break;
    spoken.push(line);
  }
  return spoken.join('\n');
}

async function* getResponseStream(conversationHistory, callerPhone, options = {}) {
  const messages = buildMessages(conversationHistory, options);

  let accumulated = '';
  let emittedIndex = 0;       // chars of spoken region already emitted as sentences
  let ttftMs = null;
  let provider = null;
  let model = null;
  let sawBookingIntent = false;

  try {
    for await (const chunk of streamWithFailover(messages, { temperature: 0.6, maxTokens: 200 })) {
      if (chunk.ttftMs && ttftMs === null) ttftMs = chunk.ttftMs;
      if (chunk.provider) provider = chunk.provider;
      if (chunk.model) model = chunk.model;
      if (chunk.done) break;
      if (!chunk.content) continue;

      accumulated += chunk.content;

      // Defensive backstop — booking sentinel in a phase that shouldn't book.
      if (!sawBookingIntent && scanForBookingIntent(accumulated)) {
        sawBookingIntent = true;
        // If we haven't spoken anything yet, cleanly hand off to non-streaming.
        if (emittedIndex === 0) {
          yield { kind: 'fallback-required', reason: 'booking_intent_detected_pre_speech' };
          return;
        }
        // Otherwise we've already streamed conversational sentences (questions);
        // stop emitting further and let the turn complete so the caller can
        // re-run non-streaming to process the booking. No double-confirmation
        // risk because what we streamed were not booking confirmations.
      }

      // Emit any newly-complete sentences from the spoken region.
      if (!sawBookingIntent) {
        const spoken = spokenRegion(accumulated);
        let next;
        while ((next = nextSentence(spoken, emittedIndex)) !== null) {
          emittedIndex += next.rawLen;
          if (next.cleaned) {
            yield { kind: 'sentence', text: next.cleaned, ttftMs, provider, model };
          }
        }
      }
    }

    // Stream finished. Flush any trailing spoken text that didn't end with
    // punctuation (e.g. a final clause with no danda).
    if (!sawBookingIntent) {
      const spoken = spokenRegion(accumulated);
      const tail = cleanResponse(spoken.slice(emittedIndex)).trim();
      if (tail) yield { kind: 'sentence', text: tail, ttftMs, provider, model };
    }

    // Build the final result (same shape as getResponse's non-booking return).
    const finalPatientName = extractPatientName(accumulated);
    const finalReason = extractPatientReason(accumulated);
    const result = {
      text: cleanResponse(accumulated).trim(),
      booked: false,
      appointmentTime: null,
      patientName: finalPatientName,
      reason: finalReason,
      emergency: accumulated.includes('EMERGENCY_DETECTED:true'),
      isSlotFailure: false,
      endCall: accumulated.includes('END_CALL:true'),
      bookingIntentLeaked: sawBookingIntent,
      provider,
      model,
      ttftMs
    };
    yield { kind: 'done', result };
  } catch (err) {
    // Any streaming failure → tell the caller to fall back to non-streaming,
    // which has its own failover + error handling.
    console.error('[brain-streaming] stream error, requesting fallback:', err.message);
    yield { kind: 'fallback-required', reason: `stream_error: ${err.message}` };
  }
}

module.exports = {
  getResponseStream,
  // exported for unit tests
  scanForBookingIntent,
  spokenRegion,
  nextSentence
};
