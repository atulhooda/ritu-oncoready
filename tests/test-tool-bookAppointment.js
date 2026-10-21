#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Unit tests for tools/bookAppointment.js
//
// Run: node test-tool-bookAppointment.js
//
// Calendar API is stubbed via context.calendar so tests don't hit Google.
// The "calendar fails" case substitutes a stub that throws.
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha, skipUnlessSupported } = require('../tools/testHelpers/setupDb');
const { execute: bookAppointment } = require('../tools/bookAppointment');
const { normalizePhone } = require('../tools/utils/phoneNormalizer');

// Weekday semantics for deterministic behaviour (IST). See nextDow() below.
//   THU — ordinary working day
//   TUE — the walk-in doctor's day (uniq_doctor_slot exempt)
//   MON — the scheduled doctor working

// ─── DATES ARE RELATIVE, AND THAT IS THE POINT ───────────────────────────────
// These were pinned to 2026-05-25..31 for deterministic weekday behaviour. That
// worked until those dates went past, at which point every booking assertion
// started failing with "Requested time is in the past" — 14 of them. Nobody
// noticed for ~10 weeks BECAUSE NO GATE RAN THIS FILE. A test that rots on a
// calendar is a test that stops being evidence without ever saying so.
//
// The weekday is what actually matters (Tuesday = Dr. Nikam's walk-in day,
// Monday = Dr. Patwardhan working), so each date is now the NEXT occurrence of
// that weekday, always in the future.
const IST_OFFSET = '+05:30';
function nextDow(dow) {           // 0=Sun … 6=Sat, always strictly future
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  let delta = (dow - d.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MON = nextDow(1), TUE = nextDow(2), THU = nextDow(4), FRI = nextDow(5), SUN = nextDow(0);

const PATIENT_PHONE = '+919876543210';

let pass = 0, fail = 0;
const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push({ name, detail }); }
}

// Stub calendar modules — return what a successful Google Calendar create
// would return. The "fails" case uses a thrower.
const stubCalendarOK = {
  bookAppointment: async () => ({ success: true, eventId: 'stub_gcal_event_xyz' })
};
const stubCalendarFails = {
  bookAppointment: async () => { throw new Error('Simulated GCal 500'); }
};
// Calendar reports a genuine slot conflict (slot busy on the calendar even
// though the DB availability check passed) — the booking must NOT go through.
const stubCalendarConflict = {
  bookAppointment: async () => ({ success: false, code: 'slot_conflict', error: 'Slot no longer available' })
};

