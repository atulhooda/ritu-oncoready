#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// TWO SAFETY GAPS ON THE ENFORCED PATH, CLOSED IN BOTH DETECTORS.
//
// 1. PASSIVE IDEATION. Every self-harm pattern named an ACT — kill, suicide,
//    मरना चाहता. The commonest presentation names an absence of wanting to
//    live. Measured 2026-08-29, both detectors: "मुझे जीने का मन नहीं करता",
//    "I do not want to live anymore", "मैं खुद को खत्म कर लूंगा" — all missed,
//    on the one category production enforces.
// 2. ENGLISH IN AN INDIC SCRIPT. A Kannada-pinned session writes "I want to
//    die" as ಐ ವಾಂಟ್ ಟು ಡೈ and "heart attack" as ಹಾರ್ಟ್ ಅಟ್ಯಾಕ್. No Latin regex
//    could see either. callHandler now appends romanize() of the Devanagari
//    probe, and v1 matches the spelling romanize actually emits.
//
// A v2 script fold was tried for gap 2 and REMOVED the same day: it carried one
// term in the whole rule set and, swept over 3,246 real utterances, lit 25 new
// REDs — फंड (mutual fund) and फंदा (noose) fold to the same skeleton. That
// sweep (tools/emergency-fp-sweep.js) is how this change was measured: 0 new
// fires from either detector on real speech.
//
// Run:            node tests/test-emergency-passive-ideation.js
// Prove it fails: MUTANT=MUT-NO-ROMANIZE node tests/test-emergency-passive-ideation.js
//   (the pattern additions themselves were proved by reversion — see the commit)
// ═══════════════════════════════════════════════════════════════════════════
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, f) => { try { const r = f(); if (r && typeof r.then === 'function') throw new Error('async'); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);
console.log('\nEMERGENCY — passive ideation, and English in an Indic script\n');

const { detectEmergency } = require('../emergencyDetector.js');
const { detectEmergencyV2 } = require('../emergencyDetectorV2.js');
const { toDevanagari } = require('../translit');
const { romanize } = require('../devanagari.js');
// callHandler's probe, composed the same way (asserted below), minus romanize under the mutant.
const { composeEmergencyProbe } = require('../emergencyDetector');   // the LIVE composition
const probe = (t) => composeEmergencyProbe(t, { roman: MUTANT !== 'MUT-NO-ROMANIZE' });
const v1 = (t) => { const r = detectEmergency(probe(t)); return r ? (r.type || r.id) : null; };
const v2 = (t) => { const r = detectEmergencyV2(t, {}); return r && r.tier === 'RED' ? r.category : null; };

// ── [1] the measured misses, now caught by BOTH ───────────────────────────
for (const q of ['मुझे जीने का मन नहीं करता', 'I do not want to live anymore', 'मैं खुद को खत्म कर लूंगा']) {
  ok(`both detectors: "${q}"`, () => { assert.strictEqual(v1(q), 'self_harm', `v1=${v1(q)}`); assert.strictEqual(v2(q), 'selfharm', `v2=${v2(q)}`); });
}
for (const q of ['जीने की इच्छा नहीं है', 'मर जाऊं तो अच्छा है', 'better off dead', 'nothing to live for', 'jeene ka man nahi karta', 'जगावंसं वाटत नाही', 'ಬದುಕೋಕೆ ಇಷ್ಟ ಇಲ್ಲ', 'ನಾನು ಸಾಯಬೇಕು ಅನಿಸುತ್ತಿದೆ']) {
  ok(`self-harm, v1 ∪ v2: "${q}"`, () => assert.ok(v1(q) === 'self_harm' || v2(q) === 'selfharm', `v1=${v1(q)} v2=${v2(q)}`));
}

// ── [2] English in an Indic script — carried by v1's romanized probe ──────
for (const [q, want] of [['ಹಾರ್ಟ್ ಅಟ್ಯಾಕ್', 'indic_script_english'], ['హార్ట్ అటాక్', 'indic_script_english'], ['હાર્ટ એટેક', /indic_script_english|emergency_gu/], ['ஹார்ட் அட்டாக்', 'indic_script_english'],
  ['చెస్ట్ పేన్ ఇదే', 'indic_script_english'], ['ಕ್ಯಾಂಟ್ ಬ್ರೀತ್', 'indic_script_english'], ['ಸ್ಟ್ರೋಕ್ ಆಗಿದೆ', /indic_script_english|emergency_kn/], ['ಬ್ಲೀಡಿಂಗ್ ಆಗ್ತಿದೆ', /indic_script_english|emergency_kn/],
  ['ಐ ವಾಂಟ್ ಟು ಡೈ', 'self_harm'], ['ಸೂಸೈಡ್ ಮಾಡ್ಕೊತೀನಿ', 'self_harm']]) {
  ok(`v1 via romanize: "${q}"`, () => { const got = v1(q); assert.ok(want instanceof RegExp ? want.test(got || '') : got === want, `got ${got}`); });
}
ok('the live probe carries the romanized copy (driven, not grepped)', () => {
  const p = composeEmergencyProbe('हार्ट अटैक');
  assert.ok(p.split(' ‖ ').length >= 4, `expected 4 copies, got: ${p}`);
  assert.match(p, /hart|haart/, `no romanized copy in: ${p}`);
});

// ── [3] what must stay quiet ──────────────────────────────────────────────
const QUIET = ['घुटने की वजह से जीना नहीं चढ़ पाता', 'बच्चे के लिए जान दे दूंगी', 'इस काम में जान लगा दूंगा',       // v2's own homonym/idiom vetoes
  'मुझे फंड के बारे में पूछना है', 'आज इन्वेस्को म्युच्युअल फंडच्या शेअरचे मूल्य किती आहे',              // the fold's 25 FPs
  'Heart checkup karwana hai routine', 'Strike kal hai shahar mein', 'mujhe bahut hart hua tha kal',      // false friends of the romanized patterns
  'Namaste, mujhe appointment chahiye', 'Kal subah 11 baje aa sakta hoon', 'Skin specialist se milna hai'];
for (const q of QUIET) ok(`quiet: "${q.slice(0, 44)}"`, () => assert.ok(!v1(q) && !v2(q), `v1=${v1(q)} v2=${v2(q)}`));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
process.exit(fail ? 1 : 0);
