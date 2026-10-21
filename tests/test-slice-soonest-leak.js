#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE ROSTER SLICE DOES NOT REACH THE "SOONEST AVAILABLE TODAY" LINE.
//
// LIVE, 2026-07-30, call b23c97d51be5 — a Punjabi caller with head pain:
//   slice log:  [LEAN] Roster slice: Neurology+Gastroenterology → 2/25 in detail
//   Ritu said:  "ਡਾ. ਅਲਕਾ ਰਾਨਾਡੇ (MD Medicine) ਅੱਜ ਰਾਤ 8:00 ਵਜੇ ਤੱਕ ਉਪਲਬਧ ਹਨ"
//               ("Dr. Alka Ranade (MD Medicine) is available until 8:00 tonight")
//
// MD Medicine is neither Neurology nor Gastroenterology, so that doctor was in
// the INDEX — and the index line tells the model, in words:
//   "inke time/fees tujhe NAHI pata ... guess KABHI mat kar"
//
// It is tempting to file that as the model ignoring a prompt rule. It is not.
// buildSystemPrompt ALSO emits a second section:
//   "⏱ AAJ SABSE JALDI AVAILABLE ... ⚠ YE LIST PEHLE SE HI patient ki takleef
//    ke hisaab se chhaanti hui hai"  (this list is ALREADY filtered by the
//    patient's complaint)
// built from soonestPool(context), which reads `slice.doctors` — a key
// sliceRoster has never returned on ANY of its six return paths. So the lookup
// is undefined every time and falls through to the full roster.
//
// The model was therefore handed that doctor's real 8pm availability, in a list
// the prompt swore was already narrowed to this patient, and then told elsewhere
// it did not know that doctor's hours. Given a contradiction, it used the
// concrete number. That is the correct read of a broken prompt, not a
// hallucination — and it is why "add a stronger rule" would not have helped.
//
// ASSERTS THE INVARIANT, NOT THE SYMPTOM: when the roster is sliced, every
// doctor named in the soonest-today line must be one the prompt describes in
// detail. A leak means the model can offer a time it was told it does not know.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.ENABLE_ROSTER_SLICE = 'true';

const assert = require('assert');
const lean = require('../brain-lean');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// liveAvailability reads d.windows — [{dow, start, end}] — built by db.js:332.
// An earlier version of this fixture used a `schedule` string and an invented
// `availability` array; every doctor then came back today:false, the soonest
// line was the "nobody is free today" fallback, and the invariant passed while
// proving nothing. The mutation arm below is what caught that, which is the
// entire reason it exists.
//
// Open every day of the week so the result never depends on when the suite runs.
const ALLDAY = 'Mon-Sun 00:00-23:59';
const doc = (name, specialty) => ({
  id: name.replace(/\W/g, '').toLowerCase(), name, specialty,
  fee_inr: 500, schedule: ALLDAY, is_on_call: false,
  windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: '00:00', end: '23:59' })),
});

// The live shape: 25 doctors, the complaint maps to Neurology, and the doctor
// who actually leaked (MD Medicine) sits in the index.
const ROSTER = {
  text: '',
  doctors: [
    doc('Dr. Neuro One', 'Neurology'),
    doc('Dr. Gastro One', 'Gastroenterology'),
    doc('Dr. Alka Ranade', 'MD Medicine'),
    doc('Dr. Derm One', 'Dermatology'),
    doc('Dr. Ortho One', 'Orthopedics'),
  ],
};
lean._setRosterForTest(ROSTER);

// "मेरे सिर में दर्द हो रहा है" — head pain, the live complaint, in the language
// the symptom mapper is built for.
const HEAD_PAIN = 'मेरे सिर में दर्द हो रहा है';
const slice = lean.sliceRoster([], { patientTextAll: HEAD_PAIN });

check('precondition: the roster actually slices for head pain', () => {
  assert.ok(slice.sliced, 'roster did not slice — test would prove nothing');
  assert.ok(slice.count < ROSTER.doctors.length,
    `slice kept all ${slice.count} doctors; nothing is in the index`);
});

check('precondition: the leaking doctor is in the INDEX, not the detail', () => {
  assert.ok(!/Dr\. Alka Ranade \(MD Medicine\)[^\n]*ABHI available/.test(slice.text),
    'Alka Ranade is described in DETAIL — she must be index-only for this test');
  assert.ok(slice.text.includes('Dr. Alka Ranade'),
    'Alka Ranade is missing entirely; she should appear in the index');
});

// ── THE INVARIANT ────────────────────────────────────────────────────────────
check('soonest-today names ONLY doctors the prompt describes in detail', () => {
  const prompt = lean.buildSystemPrompt({ rosterSlice: slice });
  const line = (prompt.match(/⏱ AAJ SABSE JALDI AVAILABLE[^\n]*/) || [''])[0];
  assert.ok(line, 'could not find the soonest-available line in the prompt');

  // A doctor is "in detail" iff the slice's detail block carries their hours.
  const detailBlock = slice.text.split('\n\nBAAKI DOCTORS')[0];
  const leaked = ROSTER.doctors
    .filter((d) => line.includes(d.name) && !detailBlock.includes(d.name))
    .map((d) => `${d.name} (${d.specialty})`);

  assert.strictEqual(leaked.length, 0,
    `index-only doctor(s) given a time in the soonest line: ${leaked.join(', ')}\n` +
    `      soonest line: ${line.slice(0, 200)}\n` +
    `      cause: soonestPool() reads slice.doctors, which sliceRoster never sets`);
});

check('the prompt does not both claim and deny knowledge of the same doctor', () => {
  const prompt = lean.buildSystemPrompt({ rosterSlice: slice });
  const line = (prompt.match(/⏱ AAJ SABSE JALDI AVAILABLE[^\n]*/) || [''])[0];
  const indexBlock = (slice.text.split('\n\nBAAKI DOCTORS')[1] || '');
  const both = ROSTER.doctors.filter((d) => indexBlock.includes(d.name) && line.includes(d.name));
  assert.strictEqual(both.length, 0,
    `${both.map((d) => d.name).join(', ')} is in the index ("time tujhe NAHI pata") ` +
    'AND in the soonest-available list with a time');
});

// ── the check must be able to fail ───────────────────────────────────────────
// A green assertion nobody has watched go red is not evidence. This forces the
// leak on purpose and requires the detector to catch it.
check('MUTATION: the detector actually fires when a leak is present', () => {
  const full = { sliced: false, text: ROSTER.doctors.map(lean.doctorLine).join('\n') };
  const prompt = lean.buildSystemPrompt({ rosterSlice: full });
  const line = (prompt.match(/⏱ AAJ SABSE JALDI AVAILABLE[^\n]*/) || [''])[0];
  assert.ok(line.includes('Dr. Alka Ranade'),
    'with an unsliced roster every doctor should appear — the detector reads nothing');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