async function main() {
  const { pool, clinicId } = await setupTestDb();
  skipUnlessSupported(pool, 'cteInsert', 'every booking case — idempotent re-book, double-book rejection, calendar-conflict rollback, walk-in flagging');
  const docs = await seedSaiShradha(pool, clinicId);

  // ─── Case 1: valid booking ─────────────────────────────────────────────
  console.log('\n[1] Valid booking');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarOK };
    const r = await bookAppointment({
      patient_name: 'Siddharth Pathania',
      doctor_id: docs['Dr. Priyanka Bhosale'].id,
      appointment_datetime: `${MON}T15:30:00+05:30`, // Monday 15:30 IST
      reason: 'consultation'
    }, ctx);
    assert('success=true',          r.success === true, JSON.stringify(r));
    assert('appointment_id set',    !!r.appointment_id);
    assert('patient_id set',        !!r.patient_id);
    assert('gcal event id captured', r.google_calendar_event_id === 'stub_gcal_event_xyz');
    // Verify DB row exists
    const { rows: [appt] } = await pool.query(
      `SELECT status, google_calendar_event_id, reason FROM appointments WHERE id = $1`,
      [r.appointment_id]
    );
    assert('DB row status=booked',  appt && appt.status === 'booked');
    assert('DB row has gcal id',    appt && appt.google_calendar_event_id === 'stub_gcal_event_xyz');
  }

  // ─── Case 2: same patient calls twice for same doctor (different time) ──
  console.log('\n[2] Same patient, same doctor, different time → reuses patient row');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarOK };
    const r = await bookAppointment({
      patient_name: 'Siddharth Pathania',
      doctor_id: docs['Dr. Priyanka Bhosale'].id,
      appointment_datetime: `${TUE}T15:30:00+05:30`, // Tuesday this time
      reason: 'follow-up'
    }, ctx);
    assert('success=true',                  r.success === true);
    // Same patient, so the patients table should still have only one row for
    // this phone+name combination.
    // bookAppointment normalizes phone before insert ("+919876543210" → "9876543210")
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as n FROM patients WHERE clinic_id = $1 AND phone = $2 AND LOWER(name) = LOWER($3)`,
      [clinicId, normalizePhone(PATIENT_PHONE), 'Siddharth Pathania']
    );
    assert('single patient row',            rows[0].n === 1, `got ${rows[0].n}`);
  }

  // ─── Case 3: doctor not working that day ───────────────────────────────
  console.log('\n[3] Doctor not working that day');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarOK };
    // Bhosale works Mon-Fri only. Try Sunday.
    const r = await bookAppointment({
      patient_name: 'Asha Verma',
      doctor_id: docs['Dr. Priyanka Bhosale'].id,
      appointment_datetime: `${SUN}T15:30:00+05:30`, // Sunday
      reason: 'consultation'
    }, ctx);
    assert('success=false',                 r.success === false, JSON.stringify(r));
    assert('error mentions Sunday',         /Sunday/i.test(r.error_message), r.error_message);
    // fail_kind is what brain-lean switches on to choose the SENTENCE. Asserting
    // it here, against the real tool, is what stops that switch being tested
    // only against fixtures a test wrote for itself — stripping fail_kind from
    // the tool left tests/test-booking-failure-kinds.js green, because it stubs
    // execute() and supplies the kind. See docs/ROADMAP.md §P1.
    assert('fail_kind says NOT WORKING, not slot-taken',
      r.fail_kind === 'not_working' || r.fail_kind === 'day_off',
      `fail_kind=${r.fail_kind} — brain-lean would tell the caller to pick another TIME on a day the doctor does not sit`);
    assert('alternatives non-empty',        Array.isArray(r.alternatives) && r.alternatives.length > 0);
    assert('next alt is a working day',     r.alternatives[0].day_name && r.alternatives[0].day_name !== 'Sunday');
  }

  // ─── Case 4: time outside doctor's hours ────────────────────────────────
  console.log('\n[4] Time outside doctor\'s hours');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarOK };
    // Bhosale on Tuesday but at 9:00 (clinic hours are 15:00-16:30).
    const r = await bookAppointment({
      patient_name: 'Asha Verma',
      doctor_id: docs['Dr. Priyanka Bhosale'].id,
      appointment_datetime: `${TUE}T09:00:00+05:30`,
      reason: 'consultation'
    }, ctx);
    assert('success=false',                 r.success === false, JSON.stringify(r));
    assert('error mentions hours',          /hours|15:00|16:30/.test(r.error_message), r.error_message);
    assert('fail_kind is set for out-of-hours', !!r.fail_kind, `fail_kind=${r.fail_kind}`);
    assert('alternatives include same day with valid time',
      Array.isArray(r.alternatives) && r.alternatives.some(a => a.suggested_time === '15:00'));
  }

  // ─── Case 5: doctor on leave that day (exception entry) ─────────────────
  console.log('\n[5] Doctor on leave that day');
  {
    // Insert a leave exception for the scheduled doctor on the next Friday.
    // Was `VALUES ($1, FRI, 'leave')` — a missing `$` on the template variable,
    // so FRI reached Postgres as a bare identifier and real Postgres answered
    // `column "fri" does not exist`. The date now travels as a parameter, which
    // is what it should always have been.
    await pool.query(
      `INSERT INTO doctor_exceptions (doctor_id, exception_date, exception_type)
       VALUES ($1, $2, 'leave')`,
      [docs['Dr. Kapil Patwardhan'].id, FRI]
    );
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarOK };
    const r = await bookAppointment({
      patient_name: 'Ravi Joshi',
      doctor_id: docs['Dr. Kapil Patwardhan'].id,
      appointment_datetime: `${FRI}T19:00:00+05:30`, // Friday during normal hours
      reason: 'consultation'
    }, ctx);
    assert('success=false',                 r.success === false, JSON.stringify(r));
    assert('error mentions leave',          /leave/i.test(r.error_message), r.error_message);
    assert('fail_kind is set for a leave day', !!r.fail_kind, `fail_kind=${r.fail_kind}`);
    assert('alternatives populated',        r.alternatives.length > 0);
  }

  // ─── Case 6: Google Calendar API fails → DB row still created ──────────
  console.log('\n[6] Google Calendar API fails → DB row still created');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarFails };
    const r = await bookAppointment({
      patient_name: 'Meera Iyer',
      doctor_id: docs['Dr. Vikas Gaikwad'].id,
      appointment_datetime: `${THU}T16:00:00+05:30`, // Thursday in hours
      reason: 'general checkup'
    }, ctx);
    assert('success=true even though calendar failed', r.success === true, JSON.stringify(r));
    assert('appointment_id set',                       !!r.appointment_id);
    assert('google_calendar_event_id is null',         r.google_calendar_event_id === null);
    const { rows: [appt] } = await pool.query(
      `SELECT status FROM appointments WHERE id = $1`, [r.appointment_id]
    );
    assert('DB row exists with status=booked',         appt && appt.status === 'booked');
  }

  // ─── Case 7: idempotency — concurrent booking same patient+doctor+time ──
  console.log('\n[7] Idempotency: duplicate booking returns the existing row');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarOK };
    const args = {
      patient_name: 'Tina Shah',
      doctor_id: docs['Dr. Vikas Gaikwad'].id,
      appointment_datetime: `${THU}T16:30:00+05:30`,
      reason: 'first visit'
    };
    const first = await bookAppointment(args, ctx);
    assert('first booking success',     first.success === true);
    const second = await bookAppointment(args, ctx);
    assert('second booking success',    second.success === true);
    assert('second is idempotent',      second.idempotent === true);
    assert('same appointment_id',       second.appointment_id === first.appointment_id);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as n FROM appointments
       WHERE patient_id = $1 AND doctor_id = $2 AND status = 'booked'`,
      [first.patient_id, docs['Dr. Vikas Gaikwad'].id]
    );
    assert('only one DB row exists',    rows[0].n === 1, `got ${rows[0].n}`);
  }

  // ─── Case 8: real calendar conflict → roll back, never falsely confirm ──
  console.log('\n[8] Calendar reports a real conflict → DB row rolled back, no false confirm');
  {
    const ctx = { pool, clinicId, patientPhone: PATIENT_PHONE, calendar: stubCalendarConflict };
    const r = await bookAppointment({
      patient_name: 'Rollback Conflict',
      doctor_id: docs['Dr. Priyanka Bhosale'].id,
      appointment_datetime: `${MON}T16:00:00+05:30`, // Monday, in hours, free in DB
      reason: 'consultation'
    }, ctx);
    assert('success=false (not falsely confirmed)', r.success === false, JSON.stringify(r));
    assert('message offers another time',           /taken|another time|another day/i.test(r.error_message || ''), r.error_message);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as n FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE p.clinic_id = $1 AND LOWER(p.name) = LOWER($2)`,
      [clinicId, 'Rollback Conflict']
    );
    assert('no orphan DB row (rolled back)',         rows[0].n === 0, `got ${rows[0].n}`);
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(' -', f.name, f.detail ? `(${f.detail})` : '');
    process.exit(1);
  } else {
    console.log('\n✓ All bookAppointment tests passing.');
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
