#!/usr/bin/env node
// ─── "THERE IS NO PROBLEM" IS NOT A SYMPTOM RESTATEMENT ─────────────────────
// LIVE, demo clinic, 2026-08-08, turns 3-9 of a 153s booking:
//
//    3 patient  यार मेरे को ना थोड़े अपने दांत दिखाने थे।   (I wanted my teeth looked at)
//    4 ritu     अच्छा। यह तकलीफ़ कब से है जी?              (since when is this problem?)
//    5 patient  तकलीफ़ नहीं है बस मुझे अपना दांत का वो दिखाना है।
//               (THERE IS NO PROBLEM — I just want a check)
//    6 patient  inspection करवाना है
//    7 ritu     अच्छा। यह तकलीफ़ कब से है जी?              ← VERBATIM, again
//
// The stage-1 re-ask exists for a good reason and its comment documents it:
// on a Punjabi call a caller RESTATED their symptom because the line garbled,
// the machine treated that as a duration answer, and "since yesterday" was
// recorded against the MEDICATION question. A wrong clinical entry beats a
// missing one, so a reply that looks like a symptom restatement earns one
// re-ask.
//
// The detector is specialtiesForSymptom(reply) > 0. Turn 5 contains दांत —
// tooth — which maps to Dental, so it read as a restatement. But the patient
// had just said तकलीफ़ नहीं है. He was not restating a complaint; he was
// DENYING there is one, which is the normal way to book a routine check-up.
//
// A denial is an answer to "how long has this been going on?" — the answer is
// "it hasn't". So it must advance the stage, not restart it.
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'on', 'the pre-visit intake itself is under test; a booking-only profile turns it off (see test-previsit-intake-switch.js)');
const assert = require('assert');
// _maybeHistoryQuestion returns null immediately unless clinicMode === 'lean'.
// Locally CLINIC_MODE is unset and defaults to 'full', so without this every
// assertion below passes while running NOTHING — the first version of this file
// did exactly that, and reported the live failure as already fixed.
process.env.CLINIC_MODE = 'lean';
const CallHandler = require('../callHandler.js');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n      ${e.message}`); fail++; } };

function h() {
  const x = new CallHandler('t', '+919876543210', { readyState: 1, send: () => {} }, 'test', false);
  x._historyStage = 1; x._durationReasked = false; x._readbackPending = false; x._medRepeatPending = false;
  x.appointmentBooked = false;
  return x;
}
// DERIVED from the code, never hand-written. The first version of this file
// matched /कब से|कधी पासून/ and reported the guard as broken — the harness pins
// no language, so the machine answers in Marathi ("ही तक्रार किती
// दिवसांपासून आहे?"), which that pattern misses. A test that guesses at the
// string it is checking measures the guess.
const DURATION_Q = (() => {
  const x = h(); x._historyStage = 0;                       // stage 0 + a symptom
  return x._maybeHistoryQuestion('मेरे सिर में दर्द हो रहा है');
})();
const MEDS_Q = (() => {
  const x = h(); x._historyStage = 1;                       // stage 1 + a duration answer
  return x._maybeHistoryQuestion('दो दिन से');
})();
assert(DURATION_Q && MEDS_Q && DURATION_Q !== MEDS_Q,
  `could not derive the two questions: ${JSON.stringify([DURATION_Q, MEDS_Q])}`);
const DURATION = { test: (t) => t === DURATION_Q };

console.log('\nHISTORY STAGE — a denial answers the question, it does not restart it\n');

ok('THE LIVE FAILURE: "तकलीफ़ नहीं है, बस दांत दिखाना है" does not re-ask', () => {
  const x = h();
  const out = x._maybeHistoryQuestion('तकलीफ़ नहीं है बस मुझे अपना दांत का वो दिखाना है');
  assert(!(out && DURATION.test(out)), `re-asked the duration question verbatim: ${out}`);
});

ok('other denials too', () => {
  for (const s of ['कोई तकलीफ नहीं है', 'दर्द नहीं है सिर्फ checkup', 'no problem just a dental checkup']) {
    const x = h();
    const out = x._maybeHistoryQuestion(s);
    assert(!(out && DURATION.test(out)), `re-asked on a denial: "${s}" -> ${out}`);
  }
});

ok('THE GUARD IT MUST NOT BREAK: a genuine symptom RESTATEMENT still re-asks once', () => {
  // The Punjabi call this logic was built for. Without it the duration is lost
  // AND lands on the medication question.
  const x = h();
  const out = x._maybeHistoryQuestion('मेरे सिर में दर्द हो रहा है');
  assert(out && DURATION.test(out), 'the symptom-restatement re-ask stopped working — that is the regression that matters');
});

ok('and still at most ONCE per call', () => {
  const x = h();
  x._maybeHistoryQuestion('मेरे सिर में दर्द हो रहा है');
  const second = x._maybeHistoryQuestion('मेरे सिर में दर्द हो रहा है');
  assert(!(second && DURATION.test(second)), 'the once-per-call cap broke');
});

ok('a real duration answer still advances, as before', () => {
  const x = h();
  const out = x._maybeHistoryQuestion('दो दिन से');
  assert(!(out && DURATION.test(out)), `re-asked on a valid duration answer: ${out}`);
});

ok('the denial pattern carries no ASCII word-boundary', () => {
  // \b is ASCII-only and never fires after Devanagari: /तकलीफ़ नहीं\b/ is FALSE
  // against "तकलीफ़ नहीं है". The first draft had one and matched nothing at
  // all, which every test above passed straight through until they drove the
  // real method. Asserted on the SOURCE deliberately — this is a property of
  // the pattern's text, not of any single input.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'callHandler.js'), 'utf8');
  const m = src.match(/const HISTORY_DENIAL_RE = (\/.*\/[a-z]*);/);
  assert(m, 'HISTORY_DENIAL_RE is gone');
  assert(!/\\b/.test(m[1]), `the denial pattern grew a \\b — it will silently stop matching Devanagari: ${m[1]}`);
  // AND the form that actually shipped: a LITERAL backspace, U+0008. Written in
  // by a tool where "\\b" inside a Python string is the control character, not
  // the two-character escape. It matched nothing, so every behavioural test
  // failed while the source LOOKED right — and a check for backslash-b reported
  // the file clean, twice. Byte, not glyph.
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(m[1]),
    'the denial pattern contains a control character — it will match nothing');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
