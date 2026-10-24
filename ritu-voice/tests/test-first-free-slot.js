#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE OFFER IS COMPUTED, NOT RECONCILED.
//
// Two fixes preceded this one. ae16022 stopped the roster handing the model a
// window's closing time; 15fdab1 told it which slots were already booked. Both
// left the final step to the model: given "5:00 PM se 7:30 PM tak" and
// "Mon 17 Aug 17:00 GAYA", work out that 5:30 is the first thing it may say.
//
// That reconciliation is exactly what failed on call 4843c8bc. So firstFreeSlot
// does it in code and hands the model ONE time. This file pins the walk:
//
//   [1] a booked slot is stepped over — the live defect, reproduced exactly
//   [2] today's past slots are never offered
//   [3] the walk rolls onto the next OPEN day
//   [4] the window's closing time is never returned (ae16022 still holds)
//   [5] EVERY slot it returns would be accepted by the real booking rule
//
// Run: node tests/test-first-free-slot.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('APPOINTMENT_SLOT_MINUTES', '30', 'the fixtures are built on a 30-minute grid; the grid itself is not under test');
process.env.SKIP_BOOT_AUDIO = '1';
const lean = require('../brain-lean');
const { offerableEnd } = require('../tools/utils/offerWindow');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const IST_YMD = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const IST_DOW = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(d));

const TODAY = new Date();
const TODAY_YMD = IST_YMD(TODAY);
const TODAY_DOW = IST_DOW(TODAY);
const TOMORROW_YMD = IST_YMD(new Date(TODAY.getTime() + 86400000));
const TOMORROW_DOW = (TODAY_DOW + 1) % 7;

// A doctor open every day 09:00-17:00. offerableEnd trims the close to the last
// bookable start, exactly as db.js does when building the real roster.
function everyDayDoc(taken = []) {
  return {
    name: 'Dr. Test', specialty: 'X', fee_inr: 1, schedule: 'daily 09:00-17:00',
    windows: Array.from({ length: 7 }, (_, dow) => ({ dow, start: '09:00', end: offerableEnd('17:00', '09:00') })),
    taken,
  };
}
// A fixed "now" so the walk is deterministic regardless of when the suite runs.
const at = (dow, mins) => ({ dow, mins });

console.log('\n[1] a booked slot is stepped over (call 4843c8bc)');
{
  // Booked at 09:00 today. First free must be the NEXT step, not 09:00.
  const d = everyDayDoc([{ key: `${TODAY_YMD} 09:00`, label: 'x' }]);
  const r = lean.firstFreeSlot(d, at(TODAY_DOW, 0)); // early morning
  assert('does not return the taken 09:00', r && r.hhmm !== '09:00', JSON.stringify(r));
  assert('returns 09:30 instead', r && r.hhmm === '09:30' && r.ymd === TODAY_YMD, JSON.stringify(r));

  // Two consecutive bookings — the walk must step over BOTH.
  const d2 = everyDayDoc([
    { key: `${TODAY_YMD} 09:00`, label: 'x' },
    { key: `${TODAY_YMD} 09:30`, label: 'x' },
  ]);
  const r2 = lean.firstFreeSlot(d2, at(TODAY_DOW, 0));
  assert('steps over consecutive bookings', r2 && r2.hhmm === '10:00', JSON.stringify(r2));

  // A booking on ANOTHER day must not affect today.
  const d3 = everyDayDoc([{ key: `${TOMORROW_YMD} 09:00`, label: 'x' }]);
  const r3 = lean.firstFreeSlot(d3, at(TODAY_DOW, 0));
  assert('tomorrow\'s booking does not block today', r3 && r3.hhmm === '09:00' && r3.ymd === TODAY_YMD,
    JSON.stringify(r3));
}

