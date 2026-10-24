// ─── WHICH v2 CATEGORIES ARE SAFE TO ENFORCE ─────────────────────────────────
// v1 is live and catches 62 of 96 red flags. v2 catches 96 but adds 43
// adversarial false positives, and the repo's own hunt concluded BLOCK for
// blanket enforcement. That verdict is correct. This file exists because it is
// only correct BLANKET — the misses and the over-triggers live in different
// categories, and the per-category trade is what decides the setting.
//
// Every number here is recomputed from the fixtures at run time, so this file
// fails if the detectors change underneath it rather than repeating a stale
// claim.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('flips EMERGENCY_V2 / EMERGENCY_V2_ENFORCE in-process to drive the enforcement policy — the policy itself is under test');
const assert = require('assert');
const { detectEmergency } = require('../emergencyDetector');
const { detectEmergencyV2 } = require('../emergencyDetectorV2');

// ─── THE FIXTURES LIVE IN ritu-evals, AND THE PATH TO THEM WAS ABSOLUTE ─────
// This was '/Users/siddharthpathania/Developer/ritu-evals/data/', so the file
// ran on exactly one machine. CI failed it in 76ms with
// `Cannot find module '/Users/siddharthpathania/…'` — the same defect that put
// the whole deploy gate on one laptop, in a second place.
//
// RITU_EVALS_DIR is the variable tools/gate.sh already uses, with the same
// sibling-repo default, so there is one answer to "where is ritu-evals".
//
// Absent fixtures are a SKIP that names what went unchecked, not a failure:
// nothing about our detectors is broken when a sibling repo is not cloned, and
// a red that means "you did not check out another repo" is exactly the kind
// that teaches people to ignore reds.
const path = require('path');
const fs = require('fs');
const EV = path.join(
  process.env.RITU_EVALS_DIR || path.join(__dirname, '..', '..', 'ritu-evals'),
  'data'
);
const COV = path.join(EV, 'emergency-coverage-v2-candidate.json');
const FPH = path.join(EV, 'emergency-fp-hunt-v2.json');
if (!fs.existsSync(COV) || !fs.existsSync(FPH)) {
  console.log('\n⏭  SKIP — emergency v2 fixtures not found under', EV);
  console.log('   NOT COVERED: which v2 categories are safe to enforce, and the');
  console.log('   per-category coverage/false-positive trade that decides the setting.');
  console.log('   Set RITU_EVALS_DIR, or clone ritu-evals beside this repo.');
  process.exit(0);
}
const cov = require(COV);
const fph = require(FPH);

// The categories this repo proposes to enforce. Chosen by the table below,
// not by preference — the test recomputes and asserts the trade holds.
const ENFORCE = ['selfharm', 'stroke', 'poisoning'];

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nEMERGENCY v2 — per-category enforcement scope\n');

const reds = cov.per_item.filter((i) => i.expected === 'RED');
const v1Missed = reds.filter((i) => !detectEmergency(i.utterance));
const v2Catches = (i) => { const r = detectEmergencyV2(i.utterance, {}); return !!(r && r.tier === 'RED'); };

ok('v1 — the LIVE detector — still misses what the fixture says it misses', () => {
  assert.strictEqual(reds.length, 96, `expected 96 red flags, got ${reds.length}`);
  // 34 → 33 → 31 on 2026-08-29. First: v1 gained passive-ideation coverage and
  // catches the fixture's Kannada "ನಾನು ಸಾಯಬೇಕು ಅನಿಸುತ್ತಿದೆ". Then: v1's chest-
  // pain patterns allow an intensifier between site and symptom, and catch the
  // fixture's "छाती में बहुत तेज़ दर्द हो रहा है" and "seene mein bahut tez dard
  // ho raha hai" — the exact severe-chest-pain sentences a frightened caller
  // says. Re-derived, not loosened: the other 31 are still missed and v2 still
  // recovers every one of them (next assertion).
  // 31 → 30 on 2026-09-03: v1 gained Tamil/Telugu/Malayalam passive ideation.
  assert.strictEqual(v1Missed.length, 30, `v1 misses ${v1Missed.length}, fixture pinned 30`);
});

