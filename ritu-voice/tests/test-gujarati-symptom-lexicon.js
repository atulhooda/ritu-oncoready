#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// AT A GUJARATI SKIN CLINIC, "ITCHY SKIN" MAPPED TO NOTHING.
//
// The symptom lexicon carries Hindi and Marathi body-part forms. Gujarati
// arrives after toDevanagari as its own forms — પગ → पग, માથું → माथुं, તાવ →
// ताव, ખંજવાળ → खंजवाळ — and none of them were listed. Measured on the ten
// complaints used for the Marathi fix: Gujarati 4/10, and the misses were leg,
// headache, stomach, fever, chest and itch. Skin Essence opens Gujarati-first;
// a no-match means no roster slice and no symptom-driven intake.
//
// The rule from the Marathi fix holds here: forms are listed EXPLICITLY, with
// their locative suffixes, inside the existing emulated-boundary compile — so
// nothing here can reintroduce the substring class ("दिला दो" → दिल).
//
// Run: node tests/test-gujarati-symptom-lexicon.js
// (No runtime seam for a mutant; proved by reversion — see the commit.)
// ═══════════════════════════════════════════════════════════════════════════
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { const r = f(); if (r && typeof r.then === 'function') throw new Error('async'); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
console.log('\nGUJARATI SYMPTOM LEXICON\n');
const { specialtiesForSymptom } = require('../tools/symptomMapping.js');
const { toDevanagari } = require('../devanagari.js');
const map = (q) => specialtiesForSymptom(q + ' ' + toDevanagari(q));

const TABLE = [
  ['મારો પગ દુખે છે', 'leg pain', /ortho/i], ['માથું દુખે છે', 'headache', /neuro/i], ['પેટમાં દુખે છે', 'stomach ache', /internal|gastro/i],
  ['દાંત દુખે છે', 'toothache', /dent/i], ['તાવ આવે છે', 'fever', /internal/i], ['છાતીમાં દુખે છે', 'chest pain', /cardio/i],
  ['ખાંસી આવે છે', 'cough', /internal/i], ['આંખ દુખે છે', 'eye pain', /ophth/i], ['કમર દુખે છે', 'back pain', /ortho/i], ['ચામડી પર ખંજવાળ', 'itchy skin', /derm/i],
];
for (const [q, en, re] of TABLE) ok(`${en.padEnd(13)} "${q}"`, () => { const s = map(q); assert.ok(s.some((x) => re.test(x)), `→ ${JSON.stringify(s)}`); });
ok('Gujarati matches all ten (was 4/10)', () => assert.strictEqual(TABLE.filter(([q]) => map(q).length).length, 10));

// The complaints a skin clinic actually hears
for (const [q, en] of [['ખીલ થાય છે', 'pimples'], ['ત્વચા પર ડાઘ', 'spots'], ['વાળ ખરે છે', 'hair fall'], ['ખંજવાળ આવે છે', 'itching']]) {
  ok(`dermatology: ${en.padEnd(9)} "${q}"`, () => assert.ok(map(q).some((x) => /derm/i.test(x)), `→ ${JSON.stringify(map(q))}`));
}
// And the boundary discipline survives
ok('a booking sentence with no complaint maps to nothing', () => assert.strictEqual(map('મારે કાલે એપોઇન્ટમેન્ટ જોઈએ છે').length, 0));
ok('"कमरे में" (a room) still maps to nothing', () => assert.strictEqual(map('कमरे में बैठा हूँ').length, 0));
ok('Hindi and Marathi tables are untouched (10/10 each)', () => {
  const hi = ['पैर में दर्द','सिर में दर्द','पेट में दर्द','दांत में दर्द','बुखार है','छाती में दर्द','खांसी आ रही है','आँख में दर्द','कमर में दर्द','त्वचा में खुजली'];
  const mr = ['पाय दुखतोय','डोकं दुखतंय','पोट दुखतंय','दात दुखतोय','ताप आलाय','छातीत दुखतंय','खोकला येतोय','डोळे दुखतात','कंबर दुखते','त्वचेला खाज'];
  assert.strictEqual(hi.filter((q) => map(q).length).length, 10); assert.strictEqual(mr.filter((q) => map(q).length).length, 10);
});
// ─── the same complaint must map to the same specialties in every script ───
// reasonSupported() compares specialty sets between the caller's words and the
// model's reason. Hindi पेट → Internal Medicine while Marathi पोट and Kannada
// ಹೊಟ್ಟೆ → Gastroenterology meant a Marathi caller's true complaint was refused
// as "invented" the moment the model summarised it in Hindi. Parity is the guard.
console.log('\n[parity] abdominal complaint, five scripts, one specialty set');
{
  const forms = ['पेट दर्द', 'पोटात दुखतंय', 'ಹೊಟ್ಟೆ ನೋವು', 'stomach pain', 'મને પેટમાં દુખાવો છે'];
  const sets = forms.map((q) => JSON.stringify(map(q).slice().sort()));
  ok('all five forms map to the SAME specialty set', () => assert.ok(sets.every((x) => x === sets[0]), sets.join(' | ')));
  ok('...and that set is non-empty', () => assert.ok(map('पेट दर्द').length > 0));
}

// ─── the roster slice sees Gujarati too ─────────────────────────────────────
// The guard and the intake probe transliterated; sliceRoster read the raw
// text, so a Gujarati caller's complaint narrowed the roster to nothing.
console.log('\n[slice] a Gujarati complaint narrows the roster like a Hindi one');
{
  process.env.ENABLE_ROSTER_SLICE = 'true';
  delete require.cache[require.resolve('../brain-lean.js')];
  const lean = require('../brain-lean.js');
  lean._setRosterForTest({ text: '', doctors: [
    { id: 'g', name: 'डॉ. गुप्ता', specialty: 'Gastroenterologist', windows: [], taken: [] },
    // the abdominal complaint maps to Gastro AND Internal Medicine (lexicon parity); the slicer's
    // fail-safe returns the FULL roster when a named specialty has no doctor, so both must exist
    { id: 'p', name: 'डॉ. पाटील', specialty: 'Internal Medicine', windows: [], taken: [] },
    { id: 'd', name: 'डॉ. देसाई', specialty: 'Dermatologist', windows: [], taken: [] },
    { id: 'o', name: 'डॉ. ओक', specialty: 'Orthopedic', windows: [], taken: [] },
    { id: 'e', name: 'डॉ. ईरानी', specialty: 'ENT', windows: [], taken: [] },
  ] });
  const gu = lean.sliceRoster([], { patientTextAll: 'મને પેટમાં દુખાવો છે બે દિવસથી' });
  const hi = lean.sliceRoster([], { patientTextAll: 'मुझे पेट में दर्द है दो दिन से' });
  ok('Gujarati complaint → sliced',                    () => assert.strictEqual(gu.sliced, true, JSON.stringify(gu).slice(0, 120)));
  ok('...to the same specialties as the Hindi one',   () => assert.deepStrictEqual((gu.specs || []).slice().sort(), (hi.specs || []).slice().sort()));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
