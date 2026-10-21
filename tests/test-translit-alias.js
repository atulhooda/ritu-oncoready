// ─── THE ALIAS TIER ─────────────────────────────────────────────────────────
// Some molecules cannot be reached by ANY threshold, because the thing that
// separates them from a false positive is not distance.
//
// MEASURED 2026-08-06 over all 1,169 distinct gold surfaces: कैल्शियम sits
// 0.333 from `calcium`, and कोलेस्ट्रॉल (cholesterol — not a drug at all) sits
// 0.300 from `fosfestrol`, an ESTROGEN, 32 times. Any bar loose enough to admit
// the first admits the second first. The 0.28→0.45 band is 89 surfaces and is
// dominated by conditions landing on unrelated molecules — डायबिटीज→dasatinib
// (85x), किडनी→lindane, छींक→choline.
//
// So the fix is exact surfaces, not a looser bar. This file exists to keep it
// exact: the moment an alias starts matching fuzzily it becomes the widening
// it was built to avoid.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { findDrugMention, findAllDrugMentions, _generics } = require('../readback');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const hit = (s) => findDrugMention(s, { brands: true });
const canon = (s) => { const m = hit(s); return m.mentioned ? m.canonical : null; };

console.log('\nTRANSLITERATION ALIASES — exact surfaces, not a looser bar\n');

// The eight entries, with their gold frequency. If one of these regresses the
// recall it bought goes with it.
const ALIASES = [
  ['कैल्शियम', 'Calcium', 37],
  ['एसिक्लोफेनेक', 'Aceclofenac', 20],
  ['सेरेसियोपेप्टिडेस', 'Serratiopeptidase', 10],
  ['लिवोसल्पिराइड', 'Levosulpiride', 6],
  ['एल-मिथाइल फोलेट', 'L-Methyl Folate', 6],
  ['मैग्नीशियम', 'Magnesium', 6],
  ['एसिटाइलसिस्टीन', 'Acetylcysteine', 5],
  ['टॉरीन', 'Taurine', 5],
];

ok('every alias resolves to its molecule', () => {
  for (const [surface, expected] of ALIASES) {
    assert.strictEqual(canon(surface), expected, `${surface} → expected ${expected}`);
  }
});

ok('every alias canonical is a REAL entry in drug_generics.json', () => {
  // An alias pointing at a molecule the lexicon does not contain would resolve
  // to a name nothing downstream can act on — a phantom drug, worse than a miss.
  const G = new Set(_generics);
  for (const [, expected] of ALIASES) {
    assert(G.has(expected), `${expected} is not in the generics list`);
  }
});

ok('aliases work without the brand index too', () => {
  // The tier runs before the brand fallback, so it must not silently depend on
  // brands:true — meds turns enable brands, ordinary turns do not.
  for (const [surface, expected] of ALIASES) {
    const m = findDrugMention(surface, { brands: false });
    assert.strictEqual(m.mentioned && m.canonical, expected, `${surface} without brands`);
  }
});

// ── the whole reason this is a table and not a threshold ────────────────────
ok('the 0.28-0.45 band stays OUT — conditions never become molecules', () => {
  // Each of these is closer to a molecule than कैल्शियम is to calcium, or close
  // enough that one loosening step reaches it. All are conditions, organs or
  // dosage forms. If any resolves, the bar moved.
  const MUST_MISS = [
    'डायबिटीज',      // 85x → dasatinib at 0.444
    'कोलेस्ट्रॉल',   // 32x → fosfestrol at 0.300 — INSIDE any bar admitting calcium
    'फेफड़ों',       // 26x → heparin ("lungs")
    'छींक',          // 20x → choline ("sneeze")
    'किडनी',         //  6x → lindane, a scabies treatment
    'स्ट्रिप',       // 44x → estriol (a dosage form)
    'सर्जरी',        //  6x → warfarin ("surgery")
    'ब्लीडिंग',      //  6x → buclizine ("bleeding")
  ];
  for (const s of MUST_MISS) {
    const got = canon(s);
    assert.strictEqual(got, null, `${s} resolved to ${got} — a condition became a drug`);
  }
});

