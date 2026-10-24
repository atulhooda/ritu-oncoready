#!/usr/bin/env node
// ─── "IS ANYONE FREE?" ANSWERED FROM 2 OF 25 DOCTORS ────────────────────────
// LIVE CALL 0a0f0d8f3c4cc14f2927b8adb06e1a85, Wed 2026-08-05 11:03 IST:
//
//     patient  "कोई अभी doctor available है तुरंत"
//     RITU     "अभी के लिए Dr. Manoj Deo ही सबसे जल्दी उपलब्ध हैं, शाम 5:00 से"
//
// NINE doctors were mid-session at that moment — Anjali Deshmukh 10:00-14:00,
// and eight more on 10:00-13:00. `diagnostics.rosterSlice` recorded **2 of 25**
// doctors in detail.
//
// The model did not hallucinate. ENABLE_ROSTER_SLICE keeps the specialty-
// matching doctors in DETAIL and demotes the rest to a name-only index the
// prompt explicitly disclaims — "inke time/fees tujhe NAHI pata". That is right
// for "I need a dentist" and exactly wrong for "is anyone free right now",
// where the hours of the demoted doctors ARE the answer.
//
// Two more in the corpus:
//   3312d865  "अभी कोई नहीं है क्या, emergency में दिखाना है जल्दी"
//             -> offered Monday, 56 hours out. Sixteen windows were open that
//                same Saturday.
//   5b261b844e "আজকে কোনো ডাক্তার আছে?" (the Bengali call)
//
// An adversarial re-derivation put the whole class at 26 false-as-spoken
// availability claims across 22 calls — about 1 in 7.4 substantive calls. The
// slice is the largest single contributor; see docs/ROADMAP.md §P0.5.
//
// THE ASYMMETRY IS THE DESIGN. Returning the full roster costs tokens and a
// little latency. Returning a slice costs a patient the appointment they rang
// for. So the guard errs loose, and the tests below pin BOTH directions: it must
// fire on the live utterances, and it must NOT fire on an ordinary specialty
// request, or the slice stops doing its job at 25+ doctors.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';
// The slice is OFF by default and ON in production. A test that forgot this
// would exercise the un-sliced path and assert nothing — the vacuous-harness
// shape this repo has been unpicking all week.
process.env.ENABLE_ROSTER_SLICE = 'true';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nROSTER SLICE — a whole-clinic question sees the whole clinic\n');

const lean = require('../brain-lean.js');
// sliceRoster has been exported all along (brain-lean.js module.exports). My
// first pass added a second export ABOVE `module.exports = {...}`, which then
// replaced the whole object and silently discarded it — the assignment ran, the
// property did not survive. Use the one that exists.
assert(typeof lean.sliceRoster === 'function',
  'brain-lean no longer exports sliceRoster — this file cannot see the decision it tests');

// A roster shaped like Smile Dental's: many doctors, several specialties.
const DOCS = [
  { id: 'd1', name: 'Dr. Anjali Deshmukh', specialty: 'Dentist', is_on_call: false, schedules: [] },
  { id: 'd2', name: 'Dr. Manoj Deo', specialty: 'Neurologist', is_on_call: false, schedules: [] },
  { id: 'd3', name: 'Dr. Ramesh Gokhale', specialty: 'General Physician', is_on_call: false, schedules: [] },
  { id: 'd4', name: 'Dr. Ashok Palkar', specialty: 'Cardiology', is_on_call: false, schedules: [] },
  { id: 'd5', name: 'Dr. Meera Joshi', specialty: 'Gynecology', is_on_call: false, schedules: [] },
  { id: 'd6', name: 'Dr. Divya Sane', specialty: 'Gastroenterology', is_on_call: false, schedules: [] },
  { id: 'd7', name: 'Dr. Sanjay Wagh', specialty: 'Orthopedic', is_on_call: false, schedules: [] },
];
lean._setRosterForTest({ text: '', doctors: DOCS });

