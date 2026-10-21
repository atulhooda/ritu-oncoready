#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// AN INTENSIFIER SILENCED THE CHEST-PAIN PATTERN; "EMERGENCY" IN A HINDI
// SENTENCE WAS INVISIBLE.
//
// v1's Devanagari and Hinglish cardiac patterns required strict adjacency —
// छाती\s+में\s+दर्द. A frightened caller says "छाती में बहुत तेज़ दर्द", and every
// intensified form missed (measured 2026-08-29). v2 catches most of them, but
// cardiac is a shadow category in v2, so v1 is the path that escalates.
//
// The emergency-word frames were all-English ("it's an emergency") or all-
// Devanagari (इमरजेंसी). A real caller said "मुझे emergency में दिखाना है जल्दी" —
// the English word inside a Hindi sentence — and was offered a slot three days
// out with no 108. On a sweep of 3,246 real utterances, that sentence is the
// ONLY new fire this change produces, and it is the one it was written for.
//
// Run: node tests/test-emergency-frames.js   (proved by reversion — see commit)
// ═══════════════════════════════════════════════════════════════════════════
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
console.log('\nEMERGENCY FRAMES — intensifiers, and the English word inside Hindi\n');
const { detectEmergency } = require('../emergencyDetector.js');
const { toDevanagari } = require('../translit'); const { romanize } = require('../devanagari.js');
const { composeEmergencyProbe: probe } = require('../emergencyDetector');   // the LIVE composition, not a copy
const v1 = (t) => { const r = detectEmergency(probe(t)); return r ? (r.type || r.id) : null; };

for (const q of ['छाती में बहुत तेज़ दर्द हो रहा है', 'छाती में बहुत ज़्यादा दर्द है', 'सीने में बहुत जोर से दर्द हो रहा है', 'chest mein bahut zyada dard hai', 'seene mein bahut tez dard'])
  ok(`cardiac despite the intensifier: "${q}"`, () => assert.strictEqual(v1(q), 'cardiac', `got ${v1(q)}`));
for (const q of ['मुझे emergency में दिखाना है', 'ये emergency है, जल्दी', 'अर्जेंट है, अभी दिखाना है', 'अभी कोई नहीं है क्या मुझे emergency में दिखाना है जल्दी।'])
  ok(`the English word inside Hindi: "${q.slice(0, 44)}"`, () => assert.strictEqual(v1(q), 'emergency_generic', `got ${v1(q)}`));
for (const q of ['emergency नहीं है, बस अपॉइंटमेंट चाहिए', 'urgent appointment chahiye kal ke liye', 'emergency ward ka address bhejiye', 'Namaste, mujhe appointment chahiye', 'Knee mein thoda dard hai'])
  ok(`quiet: "${q.slice(0, 44)}"`, () => assert.strictEqual(v1(q), null, `fired ${v1(q)}`));
ok('the window is bounded — four tokens between site and symptom do not match', () => {
  assert.strictEqual(v1('छाती में एक दो तीन चार दर्द'), null, 'the window is unbounded');
});
console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
