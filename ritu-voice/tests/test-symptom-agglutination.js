#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// MARATHI AGGLUTINATION IN THE SYMPTOM MATCHER.
//
// Marathi attaches case markers directly to the noun. The matcher's trailing
// (?![Devanagari]) guard — which correctly kills the दिल/दिला class (दिल =
// heart, दिला = gave) — also blocked every naturally inflected form in the
// PILOT language:
//     डोकेदुखी      → Neurology   ✓
//     डोकेदुखीसाठी   → nothing     ✗   ("for a headache")
// So "मला डोकेदुखीसाठी अपॉइंटमेंट हवी आहे" matched no symptom at all, and both
// consequences were silent: the deterministic pre-visit history machine requires
// a symptom match to start, and the roster slice needs one to narrow to a
// specialist. Found by the intent eval's S01 (the Marathi happy path) failing
// intermittently on "duration never asked" — intermittently, because with no
// symptom match the questions fell to the model's discretion.
//
// THIS FILE IS THE PAIRED-FP ARM, KEPT. Widening a matcher is the single easiest
// way to make a metric go up while making the product worse — the drug matcher
// taught that. So recall and false positives are asserted TOGETHER: the negative
// cases below are as load-bearing as the positive ones, and a future widening
// that reintroduces दिला will fail here rather than in a clinic.
//
//   node tests/test-symptom-agglutination.js
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { specialtiesForSymptom } = require('../tools/symptomMapping');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── RECALL: inflected Marathi must match ───────────────────────────────────
// Each is a form a real caller uses. Bare stems already worked; these are the
// case-marked and compound forms that did not.
console.log('\nRECALL — inflected / compound Marathi');
const MUST_MATCH = [
  ['Neurology',         'मला डोकेदुखीसाठी अपॉइंटमेंट हवी आहे', 'noun + साठी ("for")'],
  ['Neurology',         'डोकेदुखीमुळे त्रास होतो',              'noun + मुळे ("because of")'],
  ['Gastroenterology',  'पोटदुखीसाठी डॉक्टर पाहिजे',            'compound + साठी'],
  ['Dental',            'दातदुखीसाठी अपॉइंटमेंट',               'stem + ache-compound + साठी'],
  ['Internal Medicine', 'तापासाठी दाखवायचे आहे',                'oblique (ताप→तापा) + साठी'],
  ['Neurology',         'डोकेदुखी आहे',                         'bare stem (regression)'],
  ['Neurology',         'सिर दर्द है',                          'Hindi spaced form (regression)'],
  ['Dental',            'दात दुखत आहे',                         'spaced Marathi (regression)'],
];
for (const [want, text, why] of MUST_MATCH) {
  const got = specialtiesForSymptom(text);
  ok(`${why}: "${text.slice(0, 30)}"`, got.includes(want), `wanted ${want}, got ${JSON.stringify(got)}`);
}

// ── FALSE POSITIVES: words that merely CONTAIN a symptom term ──────────────
// The whole reason the strict boundary exists. A blanket suffix allowance would
// pass the recall block above and fail every line here.
console.log('\nFALSE POSITIVES — must stay silent');
const MUST_NOT_MATCH = [
  ['दिला',            'दिल (heart) + ा — "gave". The original red-team case.'],
  ['दिलासा',          'दिल + ासा — "reassurance"'],
  ['दिलेल्या',         'dative participle of देणे'],
  ['मला ते दिला आहे',  'दिला inside a full sentence'],
  ['सरला',            'सर + ला — a personal name (Sarala)'],
  ['कानून',           'कान (ear) + ऊन — "law"'],
  ['तापमान',          'ताप (fever) + मान — "temperature"'],
  ['दातृत्व',          'दात (tooth) + ृत्व — "generosity"'],
];
for (const [text, why] of MUST_NOT_MATCH) {
  const got = specialtiesForSymptom(text);
  ok(`${text} — ${why}`, got.length === 0, `matched ${JSON.stringify(got)}`);
}

// ── the suffix allowance must not become a wildcard ────────────────────────
// A postposition is only accepted from the closed list. An arbitrary Devanagari
// suffix must still block, or this has silently become [DV]*.
console.log('\nTHE ALLOWANCE IS A CLOSED LIST, NOT A WILDCARD');
for (const t of ['डोकेदुखीक्ष', 'तापझम', 'दातघळ']) {
  ok(`arbitrary suffix still blocks: ${t}`, specialtiesForSymptom(t).length === 0,
     `matched ${JSON.stringify(specialtiesForSymptom(t))} — the boundary is now a wildcard`);
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail) { console.log('✗ symptom agglutination tests FAILED.'); process.exit(1); }
console.log('✓ All symptom agglutination tests passing.');
