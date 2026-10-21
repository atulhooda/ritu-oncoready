#!/usr/bin/env node
// ─── THE FIRST CALL THIS REPO EVER HAD GROUND TRUTH FOR ─────────────────────
// CALL e370519a, 2026-08-15, Kannada. Audio pulled from Exotel and transcribed
// by two models outside the live loop. All three systems agree on the disputed
// turn:
//
//   Sarvam (production)  …ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ.   →  ಚಂದ್ರಶೇಖರ್.
//   gemini-3.5-flash     …ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ  ಚಂದ್ರಶೇಖರ್
//   gemini-2.5-flash     …ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ  ಚಂದ್ರಶೇಖರ್
//
// "AND MY NAME IS NOT RAJAMMA — CHANDRASHEKHAR." The STT heard it perfectly.
// Ritu apologised and used the right name aloud for the rest of the call. The
// appointment is still filed under ರಾಜಮ್ಮ.
//
// So the first measured split between vendor error and our error came out
// 0 / 1. Every "the STT got it wrong" instinct this project has run on was
// unverifiable until there was audio; the first time we checked, the STT was
// flawless and the defect was entirely ours.
//
// TWO FAILURES, ONE MISSING RULE.
//   · extractNameFromSpeech read "ರಾಜಮ್ಮ ಅಲ್ಲ" — the denied name plus the word
//     "not" — as a person's name. The same inversion fixed for allergies the
//     day before, in a different module, because "not" had no shared home.
//   · patientName is fill-only, so nothing could overturn a wrong name even
//     once the caller said it was wrong.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';

const assert = require('assert');
const { extractNameFromSpeech, deniesName, NEGATED_RE } = require('../nameGuard.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nNAME DENIAL — "my name is not X", checked against the audio\n');

// The disputed turn, exactly as each of the three systems rendered it.
const DENIALS = [
  'ಇದು ಒಂದು ಮೂರು ದಿನ ಇದೆ, ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ.',
  'ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ ಚಂದ್ರಶೇಖರ್',
  'ಇದೊಂದು ಮೂರು ದಿನದಿಂದ ಇದೆ ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ ಚಂದ್ರಶೇಖರ್',
];

ok('THE LIVE TURN: a denied name is not extracted as a name', () => {
  for (const s of DENIALS) {
    assert.strictEqual(extractNameFromSpeech(s), null,
      `extracted ${JSON.stringify(extractNameFromSpeech(s))} — the caller was saying this is NOT their name`);
  }
});

ok('THE LIVE TURN: it is recognised as a DENIAL, so the record can be corrected', () => {
  for (const s of DENIALS) {
    assert.strictEqual(deniesName(s), true, `deniesName missed: ${s.slice(0, 46)}`);
  }
});

ok('the denial is recognised in every language, not just Kannada', () => {
  const CASES = [
    'मेरा नाम सिद्धार्थ नहीं है', 'माझं नाव सरदार नाही',
    'my name is not Rajamma', 'আমার নাম আদিত্য নয়',
    'என் பெயர் முருகன் இல்லை', 'నా పేరు రవి కాదు',
    'ਮੇਰਾ ਨਾਮ ਗੁਰਪ੍ਰੀਤ ਨਹੀਂ', 'મારું નામ પ્રીતિ નથી',
    'എന്റെ പേര് രാമൻ അല്ല',
  ];
  for (const s of CASES) {
    assert.strictEqual(deniesName(s), true, `not seen as a denial: ${s}`);
    assert.strictEqual(extractNameFromSpeech(s), null, `extracted a name from a denial: ${s}`);
  }
});

