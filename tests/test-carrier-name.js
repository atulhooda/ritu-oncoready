#!/usr/bin/env node
// ─── THE NAME THE CALLER SAID, AND THE NAME WE WROTE DOWN ───────────────────
// MEASURED across 150 production transcripts, 2026-08-15. On NINE calls the
// caller stated their name plainly, Sarvam transcribed it correctly, and
// patients.name still ended up "Unknown" or "your name":
//
//     मेरा नाम सिद्धार्थ है।            -> we wrote "Unknown"
//     ಹಲೋ, ನನ್ನ ಹೆಸರು ಪೃಥ್ವಿ.            -> we wrote "Unknown"
//     मेरा नाम अब्दुल है।               -> we wrote "your name"
//
// Nothing was wrong with the audio or the transcript. The LLM sentinel does not
// COPY the name out of the turn, it REGENERATES it — which is also how one
// Kannada caller's ಪೃಥ್ವಿ reached the database written in BENGALI (পৃথ্বী).
//
// THE RULE IS FILL-ONLY, AND THAT RESTRICTION IS ALSO MEASURED. On the 7 calls
// where a valid name was already recorded and the carrier phrase disagreed,
// overriding would have been wrong or pointless EVERY time — 4 were the same
// name in another script (अतुल/Atul, আদিত্য ঝা/Aditya Jha), and one was a garbled
// transcript the model had already repaired (सित्थात -> सिद्धार्थ). So the
// extractor may only speak where we would otherwise have had nothing.
//
// TWO OF THE CASES BELOW ARE BUGS THIS EXTRACTOR SHIPPED WITH, found by running
// it over the real corpus before wiring it in — not invented for the test:
//   · "आपने मेरा नाम बोला तो।"  -> returned "बोला तो" as a person's name
//   · "ನನ್ನ ಹೆಸರು ಪೃಥ್ವಿ ನನಗೆ ಕಾಲಲ್ಲಿ…" -> returned "ಪೃಥ್ವಿ ನನಗೆ ಕಾಲಲ್ಲಿ ಒಂದು"
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { extractNameFromSpeech } = require('../nameGuard');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nCARRIER-PHRASE NAME CAPTURE — the caller\'s own words, not the model\'s\n');

// ── 1. THE NINE LIVE UTTERANCES WE LOST ────────────────────────────────────
// Every string here is verbatim from a production transcript whose recorded
// name was "Unknown" or "your name".
const LOST = [
  ['अच्छा मेरा नाम सिद्धार्थ है।',        'सिद्धार्थ'],
  ['ಹಲೋ, ನನ್ನ ಹೆಸರು ಪೃಥ್ವಿ.',              'ಪೃಥ್ವಿ'],
  ['हाँ, मेरा नाम अतुल है।',               'अतुल'],
  ['मेरा नाम अतुल है।',                    'अतुल'],
  ['मेरा नाम अब्दुल है।',                  'अब्दुल'],
  ['मैंने अभी तुमको बताया था मेरा नाम अतुल है।', 'अतुल'],
  ['मेरा नाम पृथ्वी है',                   'पृथ्वी'],
  ['আমার নাম আদিত্য ঝা।',                  'আদিত্য ঝা'],
];
for (const [said, want] of LOST) {
  ok(`LIVE: "${said.slice(0, 34)}" -> ${want}`, () => {
    assert.strictEqual(extractNameFromSpeech(said), want);
  });
}

// ── 2. THE TWO SHIPPED BUGS THE CORPUS CAUGHT ──────────────────────────────
ok('NOT A NAME: "आपने मेरा नाम बोला तो।" — talking ABOUT the name', () => {
  // The carrier fires, but the caller is saying "you said my name". The
  // extractor returned "बोला तो" and would have written it to the record.
  assert.strictEqual(extractNameFromSpeech('आपने मेरा नाम बोला तो।'), null);
});

ok('ONE BREATH, NAME THEN SYMPTOM: the Kannada run-on stops at the name', () => {
  // No punctuation anywhere: name, then the complaint. Hindi was safe because
  // मुझे was already a stop word; Kannada ನನಗೆ was not.
  assert.strictEqual(
    extractNameFromSpeech('ನನ್ನ ಹೆಸರು ಪೃಥ್ವಿ ನನಗೆ ಕಾಲಲ್ಲಿ ಒಂದು ಚೂರು ನೋವಿದೆ'),
    'ಪೃಥ್ವಿ');
});

