#!/usr/bin/env node
// ─── CLOSED DAYS, STATED — FOR EVERY DAY, NOT JUST TOMORROW ─────────────────
// a2d5e57 fixed TOMORROW: liveAvailability now emits "KAL (Sun) BAND" so the
// model reads a dated fact instead of inferring closure from a day missing off
// the `weekly:` list. That closed the case the live call hit.
//
// It did not close the class. Everything past tomorrow — परसों, "Monday",
// "13 तारीख को" — still lands on the same `weekly: Mon,Tue,Wed,Thu,Fri,Sat`
// string, where Sunday is closed ONLY by being absent. The prompt even points
// there: `"parso"=+2 din`, then nothing dated to check it against.
//
// AND THE ARITHMETIC WAS NEVER THE PROBLEM. On the live call, turn 22, she got
// it right unprompted once challenged — "माफ़ कीजिए, कल रविवार है और क्लिनिक बंद
// रहता है". She knew today was Saturday, knew tomorrow was Sunday, and knew
// Sunday was shut. What she did not do was CHECK before offering. Reasoning
// from an absence is skippable; reading a stated fact is not.
//
// So the roster line now names the closed days positively. Cost is ~11
// characters per doctor, which matters because ENABLE_ROSTER_SLICE exists to
// keep this text small at 25+ doctors — hence a compact "BAND: Sun" rather
// than a seven-day dated horizon.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { liveAvailability, doctorLine } = require('../brain-lean.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const win = (dow, start, end) => ({ dow, start, end });
const DOC = (name, dows) => ({
  name, specialty: 'General',
  windows: dows.flatMap((d) => [win(d, '10:00', '14:00'), win(d, '17:00', '20:00')]),
});

// Dr. Anjali Deshmukh's real schedule from the demo database: Mon–Sat.
const ANJALI = DOC('Dr. Anjali Deshmukh', [1, 2, 3, 4, 5, 6]);

console.log('\nCLOSED DAYS — named, not inferred from an absence\n');

ok('THE CLASS: the closed day is stated for EVERY future day, not just tomorrow', () => {
  const av = liveAvailability(ANJALI, { dow: 6, mins: 8 * 60 });   // Saturday
  assert(av.closedDays, 'no closedDays — परसों and weekday names still rest on an absence');
  assert.deepStrictEqual(av.closedDays, ['Sun'],
    `wrong closed set: ${JSON.stringify(av.closedDays)}`);
});

ok('it does not depend on which day is being asked about', () => {
  // The old KAL field is relative to now. Closed days are a property of the
  // schedule, so परसों on a Friday must read the same as परसों on a Monday.
  for (let dow = 0; dow < 7; dow++) {
    const av = liveAvailability(ANJALI, { dow, mins: 12 * 60 });
    assert.deepStrictEqual(av.closedDays, ['Sun'], `drifted on ${dow}`);
  }
});

ok('a doctor closed several days lists all of them', () => {
  const twiceWeekly = DOC('Dr. Sunil Nikam', [2, 4]);              // Tue + Thu only
  const av = liveAvailability(twiceWeekly, { dow: 1, mins: 10 * 60 });
  assert.deepStrictEqual(av.closedDays, ['Sun', 'Mon', 'Wed', 'Fri', 'Sat']);
});

ok('a seven-day doctor has NO closed days, and says nothing', () => {
  // Must not emit an empty "BAND:" — a clinic open all week should cost zero
  // extra tokens and zero extra reading.
  const allWeek = DOC('Dr. Vikas Gaikwad', [0, 1, 2, 3, 4, 5, 6]);
  const av = liveAvailability(allWeek, { dow: 3, mins: 11 * 60 });
  assert.deepStrictEqual(av.closedDays, []);
  assert(!/BAND:/.test(doctorLine(allWeek)), `emitted an empty BAND: ${doctorLine(allWeek)}`);
});

ok('UNKNOWN is not CLOSED — a doctor with no schedule claims nothing', () => {
  // Absence of data must never read as "shut all week", or a clinic
  // mid-onboarding has every booking refused.
  const unset = { name: 'Dr. Unset', specialty: 'General', windows: [] };
  const av = liveAvailability(unset, { dow: 2, mins: 10 * 60 });
  assert(av.closedDays === null || av.closedDays === undefined,
    `an unknown schedule reported closed days: ${JSON.stringify(av.closedDays)}`);
  assert(!/BAND:/.test(doctorLine(unset)));
});

ok('the model actually reads it — it reaches the roster line', () => {
  const line = doctorLine(ANJALI);
  assert(/BAND:\s*Sun/.test(line), `closed days never reach the prompt:\n      ${line}`);
  // and the tomorrow fact from a2d5e57 must survive alongside it
  assert(/KAL \(/.test(line), `the KAL verdict was lost:\n      ${line}`);
});

ok('it stays compact — the roster slice exists because this text is not free', () => {
  const line = doctorLine(ANJALI);
  const band = (line.match(/\| BAND: [^|]*/) || [''])[0];
  assert(band.length <= 40, `BAND segment is ${band.length} chars — too fat for a 25-doctor roster: ${band}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
