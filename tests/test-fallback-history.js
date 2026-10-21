#!/usr/bin/env node
// ─── WHAT RITU SAID ALOUD MUST ENTER THE RECORD SHE READS ───────────────────
// LIVE, 2026-08-09, call 4843c8bc:
//
//   07:42:13.963  Ritu (stream): 28c/6w        <- SPOKEN to the caller
//   07:42:15.561  Lean stream → non-stream fallback: booking_intent_detected
//   07:42:16.487  LLM latency=953ms            <- a SECOND, independently sampled call
//   07:42:16.525  Ritu: 37c/8w                 <- a DIFFERENT reply, also spoken
//
// Booking must never stream — a spoken "booked" has to be backed by a committed
// row — so when the sentinel appears mid-stream the turn re-runs non-streamed.
// That part is correct and stays.
//
// What is NOT correct: getLeanResponseStream appends to `accumulated` and trips
// the booking check BEFORE the emit loop, but sentences from EARLIER chunks are
// already through speakSentence — audio on the wire. So the caller has heard a
// substantive claim ("Dr. Manoj Deo is available tomorrow at ten") and the
// second generation, at temperature 0.5 like the first, is under no obligation
// to agree about the time.
//
// AND THE SECOND CALL CANNOT EVEN SEE IT. speakStream returns
// { fallback, reason, spokeAnything } — fullSpokenText is absent — and
// callHandler's fallback branch discards the outcome entirely. Three lines
// above, the DISCARDED (barge-in) branch routes through
// _recordBargeInPartial, which pushes exactly this text into
// conversationHistory. The fallback branch has no equivalent, so the spoken
// sentence reaches this.transcript and never the history the model reads —
// on this turn and every turn after it.
//
// Same shape as the garble-guard bug (6427d2b): a deterministic line the model
// cannot see is a line it will contradict.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const CallHandler = require('../callHandler.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

function handler() {
  const h = new CallHandler('fb_test', '+919876543210', { readyState: 1, send: () => {} }, 'test', false);
  h._spoken = [];
  h._speakSentence = async (t) => { h._spoken.push(t); };
  h._sendMark = () => {}; h._sendSilence = () => {};
  h._flushStreamingTail = () => {}; h._sendStreamingAudio = () => {}; h._clearAudio = () => {};
  h.conversationHistory = [];
  return h;
}

// A booking turn as the provider actually delivers it: the spoken line arrives
// in small chunks and completes, THEN the sentinel appears.
async function* bookingStream() {
  yield { kind: 'sentence', text: 'डॉक्टर मनोज देव कल सुबह दस बजे उपलब्ध हैं.' };
  yield { kind: 'fallback-required', reason: 'booking_intent_detected' };
}
async function* silentBookingStream() {
  // Large provider chunks: the sentinel lands before any sentence completes.
  yield { kind: 'fallback-required', reason: 'booking_intent_detected' };
}

console.log('\nSTREAM FALLBACK — the second generation must see what the first already said\n');

(async () => {

  await ok('THE BUG: a sentence spoken before the fallback reaches conversationHistory', async () => {
    const h = handler();
    const outcome = await h.speakStream(bookingStream(), h._generationId);
    assert.strictEqual(outcome.fallback, true, 'this stream should have fallen back');
    assert.deepStrictEqual(h._spoken, ['डॉक्टर मनोज देव कल सुबह दस बजे उपलब्ध हैं.'],
      'the harness did not actually speak — the test would prove nothing');
    assert(outcome.fullSpokenText,
      'speakStream does not return fullSpokenText on the fallback path, so the caller CANNOT record ' +
      'what was said — the second LLM call is generated blind to it');
    assert.strictEqual(outcome.fullSpokenText.trim(), 'डॉक्टर मनोज देव कल सुबह दस बजे उपलब्ध हैं.');
  });

  await ok('THE CALLSITE records it before re-running — driven, not simulated', async () => {
    // The first version of this test called _recordBargeInPartial ITSELF and
    // then asserted history. It proved the helper works and said NOTHING about
    // whether callHandler uses it: deleting the call from the fallback branch
    // left this green. Mutation-tested and caught, which is the only reason it
    // is written this way now.
    //
    // So: drive the real fallback branch. processIntent is stubbed to capture
    // the history AS THE SECOND GENERATION WOULD SEE IT — that is the whole
    // point, since a re-run blind to the spoken line is what produced two
    // contradictory replies on call 4843c8bc.
    const h = handler();
    let historyAtRerun = null;
    h.processIntent = async () => {
      historyAtRerun = h.conversationHistory.filter((m) => m.role === 'assistant').map((m) => m.content);
    };
    // processIntentLeanStream takes an optional speculation whose commitStream()
    // supplies the chunks — the seam that lets the REAL method run, fallback
    // branch and all, with no LLM anywhere near it.
    await h.processIntentLeanStream('मुझे appointment चाहिए', { commitStream: () => bookingStream() });
    assert(historyAtRerun !== null, 'the fallback branch never reached processIntent — the harness is wrong');
    assert.deepStrictEqual(historyAtRerun, ['डॉक्टर मनोज देव कल सुबह दस बजे उपलब्ध हैं.'],
      `the second generation was blind to what was already spoken aloud: ${JSON.stringify(historyAtRerun)}`);
  });

  await ok('nothing spoken → nothing recorded, and no empty turn in history', async () => {
    // The large-chunk case. Must not push an empty assistant turn.
    const h = handler();
    const outcome = await h.speakStream(silentBookingStream(), h._generationId);
    assert.strictEqual(outcome.fallback, true);
    assert.deepStrictEqual(h._spoken, [], 'nothing should have been spoken');
    h._recordBargeInPartial(outcome);
    assert.deepStrictEqual(h.conversationHistory, [],
      'an empty assistant turn was pushed into history');
  });

  await ok('spokeAnything is reported, because it decides whether this is worth optimising', async () => {
    // The fallback turn gets no speculative head start, so it pays the full
    // ~950ms. Whether that is worth attacking depends entirely on how often a
    // fallback happens with nothing yet spoken — the only case where reusing
    // the generation would be safe. That number is computed here and was
    // being thrown away at the log line.
    const spoke = await handler().speakStream(bookingStream(), 0);
    const silent = await handler().speakStream(silentBookingStream(), 0);
    assert.strictEqual(spoke.spokeAnything, true);
    assert.strictEqual(silent.spokeAnything, false);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