// ── failure #1, caught during the build: components are different molecules ──
ok('a component of a multi-word alias is NOT that alias', () => {
  // The first expansion registered every token of every surface, so bare
  // "folet" (folate) mapped to L-methyl folate. They are different molecules,
  // and that is precisely the wrong-drug error this tier exists to prevent.
  // Single tokens are now admitted only from single-WORD surfaces.
  for (const s of ['फोलेट', 'folate', 'मिथाइल']) {
    assert.notStrictEqual(canon(s), 'L-Methyl Folate', `${s} must not be L-Methyl Folate`);
  }
});

// ── failure #2, caught during the build: a key nothing can produce ──────────
ok('MUTATION: alias keys are reachable by the candidate builder', () => {
  // "एल-मिथाइल फोलेट" romanizes to "el-mithail folet". The builder scans
  // /[a-z]{3,}/ and joins adjacent pairs, so the two-char "el" disappears and
  // the only producible form is "mithailfolet". The hand-written key
  // "elmithailfolet" matched nothing and the table LOOKED correct. Every
  // multi-word alias must therefore prove itself through the real matcher.
  for (const [surface, expected] of ALIASES.filter(a => /[\s-]/.test(a[0]))) {
    assert.strictEqual(canon(surface), expected, `${surface} is unreachable — key shape wrong`);
  }
});

ok('MUTATION: aliases match EXACTLY, never fuzzily', () => {
  // One edit inside an alias key must not still land on the alias. If it does,
  // the tier has acquired a threshold and inherits every problem above.
  const NEAR = ['calchiyan', 'kalshiyum', 'magnishiyan', 'levosalpiraidx'];
  for (const q of NEAR) {
    const m = findDrugMention(q, { brands: false });
    assert(!m.viaAlias, `${q} matched the alias tier fuzzily`);
  }
});

// ── the case the speculative tier deliberately refused to guess ─────────────
ok('एसिक्लोफेनेक is Aceclofenac and NEVER Diclofenac', () => {
  // 2026-08-05 left this unresolved on purpose: the right molecule and the
  // wrong one (Diclofenac) sit at an IDENTICAL 0.273 from the romanization, so
  // the matcher was taking whichever it reached first and no threshold could
  // ever separate them. Knowing the word is the only thing that can.
  const m = hit('एसिक्लोफेनेक');
  assert.strictEqual(m.canonical, 'Aceclofenac');
  assert(m.viaAlias, 'must come from the alias tier, not a widened bar');
});

ok('कोरल कैल्शियम डी3 resolves to Calcium, not Tobramycin', () => {
  // This exact surface was a suite FLIP earlier today: it had been passing as a
  // recall hit via "coral" → Tobramycin, a wrong molecule. Blocking `coral`
  // retired it to a miss; the alias now makes it a CORRECT hit.
  assert.strictEqual(canon('कोरल कैल्शियम डी3'), 'Calcium');
});

ok('an alias beats the fuzzy prior', () => {
  // The prior matches at 0.50 — far looser than anything else in the matcher.
  // Exact identity must outrank it, or a caller with one drug on file could
  // have a different drug they just NAMED rewritten into it.
  const m = findDrugMention('कैल्शियम', { brands: true, prior: ['Metformin', 'Amlodipine'] });
  assert.strictEqual(m.canonical, 'Calcium');
  assert(m.viaAlias && !m.viaPrior, 'prior overrode an exact alias');
});

ok('aliases coexist with other drugs in the same sentence', () => {
  const got = findAllDrugMentions('मैं कैल्शियम और मेटफॉर्मिन लेता हूं', { brands: true })
    .map(x => x.canonical).sort();
  assert.deepStrictEqual(got, ['Calcium', 'Metformin']);
});