// ── 3. THE CLAUSE BOUNDARY ─────────────────────────────────────────────────
ok('a name ends where the next clause begins', () => {
  assert.strictEqual(
    extractNameFromSpeech('और मेरा नाम अतुल है और क्या आप मेरे से हिंदी में बात करेंगे'),
    'अतुल');
  assert.strictEqual(
    extractNameFromSpeech('नमस्कार, माझं नाम सरदार है, मला दाद दुखी होते हैं।'),
    'सरदार');
  assert.strictEqual(
    extractNameFromSpeech('नहीं नहीं मेरा नाम अतुल है बट बाय प्रोफेशन आई एम अ हेल्थकेयर वर्कर'),
    'अतुल');
});

// ── 4. BOTH WORD ORDERS, AND THE OTHER SCRIPTS ─────────────────────────────
ok('"मेरा नाम है X" (copula before the name) works too', () => {
  assert.strictEqual(extractNameFromSpeech('मेरा नाम है सिद्धार्थ'), 'सिद्धार्थ');
});

ok('the phrase is recognised in every language we answer in', () => {
  const CASES = [
    ['ਮੇਰਾ ਨਾਮ ਗੁਰਪ੍ਰੀਤ ਹੈ',      'ਗੁਰਪ੍ਰੀਤ'],
    ['என் பெயர் முருகன்',          'முருகன்'],
    ['నా పేరు రవి',                'రవి'],
    ['મારું નામ પ્રીતિ છે',        'પ્રીતિ'],
    ['ମୋ ନାମ ସୁନୀଲ',               'ସୁନୀଲ'],
    ['my name is Deekshitha',      'Deekshitha'],
    ['mera naam Vikrant hai',      'Vikrant'],
  ];
  for (const [said, want] of CASES) {
    assert.strictEqual(extractNameFromSpeech(said), want, `${said} -> got ${extractNameFromSpeech(said)}`);
  }
});

// ── 5. WHAT IT MUST REFUSE ─────────────────────────────────────────────────
ok('the slot is EMPTY — caller was cut off ("हेलो, मेरा नाम।")', () => {
  // Verbatim from a live transcript. There is no name in it to find.
  assert.strictEqual(extractNameFromSpeech('हेलो, मेरा नाम।'), null);
});

ok('the question is not an answer', () => {
  for (const s of ['मेरा नाम क्या है?', 'आपका नाम क्या है', 'what is your name']) {
    assert.strictEqual(extractNameFromSpeech(s), null, `${s} produced a name`);
  }
});

ok('no carrier phrase at all -> null, never a guess from loose speech', () => {
  for (const s of ['मेरे को सर में दर्द हो रहा है यार।', 'ಇಲ್ಲ ಸದ್ಯಕ್ಕೆ ಏನೂ ತಗೊಂಡಿಲ್ಲ', 'हेलो।', '', null]) {
    assert.strictEqual(extractNameFromSpeech(s), null, `${JSON.stringify(s)} produced a name`);
  }
});

ok('it obeys the same reject-list as the sentinel (no second door)', () => {
  // If this ever diverges, "your name" gets into the patients table by a route
  // nameGuard cannot see — which is exactly how it got there the first time.
  for (const s of ['मेरा नाम Unknown है', 'my name is patient', 'my name is [Patient Name]']) {
    assert.strictEqual(extractNameFromSpeech(s), null, `${s} produced a name`);
  }
});

// ── 6. THE GREETING NO LONGER ASKS FOR THE NAME ────────────────────────────
// 89% of callers (111/125) talked straight past the name question, so it moved
// behind the symptom. Asserted against the SHIPPED greeting strings, not a copy:
// a revert that re-appends "आपका नाम?" must fail here.
ok('the greeting asks the REASON, not the name', () => {
  process.env.SKIP_BOOT_AUDIO = '1';
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'callHandler.js'), 'utf8');
  const block = src.match(/const GREETING_TEXTS = \{[\s\S]*?\n\};/);
  assert(block, 'GREETING_TEXTS not found — has it been renamed?');
  // Strip ${...} first: the clinic name is interpolated as
  // `config.greetingClinicName`, and matching "name" inside an identifier is
  // not the greeting asking the caller anything.
  const spoken = block[0].replace(/\$\{[^}]*\}/g, '');
  const NAME_WORDS = /नाव|नाम|ಹೆಸರು|name/i;
  assert(!NAME_WORDS.test(spoken),
    'a greeting asks for the name again. 111 of 125 callers ignore it and state their symptom; ' +
    'asking it first also delays the STT language pin (symptom openers pin at 73%, median 6 tokens).');
  // ...and still asks something, rather than having been emptied out.
  assert(/तकलीफ़|त्रास|ತೊಂದರೆ/.test(block[0]), 'the greeting no longer asks about the problem either');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
