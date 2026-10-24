#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE OFFER SIDE MAY NOT NAME A DAY THE COMMIT WILL REFUSE.
//
// doctor_exceptions ('closed' / 'leave') was read by the ACCEPT side only —
// tools/utils/availability.js and tools/findDoctor.js. brain-lean's
// firstFreeSlot walked doctor_schedules and had never heard of it. So on a
// clinic holiday Ritu would offer 11:00, the caller would say yes, and the
// booking commit would refuse: a time given and then taken back.
//
// This is the THIRD instance of one defect, not a new one:
//   ae16022  a window's exclusive end offered as a bookable start
//   (earlier) taken slots the offer side could not see
//   here      holidays the offer side could not see
// Each time, half the system knew less than the other half about the same
// fact. So the assertion that matters is not "the holiday is skipped" — it is
// PARITY: everything the offer side names, the accept side accepts.
//
// Skin Essence seeds three holidays on day one (28 Aug Raksha Bandhan, 4 Sep
// Janmashtami, 20 Oct Dussehra), which is what turns this from latent to live.
//
// Run:            node tests/test-holiday-offer-parity.js
// Prove it fails: MUTANT=MUT-OFFER-IGNORES-EXCEPTIONS node tests/test-holiday-offer-parity.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
process.env.ROSTER_TAKEN_TTL_MS = '0';
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

console.log('\nHOLIDAYS — the offer side and the commit must agree\n');

