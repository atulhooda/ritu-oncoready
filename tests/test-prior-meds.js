// ─── THE CALLER'S OWN MOLECULES AS A PRIOR ───────────────────────────────────
// Threshold is a function of candidate-set size. Against 1,751 molecules the
// romanized bar is 0.28 — past that, ordinary Hindi starts resolving to drugs.
// Against the ~5 molecules THIS caller has already confirmed, the same edit
// distance is far stronger evidence, so 0.50 is affordable.
//
// Every garble below is real, taken from live calls or the eval corpus. The
// point of the prior is that these are not ambiguous strings — they are one
// specific patient's medication, mangled by an 8kHz line.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findDrugMention, findAllDrugMentions } = require('../readback');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nPRIOR MEDS — this caller\'s own list, at a bar a 1,751-item list cannot afford\n');

const PRIOR = ['Metformin', 'Amlodipine', 'Calpol'];

ok('recovers real 8kHz garbles that miss without it', () => {
  // Each of these returns nothing on the general path — verified below.
  for (const [text, want] of [
    ['Metamorphosin', 'Metformin'],
    ['एमलोडिपिन', 'Amlodipine'],
    ['काल बोल', 'Calpol'],
  ]) {
    const without = findDrugMention(text, { brands: true });
    assert(!without.mentioned, `"${text}" now resolves WITHOUT a prior — this fixture is stale, re-pick it`);
    const with_ = findDrugMention(text, { brands: true, prior: PRIOR });
    assert(with_.mentioned, `"${text}" still misses WITH the prior`);
    assert.strictEqual(with_.canonical, want);
    assert(with_.viaPrior, 'should be flagged viaPrior');
  }
});

ok('a prior cannot invent a drug the caller never confirmed', () => {
  // The prior only ever returns something already in its own list.
  const r = findDrugMention('Metamorphosin', { brands: true, prior: ['Atenolol'] });
  if (r.mentioned && r.viaPrior) {
    assert(PRIOR.concat(['Atenolol']).includes(r.canonical), 'returned something outside the prior list');
    assert.strictEqual(r.canonical, 'Atenolol');
  }
});

ok('the noise gate still applies — a tiny list at 0.50 is the LEAST supervised path', () => {
  // These are the words that were resolving to molecules before today's fixes.
  // A 5-item prior at 0.50 must not reopen that door.
  for (const junk of ['pase', 'aisa', 'clot', 'aram', 'limited', 'office']) {
    const r = findDrugMention(junk, { brands: true, prior: PRIOR });
    assert(!r.mentioned, `"${junk}" resolved to ${r.canonical} through the prior path`);
  }
});

ok('no prior behaves exactly as before', () => {
  for (const t of ['Metphormin', 'हाँ वो Metformin की दवाई चल रही है', 'pase', 'hello']) {
    const a = findDrugMention(t, { brands: true });
    const b = findDrugMention(t, { brands: true, prior: [] });
    const c = findDrugMention(t, { brands: true, prior: null });
    assert.deepStrictEqual(a, b, `empty prior changed the result for "${t}"`);
    assert.deepStrictEqual(a, c, `null prior changed the result for "${t}"`);
  }
});

ok('findAllDrugMentions keeps a NEW drug named alongside a prior one', () => {
  // A patient on Metformin may name something new in the same breath; returning
  // only the prior would silently lose it.
  const hits = findAllDrugMentions('Metamorphosin aur Cetirizine', { brands: true, max: 4, prior: PRIOR });
  const names = hits.map((h) => h.canonical);
  assert(names.includes('Metformin'), `lost the prior match: ${JSON.stringify(names)}`);
  assert(names.includes('Cetirizine'), `lost the NEW drug: ${JSON.stringify(names)}`);
});

ok('Devanagari adjacent-pair join — the Latin path always did this', () => {
  // "जी काल बोल" is Calpol arriving as two words. Gold row r23.d0.
  const r = findDrugMention('जी काल बोल', { brands: true, prior: PRIOR });
  assert(r.mentioned && r.canonical === 'Calpol', `got ${JSON.stringify(r)}`);
});

// ── the wiring, which is the half that has failed before ────────────────────
ok('callHandler FETCHES the prior and PASSES it', () => {
  const ch = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(/getPatientMedications\(/.test(ch),
    'callHandler never calls getPatientMedications — db.js exported it for weeks and nothing did');
  const passes = (ch.match(/prior: this\._priorMeds/g) || []).length;
  assert(passes >= 3, `prior passed at only ${passes} matcher call sites, expected 3`);
});

ok('MUTATION: the fixtures genuinely need the prior', () => {
  // If the general matcher ever learns these, this file must be re-pointed at
  // harder ones rather than quietly passing for the wrong reason.
  assert(!findDrugMention('Metamorphosin', { brands: true }).mentioned);
  assert(!findDrugMention('काल बोल', { brands: true }).mentioned);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
