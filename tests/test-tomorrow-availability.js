#!/usr/bin/env node
// ─── WHAT THE MODEL IS TOLD ABOUT TOMORROW ──────────────────────────────────
// LIVE FAILURE, demo clinic, 2026-08-08 08:06 IST, call booked in 153s where a
// normal booking takes 80:
//
//   18 ritu     कल के लिए डॉ. अंजलि देशमुख सुबह 10:00 से उपलब्ध हैं
//   19 patient  नहीं एक एक बारह बारह बजे कर दो
//   20 ritu     उस समय उपलब्ध नहीं। Monday 10:00 ठीक रहेगा?
//   21 patient  अभी तो आपने कहा कि कल सुबह दस बजे है available।
//   22 ritu     माफ़ कीजिए, कल रविवार है और क्लिनिक बंद रहता है
//
// 2026-08-08 was a SATURDAY. doctor_schedules holds Mon–Sat for this doctor and
// ZERO Sunday rows. Ritu offered a slot on a day the clinic does not open, and
// only admitted it after the patient caught her. The booking guard did stop the
// write (bookFailKind="slot_unavailable"), so the OFFER path and the BOOK path
// disagreed — and the patient heard the disagreement.
//
// WHY IT HAPPENED, and it is a design gap rather than a typo. liveAvailability
// computes TODAY server-side, deliberately: "The model kept offering slots that
// had already passed … because it had to compare weekly hours to the clock
// itself — LLMs are unreliable at that." Tomorrow got no such help. Worse, the
// forward scan that does know about other days is unreachable when the doctor
// is open today — and at 08:06 on a Saturday she was. So the model received
// only `AAJ 10:00 AM se 2:00 PM tak` plus `weekly: Mon,Tue,Wed,Thu,Fri,Sat
// 10:00-14:00`, and the prompt told it to use `weekly:` for future days. To
// refuse it had to know today is Saturday, that tomorrow is Sunday, and that
// Sunday is absent from a list of open days — reasoning from an ABSENCE, which
// is the same class of arithmetic the today-path exists to take away from it.
//
// This file pins the invariant: whatever the model is told about tomorrow must
// agree with the schedule, for every doctor and every day of the week.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { liveAvailability } = require('../brain-lean.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const win = (dow, start, end) => ({ dow, start, end });

// Dr. Anjali Deshmukh's REAL schedule, read from the demo database.
const ANJALI = {
  name: 'Dr. Anjali Deshmukh', specialty: 'Dentist',
  windows: [1, 2, 3, 4, 5, 6].flatMap((d) => [win(d, '10:00', '14:00'), win(d, '17:00', '20:00')]),
  schedule: 'Mon,Tue,Wed,Thu,Fri,Sat 10:00-14:00; Mon,Tue,Wed,Thu,Fri,Sat 17:00-20:00',
};

// Does anything the model is handed CLAIM a time for tomorrow?
const claimsATomorrowTime = (av) => {
  const t = av.tomorrow;
  if (!t) return null;                       // no tomorrow field at all
  return t.open === true;
};

console.log('\nTOMORROW — the model must be told, not left to infer from an absence\n');

ok('THE LIVE FAILURE: Saturday 08:06, tomorrow is Sunday and the clinic is SHUT', () => {
  const sat = { dow: 6, mins: 8 * 60 + 6 };          // Sat 08:06 IST, the real call
  const av = liveAvailability(ANJALI, sat);
  assert(av.tomorrow, 'liveAvailability says NOTHING about tomorrow — the model is left to read ' +
    'it off the weekly: string, which is how "कल सुबह 10:00" was offered on a closed Sunday');
  assert.strictEqual(av.tomorrow.open, false,
    `tomorrow (Sun) is reported as OPEN; the schedule has no Sunday window. label=${av.tomorrow.label}`);
  assert(/Sun/i.test(av.tomorrow.label), `the tomorrow label must name the day: ${av.tomorrow.label}`);
});

ok('the doctor being open TODAY must not hide tomorrow', () => {
  // The exact trap: the forward scan sits after an early return, so a doctor
  // open today never produced any next-day information at all.
  const sat = { dow: 6, mins: 8 * 60 + 6 };
  const av = liveAvailability(ANJALI, sat);
  assert.strictEqual(av.today, true, 'she IS open Saturday morning — that is the point');
  assert(av.tomorrow, 'open today still yields no tomorrow');
});

ok('EVERY day of the week agrees with the schedule', () => {
  const wrong = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const mins of [8 * 60, 12 * 60, 15 * 60, 23 * 60]) {
      const av = liveAvailability(ANJALI, { dow, mins });
      const tdow = (dow + 1) % 7;
      const trulyOpen = ANJALI.windows.some((w) => w.dow === tdow);
      const said = claimsATomorrowTime(av);
      if (said === null) { wrong.push(`${DOW[dow]} ${mins / 60}h -> no tomorrow field`); continue; }
      if (said !== trulyOpen) {
        wrong.push(`${DOW[dow]} ${mins / 60}h -> said tomorrow(${DOW[tdow]}) open=${said}, schedule says ${trulyOpen}`);
      }
    }
  }
  assert.deepStrictEqual(wrong, [], `offer path disagrees with the schedule:\n      ${wrong.join('\n      ')}`);
});

ok('a doctor who works ONLY Sunday is reported open on Saturday', () => {
  // The mirror case. A rule that just hardcodes "Sunday is shut" would pass the
  // tests above and be wrong here — clinics do open on Sundays.
  const sundayOnly = { name: 'Dr. Sunday', specialty: 'General', windows: [win(0, '09:00', '13:00')], schedule: 'Sun 09:00-13:00' };
  const av = liveAvailability(sundayOnly, { dow: 6, mins: 8 * 60 });
  assert(av.tomorrow, 'no tomorrow field');
  assert.strictEqual(av.tomorrow.open, true, 'a Sunday-only doctor was reported shut on the Sunday');
});

ok('a doctor with NO schedule claims nothing about tomorrow', () => {
  // Absence of data must read as "unknown", never as "closed" — a clinic that
  // has not filled its roster in must not have appointments refused for it.
  const unknown = { name: 'Dr. Unset', specialty: 'General', windows: [] };
  const av = liveAvailability(unknown, { dow: 6, mins: 8 * 60 });
  if (av.tomorrow) {
    assert.notStrictEqual(av.tomorrow.open, false,
      'an unknown schedule was reported as CLOSED tomorrow — that refuses real bookings');
  }
});

ok('the per-doctor prompt line carries the tomorrow verdict', () => {
  // liveAvailability being right is useless if doctorLine does not pass it on;
  // the line is what the model actually reads.
  const { doctorLine } = require('../brain-lean.js');
  const line = doctorLine(ANJALI);
  assert(/KAL|kal/i.test(line),
    `the doctor line says nothing about tomorrow, so the model still infers it from weekly:\n      ${line}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