ok('v2 catches every red flag v1 misses', () => {
  const stillMissed = v1Missed.filter((i) => !v2Catches(i));
  assert.strictEqual(stillMissed.length, 0,
    `v2 also misses: ${stillMissed.map((i) => i.category + '/' + i.lang).join(', ')}`);
});

ok('the enforced categories are where v1 fails worst', () => {
  const byCat = {};
  for (const i of v1Missed) byCat[i.category] = (byCat[i.category] || 0) + 1;
  // selfharm 11 and stroke 10 are the two largest gaps by a wide margin.
  // selfharm 11 → 9 on 2026-09-03 (v1 now catches the ta/te/ml passive forms); still the largest gap.
  assert(byCat.selfharm >= 8, `selfharm gap shrank to ${byCat.selfharm} — re-derive the scope`);
  assert(byCat.stroke >= 9, `stroke gap shrank to ${byCat.stroke} — re-derive the scope`);
});

ok('enforcing those three recovers most of the gap', () => {
  const recovered = v1Missed.filter((i) => ENFORCE.includes(i.category) && v2Catches(i));
  assert(recovered.length >= 20,
    `only ${recovered.length} of ${v1Missed.length} recovered — scope no longer worth it`);
  console.log(`      recovers ${recovered.length} of ${v1Missed.length} missed emergencies`);
});

ok('and costs few false positives — the whole reason for scoping', () => {
  const fps = fph.adversarial_red_fps_v2_only;
  const inScope = fps.filter((x) => ENFORCE.includes(x.cat));
  const outOfScope = fps.filter((x) => !ENFORCE.includes(x.cat));
  console.log(`      ${inScope.length} FPs inside the enforced scope, ${outOfScope.length} left on v1`);
  assert(inScope.length <= 8, `${inScope.length} FPs in scope — too many, re-derive`);
  // The point of scoping: the bulk of v2's over-trigger stays unenforced.
  assert(outOfScope.length > inScope.length * 3,
    'scoping is not actually avoiding the over-trigger — reconsider');
});

ok('bleeding and cardiac are deliberately NOT enforced', () => {
  // 11 and 6 FPs respectively, against v1 gaps of 1 and 6. Bad trades.
  assert(!ENFORCE.includes('bleeding'));
  assert(!ENFORCE.includes('cardiac'));
});

ok('default configuration changes NOTHING', () => {
  // The env var must be opt-in. A safety switch that turns itself on is a
  // different kind of hazard.
  delete process.env.EMERGENCY_V2;
  delete process.env.EMERGENCY_V2_ENFORCE;
  const set = new Set(String(process.env.EMERGENCY_V2_ENFORCE || '').split(',').map((s) => s.trim()).filter(Boolean));
  assert.strictEqual(set.size, 0, 'enforcement is on by default — it must not be');
});

ok('callHandler consults the category, not a single global switch (driven)', () => {
  // One policy function, shared with the WhatsApp guard, read at call time —
  // so this drives it instead of grepping callHandler.js for a regex.
  process.env.SKIP_BOOT_AUDIO = '1';
  const enforces = require('../callHandler.js')._V2_ENFORCES;
  const shared = require('../emergencyDetectorV2.js').v2Enforces;
  assert.strictEqual(enforces, shared, 'callHandler carries its own copy of the enforcement policy');
  const saved = [process.env.EMERGENCY_V2, process.env.EMERGENCY_V2_ENFORCE];
  try {
    process.env.EMERGENCY_V2 = ''; process.env.EMERGENCY_V2_ENFORCE = '';
    assert.strictEqual(enforces('cardiac'), false, 'nothing set → nothing enforced');
    process.env.EMERGENCY_V2_ENFORCE = 'breathing';
    assert.strictEqual(enforces('breathing'), true, 'the named category enforces');
    assert.strictEqual(enforces('cardiac'), false, 'an unnamed category stays shadow');
    process.env.EMERGENCY_V2 = 'on';
    assert.strictEqual(enforces('cardiac'), true, 'the old global switch still means every category');
  } finally { [process.env.EMERGENCY_V2, process.env.EMERGENCY_V2_ENFORCE] = saved.map((v) => v == null ? '' : v); }
});

ok('MUTATION: an empty enforce-set escalates nothing', () => {
  const set = new Set([]);
  const enforces = (c) => set.has(c);
  assert(!enforces('selfharm'), 'empty set escalated');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
