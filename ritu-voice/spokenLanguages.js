// ═══════════════════════════════════════════════════════════════════════════
// THE ONE LIST OF LANGUAGES RITU SPEAKS
//
// WHY THIS FILE EXISTS. ENABLE_MULTILINGUAL took the product from three
// languages to eleven with a single flag. It could not take the CODE from three
// to eleven, because roughly a dozen tables each carried their own private copy
// of "which languages we speak" — and each had to be found and widened by hand.
// Most were not. MEASURED 2026-08-15, every one of these was live in production:
//
//     drug matcher (ಡೋಲೋ invisible)            2 of 11
//     sensitive-data guard                     2 of 11   <- answered an ENGLISH
//                                                           caller in MARATHI
//     allergy clause splitter (the comma bug)  3 of 11
//     read-back question                       4 of 11
//     yes / no recognition                     4 of 11
//     MED_NAME_REASK                           4 of 11
//
// Those look like six bugs. They are one decision's shadow, six times, and the
// list of places to change was knowable the whole time — it just did not exist
// anywhere. This file is that list.
//
// A MISSING LANGUAGE IS NEVER A CRASH, WHICH IS EXACTLY THE PROBLEM. Every one
// of these tables is read as `table[lang] || table['hi-IN']`, so a gap degrades
// silently into Hindi text — which is then handed to TTS with the CALLER'S
// pinned language code and the caller's voice. Devanagari, read aloud by the
// Bengali speaker. Nothing throws, nothing logs, and no test that checks "did
// it return a string" can see it.
//
// tests/test-language-coverage.js walks the repo and fails when any spoken
// table covers fewer than this list. Adding language twelve should be one entry
// here plus a red test naming every file to update — not an archaeology dig.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// Ordered: the clinic's live three first, then the rest. `od-IN` is what this
// repo has always used for Odia; ISO would say `or-IN`, and both are accepted
// wherever a code is parsed, but this is the canonical spelling here.
const SPOKEN_LANGUAGES = [
  'hi-IN', 'mr-IN', 'kn-IN', 'en-IN',
  'pa-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'ml-IN', 'od-IN',
];

// The Unicode block each language writes in, for the "is this string in the
// script we are about to speak it in?" check (devanagari.js toSpeakableScript).
// en-IN is Latin and therefore has no Brahmic block — null, not absent, so a
// lookup miss is distinguishable from "this one is legitimately Latin".
const SCRIPT_BLOCK = {
  'hi-IN': 0x0900, 'mr-IN': 0x0900,
  'bn-IN': 0x0980, 'pa-IN': 0x0A00, 'gu-IN': 0x0A80,
  'od-IN': 0x0B00, 'ta-IN': 0x0B80, 'te-IN': 0x0C00,
  'kn-IN': 0x0C80, 'ml-IN': 0x0D00,
  'en-IN': null,
};

const SPOKEN_SET = new Set(SPOKEN_LANGUAGES);

/** Which of the eleven a table is missing. Empty array means full coverage. */
function missingLanguages(table) {
  const have = new Set(Object.keys(table || {}));
  return SPOKEN_LANGUAGES.filter((l) => !have.has(l));
}

/** True when `code` is a language Ritu actually speaks. */
function isSpoken(code) {
  return SPOKEN_SET.has(String(code || ''));
}

module.exports = { SPOKEN_LANGUAGES, SCRIPT_BLOCK, SPOKEN_SET, missingLanguages, isSpoken };