console.log('\n[2] today\'s past slots are never offered');
{
  const d = everyDayDoc();
  const r = lean.firstFreeSlot(d, at(TODAY_DOW, 12 * 60 + 5)); // 12:05
  assert('offers a slot strictly after now', r && r.minutes > 12 * 60 + 5, JSON.stringify(r));
  assert('respects the 30-minute lead', r && r.minutes >= 12 * 60 + 5 + 30, JSON.stringify(r));
  assert('and it is still today', r && r.ymd === TODAY_YMD && r.dayOffset === 0, JSON.stringify(r));

  // After the last offerable start, today is exhausted → roll to tomorrow.
  const late = lean.firstFreeSlot(d, at(TODAY_DOW, 23 * 60));
  assert('after hours, rolls to tomorrow', late && late.dayOffset === 1 && late.hhmm === '09:00',
    JSON.stringify(late));
}

console.log('\n[3] the walk rolls onto the next OPEN day');
{
  // Open ONLY on the day after tomorrow.
  const dow2 = (TODAY_DOW + 2) % 7;
  const d = { name: 'Dr. Sparse', windows: [{ dow: dow2, start: '10:00', end: offerableEnd('12:00', '10:00') }], taken: [] };
  const r = lean.firstFreeSlot(d, at(TODAY_DOW, 8 * 60));
  assert('skips the closed days entirely', r && r.dayOffset === 2 && r.hhmm === '10:00', JSON.stringify(r));

  assert('a doctor with no schedule yields no offer', lean.firstFreeSlot({ windows: [], taken: [] }, at(TODAY_DOW, 8 * 60)) === null);

  // Every slot booked for the whole horizon → null, and the model falls back.
  const full = [];
  for (let step = 0; step < 9; step++) {
    const ymd = IST_YMD(new Date(TODAY.getTime() + step * 86400000));
    for (let m = 9 * 60; m <= 16 * 60 + 30; m += 30) {
      full.push({ key: `${ymd} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, label: 'x' });
    }
  }
  assert('fully booked horizon yields null, not a bad offer',
    lean.firstFreeSlot(everyDayDoc(full), at(TODAY_DOW, 0)) === null);
}

console.log('\n[4] the closing time is never offered (ae16022 still holds)');
{
  const d = everyDayDoc();
  // Walk every start-minute of today and check no result is ever the raw close.
  let offeredClose = 0, checked = 0;
  for (let m = 0; m < 24 * 60; m += 15) {
    const r = lean.firstFreeSlot(d, at(TODAY_DOW, m));
    if (!r) continue;
    checked++;
    if (r.hhmm === '17:00') offeredClose++;
  }
  assert(`across ${checked} moments, never offers the 17:00 close`, offeredClose === 0,
    `${offeredClose} offers landed on the shift end`);
}

// ─── [5] THE INVARIANT ──────────────────────────────────────────────────────
// Same discipline as tests/test-offer-window.js: not "does the walk look right"
// but "would the REAL booking rule accept what it returns".
console.log('\n[5] every computed offer would actually book');
{
  const START = 9 * 60, CLOSE = 17 * 60;      // availability.js: >= start && < end
  let bad = 0, n = 0;
  for (let m = 0; m < 24 * 60; m += 10) {
    for (const takenSet of [[], [{ key: `${TODAY_YMD} 09:00`, label: 'x' }, { key: `${TODAY_YMD} 14:00`, label: 'x' }]]) {
      const r = lean.firstFreeSlot(everyDayDoc(takenSet), at(TODAY_DOW, m));
      if (!r) continue;
      n++;
      const accepted = r.minutes >= START && r.minutes < CLOSE;
      const notTaken = !takenSet.some((t) => t.key === `${r.ymd} ${r.hhmm}`);
      if (!accepted || !notTaken) bad++;
    }
  }
  assert(`all ${n} computed offers are inside the window and unbooked`, bad === 0,
    `${bad} offer(s) the booking rule would refuse`);
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
console.log('✓ Ritu offers a slot she can actually book.');
process.exit(0);
