#!/usr/bin/env node
// ─── THE MATCHER SPOKE TWO OF ELEVEN LANGUAGES ──────────────────────────────
// LIVE KANNADA CALL 7da9c84c721c65611c9f27ae7bd21a8f, 2026-08-15:
//
//     PATIENT  ಇಲ್ಲ ಸದ್ಯಕ್ಕೆ ಏನೂ ತಗೊಂಡಿಲ್ಲ ಬಟ್ ರಾತ್ರಿ ನಾನೊಂದು ಡೋಲೋ ತಗೊಂಡಿದ್ದೆ.
//              ("nothing at the moment, but I took a Dolo last night")
//     RITU     ಸರಿ ದೀಕ್ಷಿತ ಜಿ, ಅರ್ಥವಾಯಿತು.
//
// Transcribed perfectly. Recorded nowhere. Not a read-back failure — the
// matcher never saw a drug at all. MEASURED the same day:
//
//     dolo -> Paracetamol     डोलो -> Paracetamol
//     ಡೋಲೋ -> nothing         ডোলো -> nothing      … and six more scripts
//
// readback.js romanized on `hasDevanagari(text)`, so Kannada, Bengali, Tamil,
// Telugu, Punjabi, Gujarati, Malayalam and Odia fell straight past the gate.
// Nine of eleven languages had NO clinical capture, and no read-back, prior or
// confirmation could help because nothing was ever detected. It also means the
// 46.2% capture figure was only ever a Hindi/Marathi number.
//
// THE FIX WAS ALREADY IN THE CODEBASE, TWICE — callHandler.js (~143) and
// emergencyDetectorV2.js:98 both carry the Brahmic block-shift, written for
// emergency detection and the allergy regex. The drug matcher, the thing this
// product is measured on, never got it. Fifth duplicated rule this month.
//
// TAMIL IS EXPECTED TO BE WEAKER and is asserted separately rather than hidden:
// Tamil has no voiced/aspirated distinction, so டோலோ romanizes to "tolo" and
// மெட்ஃபார்மின் to something further still. Recovering Tamil needs a phonetic
// pass, not a transliteration one. Saying so here stops the next person reading
// "9 scripts supported" and believing Tamil works.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { findAllDrugMentions } = require('../readback.js');
const { toDevanagari, hasIndic } = require('../devanagari.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nINDIC DRUG SCRIPTS — a drug named in any script is still a drug\n');

const finds = (text, want) =>
  findAllDrugMentions(text, { brands: true, max: 2 })
    .some((d) => d.canonical.toLowerCase().includes(want.toLowerCase().slice(0, 6)));

// ── 1. THE LIVE UTTERANCE ───────────────────────────────────────────────────
ok('THE LIVE CALL: "ಡೋಲೋ" in a Kannada sentence resolves to Paracetamol', () => {
  assert(finds('ಇಲ್ಲ ಸದ್ಯಕ್ಕೆ ಏನೂ ತಗೊಂಡಿಲ್ಲ ಬಟ್ ರಾತ್ರಿ ನಾನೊಂದು ಡೋಲೋ ತಗೊಂಡಿದ್ದೆ.', 'Paracetamol'),
    'the exact sentence from call 7da9c84c still finds no drug');
});

// ── 2. the scripts that must work ───────────────────────────────────────────
// Tamil is deliberately absent — see the header, and the explicit case below.
const DOLO = {
  Latin: 'dolo', Devanagari: 'डोलो', Kannada: 'ಡೋಲೋ', Bengali: 'ডোলো',
  Telugu: 'డోలో', Punjabi: 'ਡੋਲੋ', Gujarati: 'ડોલો', Malayalam: 'ഡോലോ', Odia: 'ଡୋଲୋ',
};
for (const [script, text] of Object.entries(DOLO)) {
  ok(`${script}: "${text}" -> Paracetamol`, () => {
    assert(finds(text, 'Paracetamol'), `${script} still misses — the block shift did not reach it`);
  });
}

// ── 3. real molecules, not just the one brand ──────────────────────────────
ok('a molecule name in Kannada resolves (Metformin, Cetirizine)', () => {
  assert(finds('ಮೆಟ್ಫಾರ್ಮಿನ್', 'Metformin'), 'Kannada Metformin missed');
  assert(finds('ಸೆಟಿರಿಜಿನ್', 'Cetirizine'), 'Kannada Cetirizine missed');
});

ok('a molecule name in Bengali resolves', () => {
  assert(finds('মেটফরমিন', 'Metformin'), 'Bengali Metformin missed');
});

