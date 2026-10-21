#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Regression test for the book→change-time flip-flop bug (Shilpa call).
// book_appointment must keep ONE active row per (patient, doctor): a new time
// MOVES the existing row (action:'rescheduled'), never creates a 2nd row.
// A different DOCTOR is still a separate appointment.
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha, skipUnlessSupported } = require('../tools/testHelpers/setupDb');
const { execute: bookAppointment } = require('../tools/bookAppointment');

const PHONE = '+919876500011';
const stubCal = { bookAppointment: async () => ({ success: true, eventId: 'stub_evt' }) };

// A TEST PINNED TO A WALL-CLOCK DATE ROTS THE DAY THAT DATE PASSES.
// This file hardcoded 2026-05-25 and had therefore been failing since
// 2026-05-25 with "Requested time (2026-05-25 19:00) is in the past" — the
// first assertion failed, r1.appointment_id came back undefined, and the run
// died on `.patient_id` of undefined. So the flip-flop regression this file
// exists to guard (book → change time must MOVE the row, never create a second)
// was unguarded for two months, and nothing said so: the failure looked like a
// crash in the test rather than an expired fixture.
// Found while adding the cross-call reschedule path to brain-lean, when this was
// the test that should have told me whether I had broken the same-call one.
// Compute the slot from the current date instead, so it cannot expire.
//
// ⚠ SECOND BLOCKER, STILL OPEN. With the dates fixed, this test now fails for a
// different and deeper reason: setupDb uses pg-mem, and pg-mem cannot parse the
// partial-index conflict target the production upsert uses —
//     ON CONFLICT (clinic_id, patient_id, doctor_id) WHERE status = 'booked'
//     DO UPDATE SET ...
//   → 'Unexpected kw_where token: "where". Instead, I was expecting a "kw_do"'
// So the invariant this file names — one active row per (patient, doctor), a new
// time MOVES it — has no runnable DB-level test, and cannot have one until either
// pg-mem learns partial conflict targets or the suite points at a real Postgres.
// Do NOT "fix" this by simplifying the production SQL: the WHERE predicate is what
// lets a CANCELLED row coexist with a new booking for the same pair.
// Interim cover: ritu-evals/tools/test-intent-harness.js asserts the same contract
// (insert / move-in-place / idempotent / different-doctor-is-a-new-row) against a
// JS model of the upsert. Weaker than a real database, but not nothing — and it is
// what caught the duplicate-appointment mechanism.
const IST = 'Asia/Kolkata';
function nextIstWeekday(targetDow, hh, mm) {
  // A Date whose LOCAL fields are the IST wall clock, so getDay() is the IST day.
  const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: IST }));
  const d = new Date(nowIst);
  d.setHours(hh, mm, 0, 0);
  let delta = (targetDow - d.getDay() + 7) % 7;
  if (delta === 0 && d <= nowIst) delta = 7;      // that time already went by today
  d.setDate(d.getDate() + delta);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}:00+05:30`;
}
// Both doctors sit Mon–Fri, so a Monday is always a valid clinic day.
const MON = 1;
const MON_1900 = nextIstWeekday(MON, 19, 0);
const MON_1930 = nextIstWeekday(MON, 19, 30);
const MON_1530 = nextIstWeekday(MON, 15, 30);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function activeRows(pool, clinicId, patientId, doctorId) {
  const { rows } = await pool.query(
    `SELECT id, appointment_time FROM appointments
      WHERE clinic_id=$1 AND patient_id=$2 AND doctor_id=$3 AND status='booked'
      ORDER BY appointment_time`,
    [clinicId, patientId, doctorId]
  );
  return rows;
}

async function main() {
  const { pool, clinicId } = await setupTestDb();
  skipUnlessSupported(pool, 'cteInsert', 'reschedule/move of an existing appointment and its rollback behaviour');
  const docs = await seedSaiShradha(pool, clinicId);
  const patwardhan = docs['Dr. Kapil Patwardhan'].id;   // Mon-Fri 18:30-20:30
  const bhosale = docs['Dr. Priyanka Bhosale'].id;      // Mon-Fri (15:30 valid per existing suite)
  const ctx = { pool, clinicId, patientPhone: PHONE, calendar: stubCal };
  const book = (doctor_id, dt) => bookAppointment({ patient_name: 'Shilpa', doctor_id, appointment_datetime: dt, reason: 'test' }, ctx);

  console.log('\n[1] First booking → fresh insert');
  const r1 = await book(patwardhan, MON_1900); // Monday 19:00
  assert('success', r1.success === true, JSON.stringify(r1));
  assert('not a reschedule (first book)', r1.action !== 'rescheduled');
  const pid = (await pool.query(`SELECT patient_id FROM appointments WHERE id=$1`, [r1.appointment_id])).rows[0].patient_id;

  console.log('\n[2] Same doctor, NEW time → reschedule (move), NOT a 2nd row');
  const r2 = await book(patwardhan, MON_1930); // 19:30
  assert('success', r2.success === true, JSON.stringify(r2));
  assert("action='rescheduled'", r2.action === 'rescheduled', r2.action);
  assert('same appointment_id (moved, not new)', r2.appointment_id === r1.appointment_id, `${r1.appointment_id} vs ${r2.appointment_id}`);
  let rows = await activeRows(pool, clinicId, pid, patwardhan);
  assert('exactly ONE active row', rows.length === 1, `got ${rows.length}`);
  assert('row is at the NEW time 19:30', new Date(rows[0].appointment_time).getTime() === new Date(MON_1930).getTime(), rows[0].appointment_time);

  console.log('\n[3] Change back to original time → still ONE row, at 19:00');
  const r3 = await book(patwardhan, MON_1900);
  assert("action='rescheduled'", r3.action === 'rescheduled', r3.action);
  rows = await activeRows(pool, clinicId, pid, patwardhan);
  assert('still ONE active row', rows.length === 1, `got ${rows.length}`);
  assert('row back at 19:00', new Date(rows[0].appointment_time).getTime() === new Date(MON_1900).getTime(), rows[0].appointment_time);

  console.log('\n[4] Re-confirm SAME time → idempotent, still one row');
  const r4 = await book(patwardhan, MON_1900);
  assert('idempotent', r4.idempotent === true, JSON.stringify(r4));
  rows = await activeRows(pool, clinicId, pid, patwardhan);
  assert('still ONE active row', rows.length === 1, `got ${rows.length}`);

  console.log('\n[5] DIFFERENT doctor → a SEPARATE appointment (not a move)');
  const r5 = await book(bhosale, MON_1530); // Monday 15:30
  assert('success', r5.success === true, JSON.stringify(r5));
  assert('not a reschedule', r5.action !== 'rescheduled');
  const patwardhanRows = await activeRows(pool, clinicId, pid, patwardhan);
  const bhosaleRows = await activeRows(pool, clinicId, pid, bhosale);
  assert('Patwardhan still 1 row', patwardhanRows.length === 1, `got ${patwardhanRows.length}`);
  assert('Bhosale has its own 1 row', bhosaleRows.length === 1, `got ${bhosaleRows.length}`);

  await pool.end();
  console.log(`\n${pass}/${pass + fail} passing`);
  if (fail > 0) { console.log('✗ reschedule-invariant tests FAILED.'); process.exit(1); }
  console.log('✓ All booking-reschedule invariant tests passing.');
}

main().catch(e => { console.error(e); process.exit(1); });
