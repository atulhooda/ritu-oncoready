#!/usr/bin/env node
// ─── AN ALLERGY IS NOT A PRESCRIPTION ───────────────────────────────────────
// VERIFIED BY EXECUTION against the shipped modules, 2026-08-10:
//
//   findAllDrugMentions("मुझे penicillin से allergy hai")  ->  ["Penicillin"]
//   readbackLine('meds','Penicillin','hi-IN')
//       ->  "आप Penicillin ले रहे हैं — मैंने सही सुना ना?"
//           ("You are TAKING Penicillin — did I hear that right?")
//
// A patient discloses a penicillin allergy. Ritu reads it back as a CURRENT
// MEDICATION. They answer "हाँ" — truthfully, because she asked whether she
// heard the NAME right — and it is stored as a drug they take.
//
// AND NOTHING CAN HOLD THE TRUTH: `grep -rin allerg db/migrations` returns zero
// across all eight migrations. patient_medications has no entity_type, no
// status, nowhere to say "this is an allergen". Migration 007 calls `canonical`
// "the only field that should ever be treated as clinical" and indexes it as
// "this patient's current medications". So the pre-visit view tells a doctor
// this patient TOLERATES a beta-lactam.
//
// A stopped-drug row makes a doctor ask a question. This one makes them stop
// asking. It then compounds — the confirmed row is fed back as a matcher prior
// on the NEXT call at PRIOR_MAX_DIST 0.50, twice the general bar, under a
// comment claiming "the worst case is echoing back a molecule they really do
// take". Which is exactly false here.
//
// ROOT CAUSE: the question asks two clinically OPPOSITE things in one slot —
// "कोई दवाई चल रही है या कोई एलर्जी है जी?" — and findAllDrugMentions is a
// bag-of-candidates scan with no clause or polarity scoping.
//
// WHAT THIS FIX DOES, AND DELIBERATELY DOES NOT DO. It suppresses the med
// read-back for an allergen, turning a confidently WRONG row into a missing
// one. It does NOT route to the allergy read-back, even though the copy already
// exists and is already translated (readback.js:1263, `आपको ${v} से एलर्जी है —
// सही?`) and readbackLine already dispatches on entityType. Speaking that line
// without a column to store the answer would be WORSE: the patient would
// confirm "yes, I'm allergic" and it would still persist as a medication. The
// copy stays unreachable until migration 009 gives it somewhere to land.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'on', 'the pre-visit intake itself is under test; a booking-only profile turns it off (see test-previsit-intake-switch.js)');
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';           // the meds stage is scoped to lean
// READBACK defaults to 'off' when the env var is unset, and with it off NOTHING
// is queued and every assertion below passes vacuously — the first run of this
// file reported the allergy defect as already fixed for exactly that reason.
// Production HAS it on: patient_medications carries rows, including one from
// 2026-08-08 reading  unverified | dentist  — the dentist-as-a-drug bug sitting
// in a real patient record.
process.env.READBACK = 'on';
const CallHandler = require('../callHandler.js');
const { findAllDrugMentions } = require('../readback.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

function handler() {
  const h = new CallHandler('allergy_test', '+919876543210', { readyState: 1, send: () => {} }, 'test', false);
  h.speak = async () => {}; h._speakSentence = async () => {}; h._sendMark = () => {};
  h._historyStage = 2;                       // Ritu has just asked the meds/allergy question
  h._readbackPending = null; h._medRepeatPending = null;
  h.appointmentBooked = false;
  return h;
}
// Does it queue a MEDICATION read-back? Type-aware on purpose: an allergen now
// queues an ALLERGY read-back, so a bare check of `.canonical` would report the
// fix as broken while it is in fact working correctly.
const queuesMed = (text) => {
  const h = handler();
  h._maybeHistoryQuestion(text);
  const p = h._readbackPending;
  return p && p.type === 'meds' ? p.canonical : null;
};
// And what it queues as an ALLERGY, which is the half that used to be lost.
const queuesAllergy = (text) => {
  const h = handler();
  h._maybeHistoryQuestion(text);
  const p = h._readbackPending;
  return p && p.type === 'allergy' ? p.canonical : null;
};

console.log('\nALLERGY — must never be recorded as a medication\n');

ok('THE LIVE DEFECT: a penicillin allergy is not queued as a medication', () => {
  assert.strictEqual(queuesMed('मुझे penicillin से allergy hai'), null,
    'a declared ALLERGY is about to be read back as "you are taking Penicillin" and stored as a drug');
});

ok('every spelling of allergy this system already knows', () => {
  // Same vocabulary HISTORY_MEDS_ASKED_RE already carries — no new words invented.
  for (const s of ['दवाई कोई नहीं, पर मुझे sulfa से एलर्जी है',
                   'I am allergic to penicillin',
                   'मला penicillin ची अ‍ॅलर्जी आहे',
                   'penicillin से अलर्जी है']) {
    assert.strictEqual(queuesMed(s), null, `still records an allergen as a medication: ${s}`);
  }
});

ok('THE GUARD IT MUST NOT BREAK: a plain medication answer still records', () => {
  // The whole point of this stage. Losing it would trade one failure for another.
  assert.strictEqual(queuesMed('मैं Metformin लेता हूँ'), 'Metformin',
    'the meds read-back stopped working — that is the regression that matters');
});

ok('a medication and an allergy in SEPARATE clauses: the medication survives', () => {
  // Clause-scoped, not utterance-scoped. Dropping the whole turn would lose a
  // real current medication, which is a capture loss we do not have to take.
  const got = queuesMed('मैं Telma लेता हूँ। मुझे penicillin से एलर्जी है।');
  assert.strictEqual(got, 'Telmisartan',
    `a genuine current medication was dropped because an allergy shared the utterance: ${got}`);
});

ok('the allergen from that same utterance is NOT what gets recorded', () => {
  const h = handler();
  h._maybeHistoryQuestion('मैं Telma लेता हूँ। मुझे penicillin से एलर्जी है।');
  const p = h._readbackPending;
  const names = p ? [p.canonical, p.second && p.second.canonical].filter(Boolean) : [];
  assert(!names.some((n) => /penicillin/i.test(n)),
    `the allergen rode along as the runner-up: ${JSON.stringify(names)}`);
});

ok('"no medicines" still resolves to nothing — the दवाई fix is intact', () => {
  for (const s of ['कोई दवाई नहीं', 'नहीं जी']) {
    assert.strictEqual(queuesMed(s), null, `invented a medication from: ${s}`);
  }
});

// ── the sibling defect found in the same investigation ──────────────────────
console.log('\n"STOPPED" IS NOT A COUGH SUPPRESSANT\n');

ok('the word "stopped" no longer resolves to a brand', () => {
  // VERIFIED live: "I stopped taking Metformin last month" returned
  //   ["metformin/Metformin", "stopped/Dextromethorphan Hydrobromide"]
  // because `stopped` fuzzy-matches the registered brand `stopper`. Same class
  // as दवाई -> Dapagliflozin (f658e7a): an ordinary word every patient says,
  // hitting the 116k brand index. One "हाँ" persists a cough suppressant.
  const got = findAllDrugMentions('I stopped taking Metformin last month', { brands: true })
    .map((d) => d.canonical);
  assert(!got.some((c) => /dextromethorphan/i.test(c)),
    `"stopped" still resolves to a drug: ${JSON.stringify(got)}`);
  assert(got.includes('Metformin'), `and the REAL drug must survive: ${JSON.stringify(got)}`);
});

ok('other ordinary stop/start words are clean too', () => {
  for (const s of ['I stop the medicine', 'दवाई बंद कर दी', 'stopping it now']) {
    const got = findAllDrugMentions(s, { brands: true }).map((d) => d.canonical);
    assert.deepStrictEqual(got, [], `invented a drug from an ordinary word: "${s}" -> ${JSON.stringify(got)}`);
  }
});

// ── the half that was previously thrown away ────────────────────────────────
console.log('\nAND THE ALLERGY IS NOW CAPTURED, NOT JUST DROPPED\n');

ok('an allergy is confirmed AS an allergy, in the caller\'s language', () => {
  assert.strictEqual(queuesAllergy('मुझे penicillin से allergy hai'), 'Penicillin',
    'the allergy is still being discarded — clinically important information the patient volunteered');
});

ok('it carries entityType so it can never persist as a medication', () => {
  // saveConfirmedMedication maps entityType -> the entity_type column added in
  // migration 009, and getPatientMedications filters the matcher prior to
  // entity_type='medication'. Without this field an allergen re-enters the
  // prior at PRIOR_MAX_DIST 0.50 and biases the matcher toward the one drug
  // the patient cannot have.
  const h = handler();
  h._maybeHistoryQuestion('मुझे penicillin से allergy hai');
  assert.strictEqual(h._readbackPending.entityType, 'allergy',
    'the pending row has no entityType — it will be written as a medication');
});

ok('a drug named as BOTH taken and allergic resolves to allergy', () => {
  // "मैं Telma लेता हूँ पर Telma से एलर्जी है" is a contradiction. The safe
  // reading of a contradiction about a drug is the one that withholds it.
  assert.strictEqual(queuesMed('मैं Telma लेता हूँ पर Telma से एलर्जी है'), null,
    'a contradicted drug was still recorded as a current medication');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
