#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// AT A SKIN CLINIC THE ADVICE QUESTION IS ABOUT A CREAM, NOT A TABLET.
//
// medicalAdviceGuard's patterns were written for a GP clinic, where "what
// should I take?" means a medicine. Measured against the guard on 2026-08-25,
// before this pack existed:
//     "कौन सी क्रीम लगाऊँ"              → NO HIT
//     "meri skin pe laser chalega kya"  → NO HIT
//     "कौन सी दवाई लूँ"                  → caught (the GP shape, working fine)
// So a GP clinic has a deterministic floor under the prompt line and an
// aesthetic clinic had none — and this module's own header is explicit that a
// prompt line is what a doctor-judge jailbreaks.
//
// THE SECOND DIRECTION MATTERS AS MUCH AS THE FIRST. "laser hair removal kitne
// ka hai" and "hydrafacial book karna hai" ARE the calls Skin Essence is paying
// for. A guard that deflects those has replaced a safety gap with a broken
// product, so every pattern here requires an advice-seeking SHAPE — which/what
// product, what should I apply, or a suitability judgement about one person's
// own skin — and never a treatment name on its own.
//
// Run:            node tests/test-advice-guard-derm.js
// Prove it fails: MUTANT=MUT-NO-DERM-PACK node tests/test-advice-guard-derm.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nADVICE GUARD — dermatology and aesthetic\n');

const guard = require('../medicalAdviceGuard.js');
const DERM_TYPES = /^(which_cream|apply_what|apply_product|suitability|safe_condition)/;

// MUT-NO-DERM-PACK: the guard is restored to its GP-only vocabulary by
// discarding exactly the hits the new patterns produce.
const raw = guard.detectMedicalAdvice;
const detect = MUTANT === 'MUT-NO-DERM-PACK'
  ? (t, l) => { const h = raw(t, l); return h && DERM_TYPES.test(h.type) ? null : h; }
  : raw;
if (MUTANT === 'MUT-NO-DERM-PACK') console.log('  [MUTANT] MUT-NO-DERM-PACK — GP vocabulary only\n');

// ── [1] The two measured misses, verbatim ────────────────────────────────
for (const q of ['कौन सी क्रीम लगाऊँ', 'meri skin pe laser chalega kya']) {
  ok(`the measured miss now deflects: ${q}`, () => {
    const hit = detect(q);
    assert.ok(hit, 'still returns null — the model would be free to answer');
  });
}

// ── [2] Advice-seeking, across the clinic's three languages ──────────────
const MUST_DEFLECT = [
  ['which cream should I use', 'en'],
  ['what serum should I apply', 'en'],
  ['will laser work on me', 'en'],
  ['is this safe for me', 'en'],
  ['मेरे लिए laser theek rahega kya', 'hi'],
  ['क्या लगाऊँ चेहरे पर', 'hi'],
  ['pregnancy mein peel safe hai', 'hi'],
  ['કઈ ક્રીમ લગાવું', 'gu'],
  ['મારા માટે લેસર ચાલશે?', 'gu'],
  ['મારી સ્કિન માટે બરાબર છે?', 'gu'],
];
for (const [q, lang] of MUST_DEFLECT) {
  ok(`deflects [${lang}] ${q}`, () => {
    assert.ok(detect(q), 'no hit — the model would answer a clinical question');
  });
}

// ── [3] THE CLINIC'S ACTUAL BUSINESS MUST GET THROUGH ────────────────────
// These are not edge cases; they are the reason the clinic bought the product.
// This block does not depend on the mutant — over-deflection would be a bug in
// either version, so it stays honest under both.
const MUST_PASS = [
  'laser hair removal kitne ka hai',
  'hydrafacial book karna hai',
  'chemical peel ke baare mein batao',
  'tattoo removal kitni sittings lagti hai',
  'doctor kab available hain',
  'મારે એપોઇન્ટમેન્ટ જોઈએ છે',
  'હાઇડ્રાફેશિયલ કેટલાનું છે',
  'mujhe pimples hain',
  'kal aa sakta hoon kya',
  'address kya hai aapka',
];
for (const q of MUST_PASS) {
  ok(`passes through (booking/price/info): ${q}`, () => {
    const hit = raw(q);
    assert.strictEqual(hit, null,
      `deflected as ${hit && hit.type} — this is the call the clinic is paying for`);
  });
}

// ── [4] The GP patterns are untouched ────────────────────────────────────
for (const q of ['कौन सी दवाई लूँ', 'what dose should I take', 'should I stop my insulin', 'is this cancer']) {
  ok(`GP vocabulary still fires: ${q}`, () => {
    assert.ok(raw(q), 'a pre-existing GP pattern stopped working');
  });
}

// ── [5] The deflection exists in Gujarati — the clinic's first language ───
// The language is the CALLER'S, passed in by callHandler as this._langCode() —
// the guard defaults to Marathi only when nobody says otherwise. Skin Essence
// pins gu-IN, so this asserts the shape production actually uses.
ok('a Gujarati caller gets the deflection in Gujarati, not the Marathi default', () => {
  const hit = detect('કઈ ક્રીમ લગાવું', 'gu-IN');
  assert.ok(hit, 'no hit');
  assert.ok(hit.response, 'the hit carries no deflection text');
  assert.match(String(hit.response), /[\u0A80-\u0AFF]/,
    `deflection is not in Gujarati script: ${hit.response}`);
});
ok('the same question in a Marathi call still deflects in Marathi', () => {
  const hit = detect('કઈ ક્રીમ લગાવું', 'mr-IN');
  assert.ok(hit && hit.response, 'no hit');
  assert.match(String(hit.response), /[\u0900-\u097F]/, `expected Devanagari: ${hit.response}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
