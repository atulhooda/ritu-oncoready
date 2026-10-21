#!/usr/bin/env node
// ─── "dentist" IS NOT A MEDICINE ────────────────────────────────────────────
// LIVE, demo clinic, 2026-08-08 08:06, turns 11-14 of a 153s booking:
//
//   11 patient  मुझे dentist
//   12 ritu     दवाई का नाम मैं ठीक से समझ नहीं पाई — सिर्फ़ दवाई का नाम बताइएगा?
//               (I did not catch the MEDICINE NAME — say just the medicine name)
//   13 patient  अरे कौन सी दवाई भाई मुझे अपने दांत दिखाने हैं dentist को।
//               (WHAT medicine, brother?! I need to show my teeth to a dentist)
//   14 ritu     [medical-advice refusal]
//
// findUnresolvedMedToken exists for a real failure: "Metformin" snapped by an
// 8kHz line to "Metamorphosin" is 6 edits from any generic, and a guessed
// read-back at that distance manufactures the error read-back exists to
// prevent. So a long Latin token in a meds answer that resolves to nothing
// earns ONE "say just the name again" turn.
//
// Its filter is MED_STOPWORDS — 117 entries. `doctor` and `appointment` are
// both in it, so someone had already seen this class. `dentist` was not.
//
// THE FIX IS NOT A 118th WORD. tools/symptomMapping.js already owns
// dentist/dental/tooth/teeth/molar/gum/cavity because the roster slice needs
// them, so a token that names a SPECIALTY or a BODY PART is one this guard
// should never treat as a mangled drug. That closes the class instead of the
// instance.
//
// COLLISION CHECK, run before shipping rather than reasoned about: all 117,968
// names in drug_brands.json + drug_generics.json were pushed through
// specialtiesForSymptom. 25 collide, including `insulin` — one of the most
// spoken drugs in an Indian clinic. Measured through the guard's own path,
// "main insulin leta hoon" stops being re-asked AND findAllDrugMentions still
// returns Human insulin, so nothing is lost. That is asserted below rather
// than trusted.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { findUnresolvedMedToken, findAllDrugMentions } = require('../readback.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const fires = (t) => !!findUnresolvedMedToken(t);
const captures = (t) => findAllDrugMentions(t, { brands: true }).map((d) => d.canonical);

console.log('\nUNRESOLVED MED TOKEN — a specialty is not a mangled drug\n');

ok('THE LIVE FAILURE: "मुझे dentist" is not asked to repeat a medicine name', () => {
  assert.strictEqual(fires('मुझे dentist'), false,
    'still treats "dentist" as a garbled drug name — the patient is asked for a medicine they never mentioned');
});

ok('the whole dental class, not just the one word', () => {
  // Isolated to the DENTAL vocabulary ONLY. Three sentences were dropped from
  // this list after driving them, because each failed for a DIFFERENT reason
  // and keeping them here would let a fix for one masquerade as a fix for all:
  //   'molar nikalwana hai'       -> fires on `nikalwana`, romanized Hindi
  //   'dental checkup karana hai' -> fires on `karana`,    romanized Hindi
  //   'gum bleeding'              -> fires on `bleeding`,  which symptomMapping
  //                                  does not carry at all
  // The first two are the gap pinned at the bottom of this file. The third is a
  // real hole in tools/symptomMapping.js: `bleeding`, `swelling`, `vomiting`,
  // `burning` and `coughing` all return [] — so they trip this guard AND cannot
  // route a roster slice. Fixing that touches specialty routing, which is a
  // wider blast radius than this commit, so it is recorded and not attempted.
  for (const s of ['dental checkup', 'tooth pain hai', 'cavity hai', 'molar hai', 'teeth cleaning']) {
    assert.strictEqual(fires(s), false, `still fires on: ${s}`);
  }
});

// ── the guard must keep doing its job ───────────────────────────────────────
ok('a genuinely MANGLED drug still earns its re-ask', () => {
  // The case the guard was built for: Metformin snapped to Metamorphosin.
  assert.strictEqual(fires('Metamorphosin leta hoon'), true,
    'the guard stopped catching mangled drug names — this is the regression that matters');
});

ok('insulin: the guard steps back and the meds path still captures it', () => {
  // The most consequential of the 25 lexicon collisions. Both halves asserted:
  // the re-ask goes away AND the molecule is still recorded.
  assert.strictEqual(fires('main insulin leta hoon'), false);
  assert(captures('main insulin leta hoon').some((c) => /insulin/i.test(c)),
    'insulin stopped being captured — the collision IS a real loss and this fix must be reverted');
});

ok('a resolvable brand is untouched', () => {
  assert.strictEqual(fires('Zonagran chal rahi hai'), false);
  assert(captures('Zonagran chal rahi hai').includes('Zonisamide'));
});

ok('a clean "no medicines" answer stays silent', () => {
  for (const s of ['koi dawai nahi', 'कोई दवाई नहीं', 'नहीं जी']) {
    assert.strictEqual(fires(s), false, `invented a medicine question from: ${s}`);
  }
});

// ── what this fix does NOT close, pinned so it is not mistaken for done ─────
ok('KNOWN GAP: romanized Hindi still trips the guard, and it is a wider class', () => {
  // The token loop returns the FIRST Latin token of 6+ chars that is not a
  // stopword. In "मुझे अपने दांत dikhane hain dentist ko", `dikhane` — Hindi
  // for "to show", written in Latin by a code-mix STT — comes before
  // `dentist`, so the guard still asks about a verb. Closing this needs a
  // romanized-Hindi filter, not another vocabulary list, and is NOT attempted
  // here. Asserted as TRUE so that if someone does fix it, this test fails and
  // forces the note to be rewritten rather than silently rotting.
  assert.strictEqual(fires('मुझे अपने दांत dikhane hain dentist ko'), true,
    'romanized Hindi no longer trips the guard — good news; update this test and the note above');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
