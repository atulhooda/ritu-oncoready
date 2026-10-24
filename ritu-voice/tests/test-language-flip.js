#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Marathi-first language behavior
//
// The call opens in Marathi (Ritu voice) and stays Marathi until the caller
// DELIBERATELY speaks or asks for Hindi, then locks to Hindi (Suhani). This
// pins:
//   1. The greeting + emergency text render as mr-IN (so the cached Marathi
//      voice lines up — detectLanguageCode must see Marathi markers).
//   2. looksLikeHindi() flips ONLY on a clean Hindi utterance — never on
//      Marathi, and never on a Marathi sentence that mixes in one Hindi/English
//      word (a single stray word must not flip the whole call's voice).
//
// Run: node tests/test-language-flip.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { detectLanguageCode, looksLikeHindi } = require('../sarvam');

const GREETING = 'नमस्कार! मी ऋतू बोलते आहे, साई श्रद्धा हेल्थ केअर सेंटर मधून. आपलं नाव काय आहे?';
const EMERGENCY_MR = 'ही इमर्जन्सी वाटते. कृपया लगेच 108 डायल करा किंवा जवळच्या हॉस्पिटलमध्ये जा. मी हा कॉल इथे थांबवते जेणेकरून तुम्हाला मदत मिळेल. काळजी घ्या.';

let pass = 0, fail = 0;
const fails = [];

function check(label, got, expected) {
  if (got === expected) { pass++; }
  else { fail++; fails.push(`${label}: expected ${expected}, got ${got}`); console.log(`  ✗ ${label} → ${got} (expected ${expected})`); }
}

console.log('──────── VOICE CONSISTENCY (cached audio must be mr-IN) ────────');
check('greeting is Marathi', detectLanguageCode(GREETING), 'mr-IN');
check('emergency is Marathi', detectLanguageCode(EMERGENCY_MR), 'mr-IN');

console.log('\n──────── STAY MARATHI (looksLikeHindi must be false) ────────');
const STAY = [
  'हो, चालेल',
  'मला अपॉइंटमेंट हवी आहे',
  'डॉक्टर कधी उपलब्ध आहेत?',
  'माझं नाव सिद्धार्थ आहे',
  'मला appointment book करायची आहे',   // Marathi + English word (code-mix)
  'ठीक आहे, धन्यवाद',
  'काय फी आहे डॉक्टरांची?',
  // Regression: garbled STT of a Marathi caller — one stray weak "है" must NOT
  // flip the whole call to the Hindi voice (this shipped a voice/text mismatch).
  'सर सर दोस्तों है।',
  'हाँ।',                              // lone weak backchannel
  // A genuinely lone weak "है" — what the moved line was TRYING to cover.
  // (The Marathi form of that sentence, माझं नाव सिद्धार्थ आहे, is already
  // pinned at the top of this list.)
  'सिद्धार्थ है',
];
for (const t of STAY) check(`stay: "${t}"`, looksLikeHindi(t), false);

console.log('\n──────── SWITCH TO HINDI (looksLikeHindi must be true) ────────');
const SWITCH = [
  // MOVED FROM `STAY` 2026-08-08, where it sat commented "lone weak है" and was
  // the suite's only red. It is not a lone weak है — it carries मेरा, which
  // sarvam.js lists in HINDI_STRONG on purpose, with its own comment saying why:
  // "मेरे/मेरा/मेरी (Marathi uses माझ*)". A Marathi speaker says माझं नाव
  // सिद्धार्थ आहे. So the code was right and the fixture was mislabelled — the
  // sentence really is Hindi, and flipping the voice for it is correct.
  // The regression the old line meant to guard now lives in STAY as
  // 'सिद्धार्थ है' — a truly lone है, with no strong marker beside it.
  'मेरा नाम सिद्धार्थ है',
  'मुझे अपॉइंटमेंट चाहिए',             // strong: मुझे + चाहिए
  'क्या डॉक्टर अभी हैं?',               // strong: क्या
  'हिंदी में बात कीजिए',               // strong: हिंदी (explicit request)
  'नहीं, मुझे कल चाहिए',               // strong: नहीं/मुझे/चाहिए
  'आपको कैसे पता चलेगा',               // strong: आपको/कैसे
  'मैं ठीक हूँ और आपका नाम क्या है',   // multiple strong markers
];
for (const t of SWITCH) check(`switch: "${t}"`, looksLikeHindi(t), true);

console.log(`\n${pass}/${pass + fail} total tests passing`);
if (fail > 0) { console.log('\n' + fails.join('\n')); process.exit(1); }
console.log('\n✓ All Marathi-first language tests passing.');