// ── SECOND PASS: all 887 unresolved surfaces classified ────────────────────
const ALIASES_2 = [
  ['\u0915\u094d\u0932\u0948\u0935\u094d\u092f\u0941\u0932\u0947\u0928\u093f\u0915 \u090f\u0938\u093f\u0921', 'Clavulanic Acid', 15],
  ['\u090f\u0938\u093f\u091f\u093e\u092e\u093f\u0928\u094b\u092b\u0947\u0928', 'Paracetamol', 6],
  ['\u092b\u094d\u0932\u093e\u0907\u0915\u094d\u091f\u093e\u0938\u094b\u0928 \u092a\u094d\u0930\u094b\u092a\u093f\u092f\u094b\u0928\u0947\u091f', 'Fluticasone Propionate', 5],
  ['\u0907\u0935\u0928\u093f\u0902\u0917 \u092a\u094d\u0930\u093f\u092e\u0930\u094b\u091c \u0911\u092f\u0932', 'Evening Primrose Oil', 5],
  ['\u0917\u094d\u0932\u093f\u0915\u094d\u0932\u0947\u091c\u093e\u0907\u0921', 'Gliclazide', 5],
  ['\u0915\u094b\u0932\u0947\u0902\u091c\u0928 \u091f\u0948\u092c\u0932\u0947\u091f', 'Collagen Peptide', 5],
  ['\u0915\u094b\u0932\u0947\u091c\u0928', 'Collagen Peptide', 5],
  ['\u092c\u0948\u0938\u093f\u0932\u0938 \u0915\u094d\u0932\u0949\u0938\u0940', 'Bacillus Clausii', 5],
  ['\u090f\u0932\u0947\u0902\u0921\u094d\u0930\u0949\u0928\u093f\u0915 \u090f\u0938\u093f\u0921', 'Alendronic Acid', 5],
  ['\u092b\u094b\u0932\u0947\u091f', 'Folic Acid', 5],
  ['\u0915\u0949\u0921 \u0932\u093f\u0935\u0930 \u0911\u092f\u0932', 'Cod liver oil', 5],
  ['\u0926\u0942\u0927 \u0915\u0947 \u0925\u093f\u0938\u0932', 'Silymarin', 5],
  ['\u092a\u093e\u092f\u0930\u0947\u0938\u0947\u091f\u092e', 'Piracetam', 5],
];

ok('second pass: all 13 resolve, and their canonicals are real', () => {
  const G = new Set(_generics);
  for (const [surface, expected] of ALIASES_2) {
    assert.strictEqual(canon(surface), expected, `${surface} -> expected ${expected}`);
    assert(G.has(expected), `${expected} is not in the generics list`);
  }
});

ok('LONGEST alias wins, not whichever candidate comes first', () => {
  // Registering \u092b\u094b\u0932\u0947\u091f (folate) -> Folic Acid gave "\u090f\u0932-\u092e\u093f\u0925\u093e\u0907\u0932 \u092b\u094b\u0932\u0947\u091f" TWO live keys:
  // mithailfolet (L-Methyl Folate) and folet (Folic Acid). Returning the first
  // would make the answer depend on candidate ORDER inside buildCandidates —
  // an implementation detail. The more specific surface must win.
  assert.strictEqual(canon('\u090f\u0932-\u092e\u093f\u0925\u093e\u0907\u0932 \u092b\u094b\u0932\u0947\u091f'), 'L-Methyl Folate');
  assert.strictEqual(canon('\u092b\u094b\u0932\u0947\u091f'), 'Folic Acid');
});

ok('MUTATION: an alias-only join never reaches the FUZZY matcher', () => {
  // "\u0915\u094d\u0932\u0948\u0935\u094d\u092f\u0941\u0932\u0947\u0928\u093f\u0915 \u090f\u0938\u093f\u0921" needs a join across "esid" (acid), which
  // isNoise() blocks — the same guard that stops "\u0921\u094b\u0932\u094b \u0914\u0930" becoming "dolour" ->
  // Aceclofenac. Those joins are now emitted as aliasOnly so the exact tier can
  // see them; if the fuzzy loops ever stop skipping them, the guard is gone and
  // this is what comes back.
  // \u0921\u094b\u0932\u094b \u0914\u0930 resolves to Paracetamol via the bare token "dolo", which is a
  // REAL brand and correct. What must never come back is the JOINED form:
  // "dolo"+"aur" -> "dolour", which used to fuzzy-match Aceclofenac. The join
  // is still emitted (as aliasOnly) so the exact tier can use it, so this
  // asserts the molecule, not merely that something matched.
  const dolo = hit('\u0921\u094b\u0932\u094b \u0914\u0930');
  assert.strictEqual(dolo.canonical, 'Paracetamol', 'the real brand Dolo must still win');
  assert.notStrictEqual(dolo.surface, 'dolour', 'the noisy join reached the fuzzy matcher');
  assert.strictEqual(canon('\u0915\u094d\u0932\u0948\u0935\u094d\u092f\u0941\u0932\u0947\u0928\u093f\u0915 \u090f\u0938\u093f\u0921'), 'Clavulanic Acid');
});