// ── 4. Latin and Devanagari must not regress ───────────────────────────────
// The change rewrites `text` before matching; if that broke the two scripts
// that already worked it would be a net loss.
ok('Latin and Devanagari are unchanged', () => {
  assert(finds('dolo', 'Paracetamol'), 'Latin regressed');
  assert(finds('मुझे डोलो दिया था', 'Paracetamol'), 'Devanagari regressed');
  assert(finds('I take Metformin daily', 'Metformin'), 'Latin molecule regressed');
});

ok('ordinary speech still finds no drug', () => {
  // The block shift must not turn innocent Indic text into drug names.
  for (const s of ['ನನಗೆ ಜ್ವರ ಫೀಲ್ ಆಗ್ತಿದೆ', 'আমার মাথা ব্যথা করছে', 'मेरे सर में दर्द है']) {
    const hits = findAllDrugMentions(s, { brands: true, max: 2 }).map((d) => d.canonical);
    assert.deepStrictEqual(hits, [], `invented ${hits.join(',')} from "${s}"`);
  }
});

// ── 5. what is NOT fixed, asserted so it cannot be quietly assumed ─────────
ok('TAMIL IS STILL WEAK, and that is recorded rather than hidden', () => {
  // Tamil lacks the voiced/unvoiced distinction: டோலோ -> "tolo". If a future
  // change makes this pass, delete this test and celebrate — but nobody should
  // read "all Indic scripts" and assume Tamil until then.
  const got = finds('டோலோ', 'Paracetamol');
  assert.strictEqual(got, false,
    'Tamil now resolves — that is good news; update the header and remove this case');
});

// ── 5b. THE PRECOMPOSED NUKTA LETTERS ──────────────────────────────────────
// Devanagari spells क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़ two ways — base + combining nukta, or a
// single precomposed codepoint (U+0958-095F). Only the first was handled; the
// second fell through the romanizer as raw Devanagari.
//
// MEASURED on production 2026-08-15, in the backfill meant to give the desk
// readable names:
//     আমন নাম্বারিয়া  ->  "Aman Nambariय़a"
// Bengali য় is precomposed (U+09DF), the block shift lands it on U+095F, and it
// came out untouched in the middle of a Latin name a receptionist was to read.
// Reachable from all nine scripts now that the block shift exists, not just
// Hindi.
ok('a precomposed nukta letter romanizes the same as its decomposed twin', () => {
  const { romanize } = require('../devanagari.js');
  for (const c of [0x0958, 0x0959, 0x095A, 0x095B, 0x095C, 0x095D, 0x095E, 0x095F]) {
    const pre = String.fromCodePoint(c);
    const dec = pre.normalize('NFD');
    const rp = romanize(pre), rd = romanize(dec);
    assert(/^[a-z]+$/.test(rp),
      `U+0${c.toString(16).toUpperCase()} romanized to ${JSON.stringify(rp)} — Devanagari leaked into Latin output`);
    assert.strictEqual(rp, rd,
      `the two spellings of the same letter disagree: precomposed ${JSON.stringify(rp)} vs decomposed ${JSON.stringify(rd)}. ` +
      `A name romanized one way on write and another on read stops matching itself.`);
  }
});

ok('THE LIVE ROW: the Bengali name comes out as clean Latin', () => {
  const { latinFormOf } = require('../patientIdentity.js');
  for (const form of ['আমন নাম্বারিয়া', 'আমন নাম্বারিয়া'.normalize('NFD')]) {
    const got = latinFormOf(form);
    assert.strictEqual(got, 'Aman Nambariya',
      `got ${JSON.stringify(got)} — this is the row that produced "Aman Nambariय़a" on the desk`);
  }
});

