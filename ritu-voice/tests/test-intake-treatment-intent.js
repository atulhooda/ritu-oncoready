#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A CHEMICAL PEEL WAS BOOKABLE WITHOUT ANYONE ASKING ABOUT ALLERGIES.
//
// The deterministic intake machine starts on a SYMPTOM — specialtiesForSymptom
// over the caller's words. At an aesthetic clinic nobody presents a symptom:
// they ask about laser, a peel, a hydrafacial. Measured 2026-08-25 against the
// live gate at callHandler's `specialtiesForSymptom(probe).length === 0`:
//
//     "सर में दर्द हो रहा है"             → intake runs
//     "hydrafacial book karna hai"        → intake SKIPPED
//     "chemical peel ke baare mein batao" → intake SKIPPED
//
// and skipped means the medicine-and-allergy question never gets asked before
// the booking. No customisation was required to produce that; it is what the
// code did.
//
// The trigger now also fires on a treatment THE CLINIC ITSELF LISTS, read from
// its treatments table. Data-driven, so it cannot fire at a GP clinic (no rows,
// no match) and needs no per-clinic code.
//
// And it asks the RIGHT question: no "यह तकलीफ़ कब से है?" for someone enquiring
// about a hydrafacial — that is the wrong question, not merely an extra one.
//
// Run:            node tests/test-intake-treatment-intent.js
// Prove it fails: MUTANT=MUT-INTAKE-SYMPTOM-ONLY node tests/test-intake-treatment-intent.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'on', 'the pre-visit intake itself is under test; a booking-only profile turns it off (see test-previsit-intake-switch.js)');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.CLINIC_MODE = 'lean';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nINTAKE — a procedure enquiry is an intake trigger too\n');

const { CallHandler } = require('../callHandler.js');
const lean = require('../brain-lean.js');

// Skin Essence's five, per the signed form (the laser row was the form's own
// sample and is deliberately absent — see the spec's D5).
const TREATMENTS = [
  { name: 'Chemical peel' }, { name: 'Hydrafacial' }, { name: 'Wart removal' },
  { name: 'Tattoo removal' }, { name: 'Cryolipolysis' },
];
const loadTreatments = (rows) => Object.assign(lean._treatments(), { treatments: rows, text: rows.length ? 'x' : '' });

// A handler far enough along to drive the real _maybeHistoryQuestion: the
// method reads clinic mode, the booking flag, the stage, and the language.
function handler() {
  const h = Object.create(CallHandler.prototype);
  h._historyStage = 0;
  h.appointmentBooked = false;
  h._readbackPending = false;
  h._medRepeatPending = false;
  h.conversationHistory = [];
  h.callLanguage = 'gu-IN';
  h.hindiInCall = false;
  h._langCode = () => 'gu-IN';
  h._llmAlreadyAskedHistory = () => 0;
  if (MUTANT === 'MUT-INTAKE-SYMPTOM-ONLY') h._namesKnownTreatment = () => false;
  return h;
}
if (MUTANT === 'MUT-INTAKE-SYMPTOM-ONLY') console.log('  [MUTANT] MUT-INTAKE-SYMPTOM-ONLY — symptoms only, as before\n');

// ── [1] The measured skips now ask the allergy question ──────────────────
loadTreatments(TREATMENTS);
const ALLERGY_RE = /એલર્જી|एलर्जी|allerg/i;

for (const q of ['hydrafacial book karna hai', 'chemical peel ke baare mein batao', 'peel karwana hai', 'tattoo removal karwana hai']) {
  ok(`asks about medicines and allergies: "${q}"`, () => {
    const h = handler();
    const asked = h._maybeHistoryQuestion(q);
    assert.ok(asked, 'intake did not start — a booking could follow with no allergy question');
    assert.match(asked, ALLERGY_RE, `asked something else: ${asked}`);
  });
}

// ── [2] It asks the RIGHT question — not "how long have you had this" ─────
ok('a procedure enquiry is NOT asked how long it has troubled them', () => {
  const h = handler();
  const asked = h._maybeHistoryQuestion('hydrafacial book karna hai');
  assert.doesNotMatch(asked, /તકલીફ ક્યારથી|कब से|how long/i,
    `asked a symptom-duration question about a cosmetic procedure: ${asked}`);
});
ok('the stage advances past duration, so it is not asked next turn either', () => {
  const h = handler();
  h._maybeHistoryQuestion('hydrafacial book karna hai');
  assert.strictEqual(h._historyStage, 2, `stage is ${h._historyStage}, expected 2 (medicines/allergies)`);
});

// ── [3] THE GP PATH IS UNTOUCHED ─────────────────────────────────────────
ok('a real symptom still gets the duration question first', () => {
  const h = handler();
  h._langCode = () => 'hi-IN';
  const asked = h._maybeHistoryQuestion('सर में दर्द हो रहा है');
  assert.ok(asked, 'the symptom path stopped working');
  assert.match(asked, /कब से/, `expected the duration question: ${asked}`);
  assert.strictEqual(h._historyStage, 1);
});
ok('a clinic with NO treatments behaves exactly as before', () => {
  loadTreatments([]);
  const h = handler();
  assert.strictEqual(h._maybeHistoryQuestion('hydrafacial book karna hai'), null,
    'intake fired at a clinic that lists no treatments');
  loadTreatments(TREATMENTS);
});

// ── [4] It must not fire on everything ───────────────────────────────────
for (const q of ['mera naam Ramesh hai', 'kal aa sakta hoon kya', 'doctor kab available hain', 'address kya hai aapka']) {
  ok(`does not start intake on: "${q}"`, () => {
    const h = handler();
    assert.strictEqual(h._maybeHistoryQuestion(q), null, 'intake fired on a non-clinical turn');
  });
}

// ── [5] The matcher is a TREATMENT matcher, not a word matcher ───────────
// "removal" is seven characters and sits in two of the five names, so a
// length-only rule matched "laser hair removal" — which is not on this
// clinic's list — and would match any sentence containing the word.
ok('a generic word shared by two treatment names does not fire intake', () => {
  const h = handler();
  assert.strictEqual(h._namesKnownTreatment('wax removal karte ho '), false,
    '"removal" alone is matching — this is a word matcher, not a treatment matcher');
});
ok('a treatment NOT on the clinic list does not fire (the table is the truth)', () => {
  const h = handler();
  assert.strictEqual(h._namesKnownTreatment('laser hair removal kitne ka hai '), false,
    'matched a treatment the clinic has not listed');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