// ── THE OTHER DIRECTION, WHICH IS THE ONE THAT COSTS A PATIENT ────────────
ok('AN ORDINARY NAME IS UNTOUCHED — a denial guard that eats real names is worse', () => {
  const CASES = [
    ['ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ.', 'ರಾಜಮ್ಮ'],
    ['मेरा नाम सिद्धार्थ है', 'सिद्धार्थ'],
    ['আমার নাম আদিত্য ঝা।', 'আদিত্য ঝা'],
    ['my name is Deekshitha', 'Deekshitha'],
    ['ನನ್ನ ಹೆಸರು ಚಂದ್ರಶೇಖರ್', 'ಚಂದ್ರಶೇಖರ್'],
  ];
  for (const [s, want] of CASES) {
    assert.strictEqual(deniesName(s), false, `a plain name read as a denial: ${s}`);
    assert.strictEqual(extractNameFromSpeech(s), want, `${s} -> ${JSON.stringify(extractNameFromSpeech(s))}`);
  }
});

// ── THE INDIC WORD-BOUNDARY TRAP ──────────────────────────────────────────
// JavaScript's \b is ASCII-shaped, so a negation word that is the PREFIX of a
// common ordinary word matches inside it. Both of these were live.
ok('Kannada ಇಲ್ಲಿ ("here") is not the word ಇಲ್ಲ ("no")', () => {
  assert(!NEGATED_RE.test('ಇಲ್ಲಿ'), 'ಇಲ್ಲಿ ("here") reads as a negation');
  assert(!NEGATED_RE.test('ಅಲ್ಲಿ'), 'ಅಲ್ಲಿ ("there") reads as a negation');
  assert(NEGATED_RE.test('ಇಲ್ಲ'), 'the actual word for "no" is no longer matched');
  assert(NEGATED_RE.test('ಅಲ್ಲ'), 'the actual copula negation is no longer matched');
});

ok('Bengali না does not fire inside নাম ("name")', () => {
  assert.strictEqual(deniesName('আমার নাম আদিত্য'), false,
    'the Bengali word for "name" contains the word for "no" and triggered a denial');
});

ok('THE ALLERGY REGRESSION THIS CAUSED: "there IS an allergy here" keeps the allergen', () => {
  // Shipped 2026-08-15, found 2026-08-16 while giving "not" one home. Kannada
  // ಇಲ್ಲಿ contains ಇಲ್ಲ, so a stated allergy was read as a denial and DROPPED.
  // A missed allergy is the dangerous direction.
  const { _splitMedsAndAllergens } = require('../callHandler.js');
  const r = _splitMedsAndAllergens('ಇಲ್ಲಿ penicillin ಅಲರ್ಜಿ ಇದೆ', { brands: true, max: 3 });
  assert.deepStrictEqual(r.allergens.map((a) => a.canonical), ['Penicillin'],
    'a stated allergy was dropped because "here" was read as "no"');
  // …and a real denial still drops it.
  const d = _splitMedsAndAllergens('penicillin ಅಲರ್ಜಿ ಇಲ್ಲ', { brands: true, max: 3 });
  assert.deepStrictEqual(d.allergens, [], 'a genuine denial no longer works');
});

// ── THE WIRING ────────────────────────────────────────────────────────────
ok('the call handler clears a denied name, and only on a denial', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(/if \(this\.patientName && deniesName\(trimmed\)\)/.test(src),
    'nothing clears a denied name — the first name still wins forever');
  assert(/this\.patientName = null;/.test(src), 'the clear was removed');
  // Fill-only must survive: overriding on mere DISAGREEMENT was measured wrong
  // on 7 of 7 production calls (script variants, and one garbled name the model
  // had already repaired). Only an explicit denial may overturn a name.
  assert(/if \(!this\.patientName\) \{[\s\S]{0,120}extractNameFromSpeech/.test(src),
    'the extractor no longer fills only when empty — it can now overwrite a good name');
});

ok('ONE definition of "not", shared by the name and allergy paths', () => {
  const ch = require('fs').readFileSync(require('path').join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(!/const ALLERGY_NEGATED_RE = \//.test(ch),
    'callHandler declares its own negation regex again — that is how the Indic ' +
    'lookahead fix reached one path and not the other');
  assert(/NEGATED_RE\.test\(probeClause\)/.test(ch), 'the allergy splitter stopped using the shared rule');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
