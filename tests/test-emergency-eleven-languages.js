#!/usr/bin/env node
'use strict';
// Passive ideation and the word "emergency" in the languages the detectors
// never carried. Measured 2026-09-03 before this file: Tamil, Telugu and
// Malayalam passive ideation → null in BOTH detectors; "emergency आहे" /
// "emergency ಇದೆ" / "emergency ആണ്" → null everywhere while the scheduling
// regex happily consumed the word; Malayalam/Telugu chest pain romanized to
// forms no pattern knew. Driven through the ONE probe definition.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-HINDI-ONLY-FRAMES  — the non-Hindi "emergency" frames are removed from the compiled list
//   MUTANT=MUT-NO-TA-TE-ML        — the Tamil/Telugu/Malayalam self-harm patterns are removed
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { const r = f(); if (r && typeof r.then === 'function') throw new Error('async in ok()'); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const det = require('../emergencyDetector.js');
const SOUTH = /[஀-௿ఀ-౿ഀ-ൿ]/;   // Tamil, Telugu, Malayalam blocks
if (MUTANT === 'MUT-NO-TA-TE-ML') { const keep = det._FLAT_PATTERNS.filter((e) => !(e.id === 'self_harm' && SOUTH.test(e.re.source))); det._FLAT_PATTERNS.length = 0; det._FLAT_PATTERNS.push(...keep); }
if (MUTANT === 'MUT-HINDI-ONLY-FRAMES') { const keep = det._FLAT_PATTERNS.filter((e) => !(/emergency/.test(e.re.source) && /[ऀ-෿]|ahe|ide|aanu|undi|irukku/.test(e.re.source) && !/है|हैं|में|ये|यह/.test(e.re.source))); det._FLAT_PATTERNS.length = 0; det._FLAT_PATTERNS.push(...keep); }
const { detectEmergency, composeEmergencyProbe } = det;
const { detectEmergencyV2 } = require('../emergencyDetectorV2.js');
const v1 = (t) => { const h = detectEmergency(composeEmergencyProbe(t)); return h ? h.type : null; };
const v2 = (t) => { const h = detectEmergencyV2(t, {}); return h ? `${h.tier}:${h.category}` : null; };

console.log('[1] passive ideation — Tamil, Telugu, Malayalam, in BOTH detectors');
const IDEATION = [
  ['ta', 'எனக்கு வாழ ஆசை இல்லை'], ['ta', 'நான் வாழ விரும்பவில்லை'], ['ta', 'எனக்கு சாகணும்'],
  ['te', 'నాకు బతకాలని లేదు'], ['te', 'బతకడం ఇష్టం లేదు'], ['te', 'చనిపోవాలని ఉంది'],
  ['ml', 'എനിക്ക് ജീവിക്കാൻ താൽപ്പര്യമില്ല'], ['ml', 'എനിക്ക് ജീവിക്കണ്ട'], ['ml', 'മരിച്ചാൽ മതി'],
];
for (const [lang, t] of IDEATION) {
  ok(`v1 ${lang}: "${t}"`, () => assert.strictEqual(v1(t), 'self_harm', `got ${v1(t)}`));
  ok(`v2 ${lang}: "${t}"`, () => assert.strictEqual(v2(t), 'RED:selfharm', `got ${v2(t)}`));
}

console.log('\n[2] the word "emergency" framed in the other languages');
const FRAMES = ['emergency आहे, लवकर', 'मला emergency मध्ये दाखवायचं आहे', 'emergency ಇದೆ', 'എനിക്ക് emergency ആണ്', 'emergency ఉంది', 'emergency இருக்கு', 'emergency છે', 'emergency ਹੈ', 'emergency আছে', 'ഇത് emergency', 'ಇದು emergency'];
for (const t of FRAMES) ok(`"${t}"`, () => assert.ok(v1(t), 'missed'));

console.log('\n[3] chest pain as romanize() emits it');
for (const t of ['చెస్ట్ పెయిన్', 'ചെസ്റ്റ് പെയിൻ', 'ಚೆಸ್ಟ್ ಪೇನ್']) ok(`"${t}"`, () => assert.ok(v1(t), 'missed'));

console.log('\n[4] what must stay quiet');
const QUIET = ['emergency नाही आहे', 'emergency ward ka address bhejiye', 'வாழ்க்கை நன்றாக இருக்கு', 'బతకడం బాగుంది', 'ജീവിക്കാൻ ഇഷ്ടമാണ്', 'எனக்கு நாளை appointment வேண்டும்', 'నాకు రేపు అపాయింట్‌మెంట్ కావాలి', 'എനിക്ക് നാളെ appointment വേണം', 'emergency contact number kya hai'];
for (const t of QUIET) ok(`quiet: "${t}"`, () => { assert.strictEqual(v1(t), null, `v1 fired ${v1(t)}`); assert.strictEqual(v2(t), null, `v2 fired ${v2(t)}`); });

console.log(`\n${pass}/${pass + fail} passing`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
process.exit(0);
