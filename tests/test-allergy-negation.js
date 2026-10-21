#!/usr/bin/env node
// ─── "I TOOK A DOLO, NO ALLERGY" WAS RECORDED AS AN ALLERGY TO DOLO ─────────
// LIVE CALL aa545e2c5a7392cd33f94763a7c61a8f, 2026-08-15, Kannada caller
// answering the pre-visit meds/allergy question:
//
//     PATIENT  ಒಂದು ಡೋಲೋ 650 ತಗೊಂಡಿದ್ದೆ, ಅಲರ್ಜಿ ಏನಿಲ್ಲ.
//              ("I took a Dolo 650, no allergy")
//     RITU     ನಿಮಗೆ Dolo ನಿಂದ ಅಲರ್ಜಿ ಇದೆ — ಸರಿಯೇ?
//              ("you are ALLERGIC to Dolo — correct?")
//     PATIENT  ಇಲ್ಲ, ಡೋಲೋ 650 ತಗೊಂಡೆ. ಆ ತರ ಏನು ಅಲರ್ಜಿ ಇಲ್ಲ ನನಗೆ.
//              ("no, I TOOK Dolo 650. I have no such allergy")
//     RITU     [asked the identical meds/allergy question again] -> caller hung up
//
// The caller redialled 89 seconds later and completed the booking, so the
// defect cost a call outright.
//
// TWO CAUSES, BOTH REAL:
//
//  1. THE SEPARATOR WAS A COMMA. ALLERGY_CLAUSE_SPLIT split on [?।.!] and on
//     Hindi/Marathi/English conjunctions only. A comma is none of those and
//     neither is Kannada ಆದರೆ — so the whole sentence was ONE clause,
//     ALLERGY_RE matched the word ಅಲರ್ಜಿ in it, and every drug in the sentence
//     went to the allergen bucket. The drug matcher was opened to nine scripts
//     in be5e99d; this splitter stayed at two, so nine languages could reach it
//     and only two could be split.
//
//  2. NEGATION WAS NEVER CHECKED. ALLERGY_RE fires on the WORD "allergy", so a
//     clause DENYING one is indistinguishable from one declaring it.
//
// WHY THIS IS THE WORST CLASS OF DEFECT IN THIS SYSTEM. An inverted allergy is
// not a smaller version of a missing one. It makes a doctor withhold a drug the
// patient tolerates, AND it hides the drug they are actually taking from the
// interaction check. The record says the exact opposite of what the patient said.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';

const assert = require('assert');
const { _splitMedsAndAllergens } = require('../callHandler.js');

const OPTS = { brands: true, max: 3 };
const split = (t) => {
  const r = _splitMedsAndAllergens(t, OPTS);
  return {
    meds: r ? r.meds.map((m) => m.canonical) : null,
    allergens: r ? r.allergens.map((a) => a.canonical) : null,
  };
};

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nALLERGY NEGATION — a denied allergy is not an allergy\n');

// ── 1. THE LIVE UTTERANCE ───────────────────────────────────────────────────
ok('THE LIVE CALL: "I took a Dolo 650, no allergy" records a MEDICATION', () => {
  const r = split('ಒಂದು ಡೋಲೋ 650 ತಗೊಂಡಿದ್ದೆ, ಅಲರ್ಜಿ ಏನಿಲ್ಲ.');
  assert.deepStrictEqual(r.allergens, [],
    `Dolo was filed as an ALLERGEN — this is the inversion that was spoken back to the caller`);
  assert.deepStrictEqual(r.meds, ['Paracetamol'],
    `the drug the patient actually takes was lost: got ${JSON.stringify(r.meds)}`);
});

ok('THE CORRECTION TURN is also read correctly', () => {
  // What the caller said next, trying to fix it. It must not re-assert the
  // allergy either.
  const r = split('ಇಲ್ಲ, ಡೋಲೋ 650 ತಗೊಂಡೆ. ಆ ತರ ಏನು ಅಲರ್ಜಿ ಇಲ್ಲ ನನಗೆ.');
  assert.deepStrictEqual(r.allergens, [], `the correction still produced an allergen`);
});

// ── 2. A DENIAL NAMING A DRUG RECORDS NOTHING ──────────────────────────────
ok('"no penicillin allergy" records NEITHER an allergen NOR a medication', () => {
  // Not an allergen (they said they do not react) and not a medication either
  // (naming a drug you are NOT allergic to is not a statement that you take it).
  for (const s of [
    'penicillin ಅಲರ್ಜಿ ಇಲ್ಲ',
    'मुझे penicillin से एलर्जी नहीं है',
    'I have no penicillin allergy',
  ]) {
    const r = split(s);
    assert.deepStrictEqual(r.allergens, [], `${s} -> allergen ${JSON.stringify(r.allergens)}`);
    assert.deepStrictEqual(r.meds, [], `${s} -> medication ${JSON.stringify(r.meds)}`);
  }
});

