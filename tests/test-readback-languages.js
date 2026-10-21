#!/usr/bin/env node
// ─── ASKING IN ELEVEN LANGUAGES AND UNDERSTANDING FOUR ──────────────────────
// The medication read-back is the one turn in the whole call where a caller's
// answer writes a drug into a clinical record. It spoke hi/mr/kn/en, and
// classified replies in hi/mr/kn/en, while ENABLE_MULTILINGUAL had made the
// product answer in eleven.
//
// TWO HALVES, AND THE SECOND IS THE DANGEROUS ONE.
//
//   readbackLine falls back to hi-IN, so a Bengali caller was asked to confirm
//   their medication in DEVANAGARI TEXT — which is then handed to TTS with the
//   CALLER'S pinned language code, i.e. Devanagari synthesised by the Bengali
//   voice (readback.js readbackLine -> callHandler _langCode -> streamTTS).
//
//   And then, whatever they answered:
//       "হ্যাঁ" (yes) matched no AFFIRM token -> 'unclear', not confirmed
//       "না"   (no)  matched no DENY token   -> 'unclear', AND THE WRONG DRUG
//                                               STAYS, because the denial that
//                                               would have removed it was never
//                                               recognised.
//
// Tokenization was never the problem: classifyReply splits on [a-zऀ-ൿ], which
// spans U+0900-U+0D7F and therefore every Brahmic block we speak. The
// vocabularies were simply short.
//
// THE LISTS ARE ASYMMETRIC ON PURPOSE, and this file asserts that asymmetry:
// a missed DENY leaves a mis-heard drug on the record, while a false DENY only
// discards a correct one and we ask again. A false AFFIRM is the worst case —
// it marks a WRONG drug verified and emits it as [READBACK-GOLD], a training
// label. So DENY is generous, AFFIRM is conservative.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { readbackLine, classifyReply } = require('../readback.js');