// ── 5c. THE HAND-LIST ONLY KNEW EIGHT OF ELEVEN ────────────────────────────
// PRECOMPOSED_NUKTA was written from the U+0958–095F range, because that is the
// range you find when you go looking for "precomposed nukta". Devanagari has
// ELEVEN: U+0929 ऩ, U+0931 ऱ and U+0934 ऴ carry canonical decompositions too and
// were in no table, so they fell through romanizeChar as raw Devanagari.
//
// AND THEY ARE THE SLOTS TAMIL AND MALAYALAM LAND ON. Tamil ன ற ழ and Malayalam
// റ ഴ block-shift onto exactly those three. MEASURED before the fix:
//     தமிழ் ("Tamil") -> "tamiऴ"        വഴി ("way") -> "vऴi"
// ழ is the letter in the word Tamil. This was found while searching prior art
// for a patent filing, which is a poor way to find production defects.
ok('ALL ELEVEN Devanagari nukta letters romanize to Latin, both spellings', () => {
  const { romanize } = require('../devanagari.js');
  for (const cp of [0x0929, 0x0931, 0x0934, 0x0958, 0x0959, 0x095A, 0x095B, 0x095C, 0x095D, 0x095E, 0x095F]) {
    const pre = String.fromCodePoint(cp), dec = pre.normalize('NFD');
    const rp = romanize(pre), rd = romanize(dec);
    assert(/^[a-z]+$/.test(rp),
      `U+0${cp.toString(16).toUpperCase()} romanized to ${JSON.stringify(rp)} — Devanagari leaked into Latin`);
    assert.strictEqual(rp, rd, `U+0${cp.toString(16).toUpperCase()}: the two spellings disagree`);
  }
});

ok('THE LIVE WORDS: Tamil and Malayalam text carries no raw Devanagari out', () => {
  const { romanize, toDevanagari } = require('../devanagari.js');
  const CASES = [['தமிழ்', 'tamil'], ['வഴി', 'vali'], ['மருந்து', 'maruntu']];
  for (const [src, want] of CASES) {
    const got = romanize(toDevanagari(src));
    assert(!/[ऀ-ॿ]/.test(got), `${src} -> ${JSON.stringify(got)} still contains Devanagari`);
    assert.strictEqual(got, want, `${src} -> ${JSON.stringify(got)}`);
  }
});

// ── 5d. MALAYALAM CHILLUS: THE ONE CASE UNICODE WILL NOT DECOMPOSE ─────────
// A chillu is a consonant with no inherent vowel — the form nearly every
// Malayalam name ends in. Encoded ATOMICALLY in Unicode 5.1 with no canonical
// decomposition, so NFD cannot reach them, and the block shift sends them to
// U+097A–097F, unrelated rare Devanagari letters. കുഞ്ഞിരാമൻ came out as
// "Kunniramॻ" — a Devanagari letter at the end of a name on the desk.
ok('a chillu-final Malayalam name romanizes clean', () => {
  const { latinFormOf } = require('../patientIdentity.js');
  const NAMES = [
    ['കുഞ്ഞിരാമൻ', 'Kunniraman'], ['രാമൻ', 'Raman'],
    ['ഗോപാൽ', 'Gopal'], ['സുധീർ', 'Sudhir'], ['അനിൽ', 'Anil'],
  ];
  for (const [src, want] of NAMES) {
    const got = latinFormOf(src);
    assert(!/[ऀ-෿]/.test(String(got)), `${src} -> ${JSON.stringify(got)} leaked a non-Latin letter`);
    assert.strictEqual(got, want, `${src} -> ${JSON.stringify(got)}`);
  }
});

ok('every chillu maps to its base consonant, not to a rare Devanagari letter', () => {
  const { toDevanagari } = require('../devanagari.js');
  // U+097A–097F is where an unmapped chillu would land.
  for (const c of ['ൺ', 'ൻ', 'ർ', 'ൽ', 'ൾ', 'ൿ']) {
    const dev = toDevanagari(c);
    assert(!/[ॺ-ॿ]/.test(dev),
      `${c} block-shifted to ${dev} — an unrelated Devanagari letter, not its consonant`);
  }
});

// ── 6. the primitive itself ────────────────────────────────────────────────
ok('toDevanagari maps every Brahmic block, and leaves Latin alone', () => {
  assert.strictEqual(toDevanagari('ಡೋಲೋ'), 'डोलो');
  assert.strictEqual(toDevanagari('ডোলো'), 'डोलो');
  assert.strictEqual(toDevanagari('dolo'), 'dolo', 'Latin must pass through untouched');
  assert.strictEqual(toDevanagari('डोलो'), 'डोलो', 'Devanagari must be idempotent');
});

ok('hasIndic sees every script, and does not fire on Latin', () => {
  for (const s of ['डोलो', 'ಡೋಲೋ', 'ডোলো', 'டோலோ', 'ਡੋਲੋ', 'ડોલો', 'ഡോലോ', 'ଡୋଲୋ', 'డోలో']) {
    assert(hasIndic(s), `hasIndic missed ${s}`);
  }
  for (const s of ['dolo', 'Metformin', '', '123']) {
    assert(!hasIndic(s), `hasIndic fired on ${JSON.stringify(s)}`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
