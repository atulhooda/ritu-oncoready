// ─── SPECULATIVE TRANSLITERATION ────────────────────────────────────────────
// The drug-capture ceiling was read as 38.7% and treated as a lexicon problem.
// It was neither. Of 814 gold spans, 278 name no molecule at all ("टैबलेट",
// "एंटीबायोटिक", "15 टैबलेट") and must NEVER match; against the 536 that do,
// the ceiling is 49.8%. And the misses are ordinary molecules already in the
// lexicon, failing purely on how Devanagari was romanized.
//
// Three chained substitutions bridge them — but as SPECULATION, held to a
// tighter bar and kept away from the brand index. This file exists because the
// first two attempts at that were wrong in instructive ways, and both would
// look fine without these assertions.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { findDrugMention } = require('../readback');
const { speculativeVariants, romanizeVariants } = require('../devanagari');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const canon = (s) => { const m = findDrugMention(s, { brands: true }); return m.mentioned ? m.canonical : null; };

console.log('\nSPECULATIVE TRANSLITERATION — recall that costs no precision\n');

ok('molecules that were missing on transliteration alone now resolve', () => {
  assert.strictEqual(canon('डाइक्लोफेनेक'), 'Diclofenac');       // daiklofenek
  assert.strictEqual(canon('मिथाइलकोबालामिन'), 'Methylcobalamin'); // mithailakobalamin
  assert.strictEqual(canon('ग्लाइमपाइराइड'), 'Glimepiride');
});

ok('and the ones that already worked are untouched', () => {
  assert.strictEqual(canon('पैरासिटामोल'), 'Paracetamol');
  assert.strictEqual(canon('मेटफॉर्मिन'), 'Metformin');
});

// ── failure #1: a WRONG molecule, which is worse than a miss ────────────────
ok('एसिक्लोफेनेक never resolves to DICLOFENAC — the wrong-drug case', () => {
  // Adding these rules to the ordinary AMBIGUOUS table resolved Aceclofenac to
  // Diclofenac. MEASURED: both sit at norm 0.273 from the romanization, so the
  // right answer and the wrong one are EXACTLY equidistant and the matcher was
  // simply taking whichever it reached first. No threshold separates them —
  // that one needs a lexicon entry. What must never happen is confidently
  // returning the other NSAID.
  const got = canon('एसिक्लोफेनेक');
  assert.notStrictEqual(got, 'Diclofenac', 'resolved to the WRONG molecule');
  assert(got === null || got === 'Aceclofenac', `unexpected: ${got}`);
});