// ── 3. REAL ALLERGIES MUST STILL BE CAUGHT ─────────────────────────────────
// The failure mode of an over-eager negation guard is a DROPPED allergy, which
// is the more dangerous direction. These are the guard rails.
ok('a real allergy is still recorded, in every script that can reach here', () => {
  const CASES = [
    ['मुझे penicillin से एलर्जी है',      'Penicillin'],
    ['ನನಗೆ penicillin ಅಲರ್ಜಿ ಇದೆ',        'Penicillin'],
    ['I am allergic to penicillin',       'Penicillin'],
  ];
  for (const [s, want] of CASES) {
    const r = split(s);
    assert.deepStrictEqual(r.allergens, [want], `${s} -> ${JSON.stringify(r.allergens)}`);
  }
});

ok('a med and an allergy in one breath still separate', () => {
  const r = split('मैं Telma लेता हूँ और penicillin से एलर्जी है');
  assert.deepStrictEqual(r.meds, ['Telmisartan']);
  assert.deepStrictEqual(r.allergens, ['Penicillin']);
});

ok('THE NEGATION IS SCOPED TO ITS CLAUSE, not the whole sentence', () => {
  // The negation belongs to the SECOND clause. Applying it sentence-wide would
  // drop a real allergy — the dangerous direction.
  const r = split('मुझे penicillin से एलर्जी है, कोई और दवा नहीं ले रहा');
  assert.deepStrictEqual(r.allergens, ['Penicillin'],
    'a negation in a LATER clause erased the allergy declared in the first');
});

ok('a denial and a real allergy in one breath resolve independently', () => {
  const r = split('penicillin ಅಲರ್ಜಿ ಇಲ್ಲ, ಆದರೆ Dolo ಅಲರ್ಜಿ ಇದೆ');
  assert.deepStrictEqual(r.allergens, ['Paracetamol'],
    `expected only the REAL allergy: got ${JSON.stringify(r.allergens)}`);
});

// ── 4. THE CONTRADICTION RULE IS UNCHANGED ─────────────────────────────────
ok('a contradiction still withholds the drug (pre-existing safety rule)', () => {
  const r = split('मैं Telma लेता हूँ पर Telma से एलर्जी है');
  assert.deepStrictEqual(r.allergens, ['Telmisartan']);
  assert.deepStrictEqual(r.meds, [], 'a contradicted drug must not remain in meds');
});

// ── 5. THE ORDINARY PATH IS UNTOUCHED ──────────────────────────────────────
ok('no allergy word anywhere -> null, so the common turn never enters here', () => {
  for (const s of ['ಬರೀ ಡೋಲೋ 650 ತಗೊಂತಾ ಇದ್ದೀನಿ.', 'मैं Telma लेता हूँ', 'ನನಗೆ ತಲೆನೋವು ಇದೆ']) {
    assert.strictEqual(_splitMedsAndAllergens(s, OPTS), null, `${s} entered the allergy path`);
  }
});

// ── 6. THE COMMA, AND THE NINE LANGUAGES THAT HAD NO CONJUNCTION ───────────
ok('the comma separates clauses', () => {
  const r = split('मैं Telma लेता हूँ, penicillin से एलर्जी है');
  assert.deepStrictEqual(r.meds, ['Telmisartan'], 'the comma did not split the clause');
  assert.deepStrictEqual(r.allergens, ['Penicillin']);
});

ok('each Indic conjunction separates clauses, not just the Hindi ones', () => {
  // Before this fix the list was और/आणि/पण/पर/लेकिन/परंतु/मात्र/तरी/but/and —
  // Hindi, Marathi and English. Every other language fell through as one clause
  // and had its medication reclassified as an allergen.
  const CASES = [
    ['ನಾನು Telma ತಗೊಳ್ತೀನಿ ಆದರೆ penicillin ಅಲರ್ಜಿ ಇದೆ', 'kn ಆದರೆ'],
    ['আমি Telma নিই কিন্তু penicillin এ অ্যালার্জি আছে',   'bn কিন্তু'],
    ['நான் Telma எடுக்கிறேன் ஆனால் penicillin அலர்ஜி',     'ta ஆனால்'],
  ];
  for (const [s, label] of CASES) {
    const r = split(s);
    assert.deepStrictEqual(r.allergens, ['Penicillin'], `${label}: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.meds, ['Telmisartan'],
      `${label}: the medication was swallowed into the allergy clause — ${JSON.stringify(r)}`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