// sliceRoster is module-private; drive it the way production does — through the
// prompt, which is what the model actually receives. If the whole roster is in
// detail, every doctor's line is present; if it is sliced, the demoted ones
// appear only in the "BAAKI DOCTORS" index.
// THE ACCUMULATOR IS THE POINT, and my first version of this file missed it.
// sliceRoster reads context.patientTextAll — every patient turn of the CALL, not
// just this one. Passing the availability question alone yields no specialty, so
// the pre-existing `if (!specs.length) return full` fail-safe already returned
// the full roster and every assertion below passed for the wrong reason:
// deleting the new guard entirely left the file GREEN.
//
// In production the caller states a symptom first ("सर में दर्द" -> Neurology)
// and asks "is anyone free now" later, so the accumulator carries BOTH and the
// slice fires with 2 of 25. That is call 0a0f0d8f. Every case below therefore
// prepends a symptom, which is what makes the guard the deciding factor.
const SYMPTOM = 'मुझे सर में दर्द हो रहा है';
const promptFor = (patientText, { withSymptom = true } = {}) => {
  const all = withSymptom ? `${SYMPTOM} ${patientText}` : patientText;
  return lean.sliceRoster([{ role: 'user', content: all }], { patientTextAll: all });
};

// ── 1. the three live utterances ────────────────────────────────────────────
for (const [utt, label] of [
  ['यार इतना तो time नहीं लगाना मेरे को कोई अभी doctor available है तुरंत', 'LIVE 0a0f0d8f'],
  ['अभी कोई नहीं है क्या मुझे emergency में दिखाना है जल्दी।', 'LIVE 3312d865'],
  ['না, আজকে কোনো ডাক্তার আছে?', 'LIVE 5b261b844e (Bengali)'],
]) {
  ok(`${label}: the whole clinic is in view`, () => {
    const s = promptFor(utt);
    assert.strictEqual(s.sliced, false,
      `answered a whole-clinic question from ${s.count}/${s.total} doctors — this is call 0a0f0d8f again`);
    for (const d of DOCS) {
      assert(s.text.includes(d.name), `${d.name} is missing from the roster text`);
    }
    assert(!/BAAKI DOCTORS/.test(s.text),
      'doctors were demoted to the name-only index, whose hours the prompt disclaims');
  });
}

// ── 2. and the slice must still slice ───────────────────────────────────────
// Without this the guard is not a fix, it is a deletion of the feature.
ok('an ordinary specialty request STILL slices', () => {
  const s = promptFor('मेरे दांत में दर्द है, दांत का डॉक्टर चाहिए');
  assert.strictEqual(s.sliced, true,
    'the slice no longer fires for a plain specialty request — at 25+ doctors that is the prompt bloat it exists to prevent');
  assert(s.count < s.total, `expected a narrowed set, got ${s.count}/${s.total}`);
  assert(/BAAKI DOCTORS/.test(s.text), 'the non-matching doctors should be in the index');
});

ok('a plain symptom with no urgency still slices', () => {
  const s = promptFor('', { withSymptom: true });
  assert.strictEqual(s.sliced, true, 'a symptom-only turn should still narrow');
});

// ── 3. the fail-safes that already existed must survive ─────────────────────
ok('an unserved specialty still shows the full roster', () => {
  // "hamare paas eye specialist nahi hai" can only be said honestly from the
  // full list. This fail-safe predates the new one and must not be shadowed.
  const s = promptFor('मुझे आँख का डॉक्टर चाहिए');
  assert.strictEqual(s.sliced, false,
    'a specialty nobody serves was sliced away — the model can no longer say it is unavailable');
});

ok('no patient text yet means no slicing', () => {
  const s = promptFor('', { withSymptom: false });
  assert.strictEqual(s.sliced, false);
});

// ── 4. the guard is loose ON PURPOSE, and that must be deliberate ───────────
ok('urgency alone is enough, in any of the languages we answer', () => {
  for (const utt of [
    'मुझे अभी दिखाना है',            // Hindi
    'मला आत्ता बघायचंय',             // Marathi
    'আমার এখনই দরকার',               // Bengali
    'I need to see someone right now', // English
    'ನನಗೆ ಈಗ ಬೇಕು',                  // Kannada
  ]) {
    const s = promptFor(utt);
    assert.strictEqual(s.sliced, false, `urgency was sliced: ${JSON.stringify(utt)}`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