// ── failure #2: the brand index, which was the real cause ───────────────────
ok('speculative variants NEVER reach the 116k brand index', () => {
  // Admitting them there took false positives 0.90 -> 3.49 even at a 0.12 bar,
  // WORSE than the 2.93 the loose rules produced — which is what proved the
  // threshold was never the problem. A guessed transliteration against 116k
  // registered brands finds a near-exact collision by chance.
  const fs = require('fs');
  const path = require('path');
  const rb = fs.readFileSync(path.join(__dirname, '..', 'readback.js'), 'utf8');
  // Scan to the END of the brand loop, not a fixed 1200-char window. The
  // window broke on 2026-08-06 for the worst possible reason: the guard was
  // still there, and someone had documented WHY more thoroughly, which pushed
  // it past the cutoff. A test that fails when a comment grows is measuring
  // source layout, not behaviour.
  // Locate the guard by POSITION relative to the brand loop, not by slicing to
  // an end-marker: `const GENERICS` is declared near the top of the file, so
  // slicing to it produced an EMPTY string and a confident false failure.
  const brandsAt = rb.indexOf('if (brands) {');
  const guardAt = rb.indexOf('if (speculative) continue;');
  assert(brandsAt > 0, 'the brand loop moved');
  assert(guardAt > brandsAt,
    'the brand loop no longer excludes speculative candidates');
  assert(!/if \(speculative && /.test(rb),
    'the exclusion has been CONDITIONED — exact-only was tried on 2026-08-06 and ' +
    'took drug_false_positive 0.43 -> 3.02 and fp_codemix_stt 0.94 -> 3.99, ' +
    'flipping seven canaries. It is not a safer variant of the same idea.');
});

ok('the tighter bar is real and below the ordinary romanized one', () => {
  const fs = require('fs');
  const path = require('path');
  const rb = fs.readFileSync(path.join(__dirname, '..', 'readback.js'), 'utf8');
  const spec = parseFloat((rb.match(/SPECULATIVE_MAX_DIST = ([\d.]+)/) || [])[1]);
  const roman = parseFloat((rb.match(/ROMAN_MAX_DIST = ([\d.]+)/) || [])[1]);
  assert(spec > 0 && spec < roman, `speculative ${spec} must be tighter than romanized ${roman}`);
});

ok('speculative variants are ADDITIONAL, never a replacement', () => {
  // If they ever supplanted the base romanization, every existing hit would be
  // re-litigated at the tight bar and recall would fall silently.
  const base = romanizeVariants('मेटफॉर्मिन');
  const spec = speculativeVariants('मेटफॉर्मिन');
  for (const v of spec) assert(!base.includes(v), `${v} is in BOTH lists — the tiers have merged`);
});

ok('a word with no speculative rule applicable yields nothing extra', () => {
  assert.strictEqual(speculativeVariants('').length, 0);
  assert.doesNotThrow(() => speculativeVariants(null));
});

ok('MUTATION: widening the bar to the romanized one reintroduces the wrong drug', () => {
  // The guard is the BAR plus the brand exclusion. If a future change loosens
  // SPECULATIVE_MAX_DIST to 0.28, एसिक्लोफेनेक→Diclofenac comes back — that is
  // what this file is here to stop, so assert the distance that makes it so.
  const lev = (a, b) => { const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let p = [...Array(n + 1).keys()], c = [];
    for (let i = 1; i <= m; i++) { c = [i]; for (let j = 1; j <= n; j++)
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
    return p[n]; };
  let best = 1;
  for (const v of speculativeVariants('एसिक्लोफेनेक')) {
    const n = lev(v, 'diclofenac') / Math.max(v.length, 'diclofenac'.length);
    if (n < best) best = n;
  }
  assert(best > 0.19, `Diclofenac is reachable at ${best.toFixed(3)} — the bar must stay below it`);
});

// ─── THE TWO MATCHERS MUST NOT DRIFT ────────────────────────────────────────
// findDrugMention and findAllDrugMentions share a candidate builder precisely so
// a fix to one cannot miss the other. Their BRAND GATING drifted anyway, and it
// stayed drifted for two days while the file carried a comment promising it
// could not.
//
// The cost was live. दवाई is the Hindi word for MEDICINE — every patient says
// it. It speculates to "davi", and BRANDS['davi'] is Dapagliflozin: an exact
// hit at score 1.0 that no distance cap refuses. findDrugMention blocked it;
// findAllDrugMentions did not, and findAllDrugMentions is what the meds turn
// calls. So "कोई दवाई नहीं" (no medicines at all) resolved to an SGLT2 diabetes
// drug, and the stage advanced as though a medicine had been named — throwing
// away the real one the patient gave next.
//
// The suite did not catch it and still cannot: no corpus here contains that
// phrase at a meds turn. So the guard is PARITY, not a word list. A word list
// would need the bug to be imagined in advance; parity fails whenever the two
// disagree about anything.
ok('MUTATION: the two matchers agree on what reaches the brand index', () => {
  const { findAllDrugMentions } = require('../readback');
  const PROBES = [
    'दवाई', 'कोई दवाई नहीं', 'हाँ एक दवाई चल रही है', 'नहीं कोई दवाई नहीं',
    'गोली', 'टैबलेट', 'दवा', 'इलाज', 'मेडिसिन',
    'मेटफॉर्मिन', 'कैल्शियम', 'डोलो', 'टेल्मा', 'पैरासिटामोल',
    'डायबिटीज', 'कोलेस्ट्रॉल', 'सर दर्द', 'पेट में दर्द',
  ];
  const disagree = [];
  for (const p of PROBES) {
    const one = findDrugMention(p, { brands: true });
    const all = findAllDrugMentions(p, { brands: true });
    const a = one.mentioned ? one.canonical : null;
    const b = all.length ? all[0].canonical : null;
    if (a !== b) disagree.push(`${p}: findDrugMention=${a} findAllDrugMentions=${b}`);
  }
  assert.strictEqual(disagree.length, 0,
    'the matchers disagree — one of them is gating brands differently:\n      ' + disagree.join('\n      '));
});

ok('the Hindi word for MEDICINE is not a medicine', () => {
  // Kept as an explicit case alongside the parity check, because this one is
  // said on essentially every call and its absence would be invisible.
  const { findAllDrugMentions } = require('../readback');
  for (const p of ['दवाई', 'कोई दवाई नहीं', 'हाँ एक दवाई चल रही है']) {
    assert.strictEqual(findAllDrugMentions(p, { brands: true }).length, 0,
      `${p} resolved to a drug`);
    assert.strictEqual(canon(p), null, `${p} resolved to a drug`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