(async () => {
  const db = require('../db.js');
  const lean = require('../brain-lean.js');
  const { checkDoctorAvailability } = require('../tools/utils/availability.js');
  const { closedDaySet } = require('../tools/utils/dayClosure.js');

  const DOC = '33333333-3333-3333-3333-333333333333';
  const TZ = 'Asia/Kolkata';
  const ymd = (d) => new Intl.DateTimeFormat('en-CA',
    { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  // Tomorrow and the day after, in clinic-local terms — relative, so the test
  // does not rot the way a literal date in a fixture does.
  const DAY = 86400000;
  const t1 = new Date(Date.now() + DAY);
  const t2 = new Date(Date.now() + 2 * DAY);
  const dowOf = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(d).replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, (m) => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[m])));

  // A doctor who works EVERY day 10:30–19:50, so the only reason a day can be
  // skipped is the holiday — nothing else in the walk can explain it.
  const windows = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: '10:30', end: '19:50' }));
  const doctor = { id: DOC, name: 'Dr. Daksha Patel', specialty: 'Dermatologist', windows, taken: [] };

  // CLOSED tomorrow, open the day after.
  const closedYmd = ymd(t1);
  const openYmd = ymd(t2);
  const exceptions = [{ doctor_id: DOC, exception_date: closedYmd, exception_type: 'closed' }];

  // ── Drive the REAL refresh path. The closure set is module state that only
  //    refreshTakenSlots writes, so a test that poked it directly would be
  //    asserting about a variable rather than about the code.
  db.getTakenSlots = async () => ({ [DOC]: [] });
  db.getUpcomingExceptions = async () =>
    (MUTANT === 'MUT-OFFER-IGNORES-EXCEPTIONS' ? [] : exceptions);
  if (MUTANT === 'MUT-OFFER-IGNORES-EXCEPTIONS') {
    console.log('  [MUTANT] MUT-OFFER-IGNORES-EXCEPTIONS — the offer side is blind again\n');
  }

  lean._setRosterForTest({ text: '', doctors: [doctor] });
  await lean.refreshTakenSlots({ force: true });

  // ── [1] The holiday is not offered ──────────────────────────────────────
  // Search from tomorrow by pinning "now" to late today, so today's remaining
  // slots cannot satisfy the walk and the first candidate IS the closed day.
  const lateToday = lean._istNow();
  const nowLate = { ...lateToday, mins: 23 * 60 };
  const offer = lean.firstFreeSlot(doctor, nowLate);

  ok('a slot is still offered (the walk did not simply give up)', () => {
    assert.ok(offer, 'firstFreeSlot returned null — nothing was offered at all');
  });
  ok('the offered day is NOT the clinic holiday', () => {
    assert.notStrictEqual(offer && offer.ymd, closedYmd,
      `offered ${offer && offer.label} on ${closedYmd}, which the clinic has marked closed`);
  });
  ok('it skips to the next OPEN day instead', () => {
    assert.strictEqual(offer.ymd, openYmd, `offered ${offer.ymd}, expected ${openYmd}`);
  });

  // ── [2] PARITY — the real accept path must accept what was offered ───────
  // This is the assertion the three previous instances of this defect would
  // each have failed. It asks the commit side, not a restatement of the rule.
  const fakePool = {
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM doctor_schedules/i.test(s)) {
        const dow = params[1];
        return { rows: windows.filter((w) => w.dow === dow)
          .map((w) => ({ day_of_week: w.dow, start_time: w.start, end_time: w.end, is_walk_in: false })) };
      }
      if (/FROM doctor_exceptions/i.test(s)) {
        const date = String(params[1]);
        return { rows: exceptions.filter((e) => e.exception_date === date)
          .map((e) => ({ exception_type: e.exception_type, start_time: null, end_time: null })) };
      }
      return { rows: [] };
    },
  };
  const at = (y, hhmm) => new Date(`${y}T${hhmm}:00+05:30`);

  const verdictOffered = await checkDoctorAvailability({
    pool: fakePool, doctorId: DOC, requestedDateTime: at(offer.ymd, offer.hhmm), timezone: TZ,
  });
  ok('PARITY: the commit ACCEPTS the slot the offer side named', () => {
    assert.strictEqual(verdictOffered.ok, true,
      `offered ${offer.label} but the commit refuses it: ${verdictOffered.reason}`);
  });

  const verdictHoliday = await checkDoctorAvailability({
    pool: fakePool, doctorId: DOC, requestedDateTime: at(closedYmd, '11:00'), timezone: TZ,
  });
  ok('the commit still refuses the holiday (the accept side is unchanged)', () => {
    assert.strictEqual(verdictHoliday.ok, false, 'the holiday became bookable — the accept side regressed');
    assert.match(String(verdictHoliday.reason), /closed|leave/i, `reason was: ${verdictHoliday.reason}`);
  });

  // ── [2b] THE OTHER THREE SURFACES ───────────────────────────────────────
  // firstFreeSlot is only ONE of the four availability facts doctorLine puts in
  // front of the model. The others are liveAvailability's "ABHI available"
  // label, its KAL label, and soonestTodayLine — and the prompt's availability
  // rule points the model at exactly those when a caller says jaldi/abhi/aaj.
  // Until 2026-08-27 they were holiday-blind, so one prompt line read:
  //     OFFER YEH: Sat 10:30 AM | ABHI available: AAJ 10:30 AM se 7:50 PM tak
  // with today closed. This file asserted parity for "everything the offer side
  // names" and exercised one of the four.
  const closedTodayExceptions = [
    { doctor_id: DOC, exception_date: ymd(new Date()), exception_type: 'closed' },
    { doctor_id: DOC, exception_date: closedYmd, exception_type: 'closed' },
  ];
  db.getUpcomingExceptions = async () =>
    (MUTANT === 'MUT-OFFER-IGNORES-EXCEPTIONS' ? [] : closedTodayExceptions);
  lean._setRosterForTest({ text: '', doctors: [doctor] });
  await lean.refreshTakenSlots({ force: true });

  const line = lean.doctorLine(doctor);
  const soonest = lean.soonestTodayLine([doctor]);

  ok('the doctor line does not claim to be open TODAY on a closed day', () => {
    assert.doesNotMatch(line, /ABHI available: AAJ/,
      `today is closed and the line says otherwise: ${line}`);
  });
  ok('tomorrow renders as BAND, a stated fact rather than an absence', () => {
    assert.match(line, /KAL \([^)]+\) BAND/,
      `tomorrow is closed and the line does not say so: ${line}`);
  });
  ok('the soonest-today line does not offer a closed today', () => {
    assert.doesNotMatch(soonest, /AAJ \d/,
      `soonestTodayLine offers a time today: ${soonest}`);
    assert.match(soonest, /AAJ koi doctor available NAHI/,
      `expected the honest no-availability line, got: ${soonest}`);
  });
  ok('the one day the line DOES name is accepted by the commit path', () => {
    // Parity, applied to the label rather than to firstFreeSlot. Whatever day
    // "ABHI available" names must survive checkDoctorAvailability — this is the
    // assertion that goes red if any of the three surfaces regresses, without
    // needing to restate what the labels should say.
    const m = line.match(/ABHI available: ([A-Za-z]{3}) /);
    assert.ok(m, `no ABHI available label to check: ${line}`);
    const named = m[1];
    const todayIdx = new Date().getDay();
    const DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const offset = (DOWN.indexOf(named) - todayIdx + 7) % 7;
    assert.ok(offset >= 2,
      `the line names ${named} (offset ${offset}) but today and tomorrow are both closed`);
  });

  // ── [3] Both sides read ONE definition ──────────────────────────────────
  ok('offer and accept share the closure rule, not a copy of it', () => {
    const fs = require('fs');
    const avail = fs.readFileSync('tools/utils/availability.js', 'utf8');
    const brain = fs.readFileSync('brain-lean.js', 'utf8');
    assert.match(avail, /require\(['"]\.\/dayClosure['"]\)/, 'availability.js no longer imports the shared rule');
    assert.match(brain, /dayClosure/, 'brain-lean.js no longer imports the shared rule');
    assert.doesNotMatch(avail, /exception_type === 'closed'/,
      'availability.js has grown its own copy of the closure literal again');
  });

  // ── [4] An empty holiday list changes nothing (the deletion test) ────────
  // (the fixture above left today closed as well; reset to the original shape)
  db.getUpcomingExceptions = async () => [];
  lean._setRosterForTest({ text: '', doctors: [doctor] });
  await lean.refreshTakenSlots({ force: true });
  const noHolidays = lean.firstFreeSlot(doctor, nowLate);
  ok('with no holidays configured the walk is unchanged (empty state is safe)', () => {
    assert.ok(noHolidays, 'nothing offered with an empty holiday list');
    assert.strictEqual(noHolidays.ymd, closedYmd,
      'the previously-closed day is still skipped with no exceptions loaded — state leaked between refreshes');
  });

  ok('a Date-typed exception_date does not shift a day in a +05:30 process', () => {
    const s = closedDaySet([{ doctor_id: DOC, exception_date: new Date(2026, 7, 28), exception_type: 'closed' }]);
    assert.ok(s.has(`${DOC}|2026-08-28`), `got ${[...s]} — toISOString would have made this 27 Aug`);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
})();
