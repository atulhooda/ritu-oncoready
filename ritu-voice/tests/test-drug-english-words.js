#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ORDINARY ENGLISH WORDS MUST NOT BECOME DRUGS.
//
// The frozen suite CANNOT catch this class. s5.drug_false_positive is computed
// over 4,675 MUCS sentences containing ZERO Latin characters, so the entire
// English/code-mixed path is invisible to it — a change removing 38 invented
// molecules moved that metric by exactly 0.00pp. This file is the missing arm.
//
// WHAT WAS HAPPENING. The 116k brand index has heads that are also everyday
// words, and both matchers happily returned them:
//     "back pain se pareshan hoon"   → Baclofen        (a muscle relaxant)
//     "head bahut dukh raha hai"     → Sumatriptan
//     "tooth pain hai doctor"        → Chlorhexidine Gluconate
//     "मैं city area में रहता हूँ"      → Levocetirizine, Urea
//     "side effect ho raha hai"      → Aceclofenac
// Every one of those is a plausible-looking entry nobody would query. A missing
// drug is a gap; an invented one is a fabricated clinical record.
//
// BOTH ARMS, ALWAYS. The obvious "fix" — a dictionary sweep — was tried before
// with /usr/share/dict/words and deleted Crocin, Aten, Amlong, Candid and Keto:
// real brands that are also obscure English words. So every ordinary phrase here
// is matched by real drugs that must still be found. Narrowing a matcher without
// the recall arm is how you trade a visible bug for an invisible one.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { findAllDrugMentions } = require('../readback');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const found = (t) => (findAllDrugMentions(t, { brands: true, max: 3 }) || []).map((x) => x.canonical);

// ── ARM 1: ordinary speech must yield NOTHING ──────────────────────────────
// Drawn from what a patient actually says to a clinic receptionist, in Latin
// and code-mixed script, because that is what this product receives.
const ORDINARY = [
  'back pain se pareshan hoon',
  'head bahut dukh raha hai',
  'tooth pain hai doctor',
  'मैं city area में रहता हूँ',
  'I live in the city',
  'bacche ko check karana hai',
  'थोड़ा rest kar raha hoon',
  'side effect ho raha hai',
  'full body checkup karana hai',
  'line mein khada hoon',
  'clinic open hai kya',
  'left side mein dard hai',
  'first time aa raha hoon',
  'madam se baat karni hai',
  'change karna hai appointment',
  'north side ka clinic',
  'light si problem hai',
  'walk karke aaunga',
];

for (const t of ORDINARY) {
  check(`no drug from — "${t.slice(0, 40)}"`, () => {
    const got = found(t);
    if (got.length) throw new Error(`invented ${got.join(', ')}`);
  });
}

// ── ARM 2: real medicines must still be found ──────────────────────────────
// Includes the five the earlier dictionary sweep destroyed. If a future
// narrowing kills these, this arm goes red instead of the loss being discovered
// in a patient's record.
const REAL = [
  ['Crocin le raha hoon', 'Crocin — killed by the dictionary sweep'],
  ['Aten 50 leta hoon', 'Aten — killed by the dictionary sweep'],
  ['Amlong 5 mg', 'Amlong — killed by the dictionary sweep'],
  ['Dolo 650 chal rahi hai', 'the commonest brand in India'],
  ['Metformin aur Amlodipine dono leta hoon', 'two generics in one turn'],
  ['Azithromycin hai', 'generic'],
  ['Cetirizine chal rahi hai', 'generic'],
  ['Augmentin diya tha', 'brand → generic'],
  ['Shelcal calcium', 'brand'],
  ['Telma 40 leta hoon', 'brand with a strength'],
  ['Glycomet 500', 'brand with a strength'],
  ['Pantoprazole subah leta hoon', 'generic'],
];

for (const [t, why] of REAL) {
  check(`still found — ${why}`, () => {
    const got = found(t);
    if (!got.length) throw new Error(`LOST the drug in "${t}"`);
  });
}

// ── the checks must be able to fail ────────────────────────────────────────
check('MUTATION: the matcher is reachable and discriminating', () => {
  if (!found('Paracetamol le raha hoon').length) {
    throw new Error('the matcher finds nothing at all — ARM 2 is vacuous');
  }
  if (found('namaste kaise hain aap').length) {
    throw new Error('the matcher fires on a greeting — ARM 1 is vacuous');
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