const LANGS = ['hi-IN', 'mr-IN', 'en-IN', 'kn-IN', 'pa-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'ml-IN', 'od-IN'];

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nREAD-BACK IN ELEVEN LANGUAGES — the turn that writes a drug down\n');

// ── 1. THE QUESTION EXISTS IN EVERY LANGUAGE ───────────────────────────────
// Asserted by NON-EQUALITY WITH HINDI, not by presence. readbackLine returns
// the Hindi line for a missing key, so "it returned a string" proves nothing —
// that is exactly the bug. Only "it differs from Hindi" catches a missing entry.
ok('no language silently falls back to the HINDI read-back', () => {
  for (const type of ['meds', 'meds2', 'allergy']) {
    const hi = readbackLine(type, 'Dolo', 'hi-IN', 'Telma');
    for (const lang of LANGS.filter((l) => l !== 'hi-IN')) {
      const got = readbackLine(type, 'Dolo', lang, 'Telma');
      assert.notStrictEqual(got, hi,
        `${type}/${lang} returned the HINDI line — the key is missing, and this string ` +
        `goes to TTS with ${lang}'s voice`);
    }
  }
});

ok('the drug name survives into every language, unaltered', () => {
  // The molecule is the payload. If a template drops it the caller is asked to
  // confirm nothing at all.
  for (const lang of LANGS) {
    assert(readbackLine('meds', 'Dolo 650', lang).includes('Dolo 650'), `meds/${lang} lost the drug`);
    assert(readbackLine('allergy', 'Penicillin', lang).includes('Penicillin'), `allergy/${lang} lost the drug`);
    const two = readbackLine('meds2', 'Dolo', lang, 'Telma');
    assert(two.includes('Dolo') && two.includes('Telma'), `meds2/${lang} lost a drug: ${two}`);
  }
});

ok('every read-back is a QUESTION — it asks the caller to confirm', () => {
  for (const type of ['meds', 'meds2', 'allergy']) {
    for (const lang of LANGS) {
      const s = readbackLine(type, 'Dolo', lang, 'Telma');
      assert(/[?？]$/.test(s.trim()), `${type}/${lang} does not end in a question mark: ${s}`);
    }
  }
});

ok('the script matches the language it will be spoken in', () => {
  // A Devanagari string sent to a Bengali voice is the defect itself. Checked
  // by block: the line must contain letters of its own script.
  const BLOCK = {
    'hi-IN': /[ऀ-ॿ]/, 'mr-IN': /[ऀ-ॿ]/,
    'bn-IN': /[ঀ-৿]/, 'pa-IN': /[਀-੿]/, 'gu-IN': /[઀-૿]/,
    'od-IN': /[଀-୿]/, 'ta-IN': /[஀-௿]/, 'te-IN': /[ఀ-౿]/,
    'kn-IN': /[ಀ-೿]/, 'ml-IN': /[ഀ-ൿ]/,
  };
  for (const [lang, re] of Object.entries(BLOCK)) {
    for (const type of ['meds', 'meds2', 'allergy']) {
      const s = readbackLine(type, 'Dolo', lang, 'Telma');
      assert(re.test(s), `${type}/${lang} contains no ${lang} letters: ${s}`);
    }
  }
});

// ── 2. THE ANSWER IS UNDERSTOOD ────────────────────────────────────────────
const YES = {
  'hi-IN': 'हाँ', 'mr-IN': 'होय', 'en-IN': 'yes', 'kn-IN': 'ಹೌದು', 'pa-IN': 'ਹਾਂ',
  'ta-IN': 'ஆமா', 'te-IN': 'అవును', 'bn-IN': 'হ্যাঁ', 'gu-IN': 'હા', 'ml-IN': 'അതെ', 'od-IN': 'ହଁ',
};
const NO = {
  'hi-IN': 'नहीं', 'mr-IN': 'नाही', 'en-IN': 'no', 'kn-IN': 'ಇಲ್ಲ', 'pa-IN': 'ਨਹੀਂ',
  'ta-IN': 'இல்லை', 'te-IN': 'లేదు', 'bn-IN': 'না', 'gu-IN': 'ના', 'ml-IN': 'ഇല്ല', 'od-IN': 'ନା',
};

ok('a YES is recognised in every language', () => {
  for (const [lang, word] of Object.entries(YES)) {
    assert.strictEqual(classifyReply(word).verdict, 'affirm',
      `${lang} "${word}" -> ${classifyReply(word).verdict}: the confirmation is lost`);
  }
});

ok('THE DANGEROUS ONE: a NO is recognised in every language', () => {
  // An unrecognised denial does not merely fail to record — it leaves the drug
  // Ritu MIS-HEARD sitting in the record, because the correction never landed.
  for (const [lang, word] of Object.entries(NO)) {
    assert.strictEqual(classifyReply(word).verdict, 'deny',
      `${lang} "${word}" -> ${classifyReply(word).verdict}: A MIS-HEARD DRUG WOULD SURVIVE THIS DENIAL`);
  }
});

ok('"I do not know" is unclear, not a yes and not a no, in every language', () => {
  const DK = {
    'hi-IN': 'पता नहीं', 'kn-IN': 'ಗೊತ್ತಿಲ್ಲ', 'pa-IN': 'ਪਤਾ ਨਹੀਂ', 'ta-IN': 'தெரியாது',
    'te-IN': 'తెలియదు', 'bn-IN': 'জানি না', 'gu-IN': 'ખબર નથી', 'ml-IN': 'അറിയില്ല', 'od-IN': 'ଜଣା ନାହିଁ',
  };
  for (const [lang, word] of Object.entries(DK)) {
    assert.strictEqual(classifyReply(word).verdict, 'unclear',
      `${lang} "${word}" -> ${classifyReply(word).verdict}`);
  }
});

// ── 3. THE HINDI TAG QUESTION MUST NOT BECOME A DENIAL ─────────────────────
ok('Devanagari "ना" is NOT a denial — it is our own tag question', () => {
  // Our read-back ends "…सही सुना ना?", and "हाँ ना" means YES. Adding ना to
  // DENY would turn agreement into refusal on the commonest Hindi affirmation.
  assert.strictEqual(classifyReply('हाँ ना').verdict, 'affirm',
    '"हाँ ना" (a normal Hindi yes) was read as something other than agreement');
  assert.notStrictEqual(classifyReply('ना').verdict, 'deny',
    'bare Devanagari "ना" is being treated as a denial — it is a tag particle');
});

// ── 4. THE ASYMMETRY IS DELIBERATE AND MUST STAY ───────────────────────────
ok('a denial that also names a drug is a CORRECTION, not just a no', () => {
  // "नहीं, Amlodipine" — the caller is not refusing, they are fixing the name.
  const r = classifyReply('नहीं, Amlodipine', null, { brands: true });
  assert.strictEqual(r.verdict, 'deny', `got ${r.verdict}`);
  assert(r.correction, 'the corrected drug was not extracted — the caller told us the right answer and we dropped it');
});

ok('a bare yes is labelled bare; a substantive yes is labelled substantive', () => {
  // A bare affirm may record a medication but must not become a training label:
  // without diarization, an agreeable syllable can come from anyone in the room.
  assert.strictEqual(classifyReply('हाँ').affirmStrength, 'bare');
  assert.strictEqual(classifyReply('हाँ वो मेटफॉर्मिन वाली').affirmStrength, 'substantive');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