ok('the two REJECTED candidates stay unresolved', () => {
  // \u091f\u0947\u0928\u094b\u092b\u094b\u0935\u0940\u0930: the lexicon holds BOTH Tenofovir Alafenamide and Tenofovir
  // disoproxil fumarate. Bare "tenofovir" does not say which salt, and picking
  // one records the wrong product for a patient on the other. Unlike
  // Aceclofenac, no exact surface settles this — the ambiguity is in what the
  // patient SAID.
  assert.strictEqual(canon('\u091f\u0947\u0928\u094b\u092b\u094b\u0935\u0940\u0930'), null);
  // \u0938\u0940\u091f\u0940\u0921\u0940: CTD is Chlorthalidone here, but also ordinary clinical
  // shorthand for connective tissue disease.
  assert.strictEqual(canon('\u0938\u0940\u091f\u0940\u0921\u0940 6.25 \u090f\u092e\u091c\u0940'), null);
});

// ── THE SHORT-TOKEN JOIN: the "Pan D" class ────────────────────────────────
ok('\u092a\u0948\u0928 \u0921\u0940 resolves, and bare "pan" never does', () => {
  // \u092a\u0948\u0928 is 3 chars and \u0921\u0940 is 2, so the /[\u0900-\u097f]{3,}/ scan dropped \u0921\u0940
  // entirely and the >=4 alias floor refused "pan". The drug was unreachable
  // from BOTH ends. The fix is a join over ALL tokens, emitted aliasOnly.
  assert.strictEqual(canon('\u092a\u0948\u0928 \u0921\u0940'), 'Pantoprazole');
  assert.strictEqual(canon('\u092e\u0941\u091d\u0947 \u092a\u0948\u0928 \u0921\u0940 \u091a\u0932 \u0930\u0939\u0940 \u0939\u0948'), 'Pantoprazole');
  // The whole reason a lower floor was refused: "pan" is a word in Hindi AND
  // English. Registering it would repeat the fort/shot/rapid mistake.
  for (const s of ['\u092a\u0948\u0928', 'pan', '\u092a\u0948\u0928 \u092e\u0947\u0902 \u0926\u0930\u094d\u0926']) {
    assert.strictEqual(canon(s), null, `${s} resolved — the short-token floor leaked`);
  }
});

ok('MUTATION: short-token joins are aliasOnly, never fuzzy', () => {
  // If these joins ever reached the fuzzy matcher, every 1-2 char Hindi
  // postposition would start fusing with its neighbour and inventing drugs.
  // \u0921\u094b\u0932\u094b \u0914\u0930 is the canonical case: it must resolve via the real brand
  // \u0921\u094b\u0932\u094b, and NEVER via the joined "dolour".
  const d = hit('\u0921\u094b\u0932\u094b \u0914\u0930');
  assert.strictEqual(d.canonical, 'Paracetamol');
  assert.notStrictEqual(d.surface, 'dolour', 'a short-token join reached the fuzzy matcher');
  const rb = require('fs').readFileSync(require('path').join(__dirname, '..', 'readback.js'), 'utf8');
  assert(/aliasOnly: true \}\);\n    \}/.test(rb) || /aliasOnly: true/.test(rb),
    'the short-token join is no longer marked aliasOnly');
});

ok('the ordinary path is untouched — aliases only ADD', () => {
  assert.strictEqual(canon('पैरासिटामोल'), 'Paracetamol');
  assert.strictEqual(canon('मेटफॉर्मिन'), 'Metformin');
  assert.strictEqual(canon('कैल्सियम'), 'Calcium');   // the स spelling, which always worked
  assert.strictEqual(canon('डाइक्लोफेनेक'), 'Diclofenac');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
