#!/usr/bin/env node
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('AGENT_MAY_CANCEL', 'on', 'the agent-side cancel/reschedule path itself is under test; the staff-only profile is covered by test-cancel-staff-only.js');
const { setupTestDb, seedSaiShradha } = require('../tools/testHelpers/setupDb');
const { execute: updateAppointment } = require('../tools/updateAppointment');
const { normalizePhone } = require('../tools/utils/phoneNormalizer');

let pass = 0, fail = 0, failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push({ name, detail }); }
}

const NOW_ISO  = '2026-05-25T10:00:00+05:30';
const PHONE    = '+919876543210';

// Stub calendars
const calOK = {
  updateAppointment: async ({ eventId, dateTime }) => ({ success: true, eventId }),
  deleteEvent: async () => ({ deleted: true })
};
const calFails = {
  updateAppointment: async () => { throw new Error('simulated GCal 500'); },
  deleteEvent:       async () => { throw new Error('simulated GCal 500'); }
};

// Helper to seed a fresh appointment row for each test case.
async function makeAppointment(pool, clinicId, doctorId, when, opts = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO patients (clinic_id, phone, name) VALUES ($1, $2, 'Test Patient') ON CONFLICT DO NOTHING RETURNING id`,
    [clinicId, normalizePhone(PHONE)]
  );
  const patientId = p ? p.id : (await pool.query(
    `SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2 AND name='Test Patient' LIMIT 1`,
    [clinicId, normalizePhone(PHONE)]
  )).rows[0].id;

  // ─── ONE ACTIVE ROW PER PATIENT PER DOCTOR ──────────────────────────────
  // Migration 005's uniq_active_patient_doctor makes a second 'booked' row for
  // the same (clinic, patient, doctor) impossible. Each case here seeds its own
  // appointment for the same pair, so from case 2 onward real Postgres answered
  // `duplicate key value violates unique constraint "uniq_active_patient_doctor"`.
  //
  // pg-mem only ever loaded migration 001, so the index did not exist and every
  // case happily stacked another active row — a shape production cannot hold.
  // Retiring the previous one is what a clinic actually does between visits, and
  // it keeps the cases independent.
  await pool.query(
    `UPDATE appointments SET status = 'cancelled'
      WHERE clinic_id = $1 AND patient_id = $2 AND doctor_id = $3 AND status = 'booked'`,
    [clinicId, patientId, doctorId]
  );
  const { rows: [a] } = await pool.query(
    `INSERT INTO appointments
       (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source, google_calendar_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ritu', $7)
     RETURNING id`,
    [clinicId, patientId, doctorId, when, opts.reason || 'checkup', opts.status || 'booked', opts.eventId || null]
  );
  return a.id;
}

async function main() {
  const { pool, clinicId } = await setupTestDb();
  const docs = await seedSaiShradha(pool, clinicId);

  // ─── Case 1: reschedule to valid time → DB + GCal ──────────────────────
  console.log('\n[1] Reschedule to valid time');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Priyanka Bhosale'].id,
      '2026-05-25T15:30:00+05:30', { eventId: 'gcal-ev-1' }
    );
    const r = await updateAppointment(
      { appointment_id: id, new_datetime: '2026-05-26T15:00:00+05:30' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('success=true',          r.success === true, JSON.stringify(r));
    assert('action=rescheduled',    r.action === 'rescheduled');
    assert('calendar_updated=true', r.calendar_updated === true);
    const { rows: [appt] } = await pool.query(`SELECT appointment_time FROM appointments WHERE id=$1`, [id]);
    assert('DB time updated', new Date(appt.appointment_time).toISOString() === '2026-05-26T09:30:00.000Z');
  }

  // ─── Case 2: reschedule to time outside doctor's hours ─────────────────
  console.log('\n[2] Reschedule to time outside doctor\'s hours');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Priyanka Bhosale'].id, '2026-05-25T15:30:00+05:30'
    );
    const r = await updateAppointment(
      { appointment_id: id, new_datetime: '2026-05-26T09:00:00+05:30' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('success=false',                 r.success === false, JSON.stringify(r));
    assert('error mentions hours',          /hours/i.test(r.error_message));
    assert('alternatives include same-day', r.alternatives.some(a => a.suggested_time === '15:00'));
  }

  // ─── Case 3: reschedule to day doctor doesn't work ─────────────────────
  console.log('\n[3] Reschedule to day doctor doesn\'t work');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Priyanka Bhosale'].id, '2026-05-25T15:30:00+05:30'
    );
    // Sunday — Bhosale only works Mon-Fri.
    const r = await updateAppointment(
      { appointment_id: id, new_datetime: '2026-05-31T15:30:00+05:30' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('success=false',          r.success === false);
    assert('error mentions Sunday',  /Sunday/i.test(r.error_message));
    assert('alternatives populated', r.alternatives.length > 0);
  }

  // ─── Case 4: cancel ────────────────────────────────────────────────────
  console.log('\n[4] Cancel');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Vikas Gaikwad'].id,
      '2026-05-28T16:00:00+05:30', { eventId: 'gcal-to-delete' }
    );
    const r = await updateAppointment(
      { appointment_id: id, cancel: true },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('success=true',           r.success === true);
    assert('action=cancelled',       r.action === 'cancelled');
    assert('calendar_cleared=true',  r.calendar_cleared === true);
    const { rows: [appt] } = await pool.query(`SELECT status FROM appointments WHERE id=$1`, [id]);
    assert('DB status=cancelled',    appt.status === 'cancelled');
  }

  // ─── Case 5: already cancelled ─────────────────────────────────────────
  console.log('\n[5] Already cancelled appointment');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Vikas Gaikwad'].id,
      '2026-05-28T16:00:00+05:30', { status: 'cancelled' }
    );
    const r = await updateAppointment(
      { appointment_id: id, new_datetime: '2026-05-29T16:00:00+05:30' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('success=false',                  r.success === false);
    assert('error mentions already cancelled', /already cancelled/i.test(r.error_message));
  }

  // ─── Case 6: reschedule past appointment ───────────────────────────────
  console.log('\n[6] Reschedule a past appointment');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Vikas Gaikwad'].id,
      '2026-05-20T16:00:00+05:30'
    );
    const r = await updateAppointment(
      { appointment_id: id, new_datetime: '2026-05-28T16:00:00+05:30' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('success=false',                   r.success === false);
    assert('error mentions past',             /past/i.test(r.error_message));
  }

  // ─── Case 7: GCal fails on update → DB still updates ───────────────────
  console.log('\n[7] GCal fails on update → DB still updates');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Vikas Gaikwad'].id,
      '2026-05-28T15:30:00+05:30', { eventId: 'gcal-failing' }
    );
    const r = await updateAppointment(
      { appointment_id: id, new_datetime: '2026-05-28T17:00:00+05:30' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO, calendar: calFails }
    );
    assert('success=true despite GCal fail', r.success === true, JSON.stringify(r));
    assert('calendar_updated=false',         r.calendar_updated === false);
    const { rows: [appt] } = await pool.query(`SELECT appointment_time FROM appointments WHERE id=$1`, [id]);
    assert('DB time still updated',
      new Date(appt.appointment_time).toISOString() === '2026-05-28T11:30:00.000Z');
  }

  // ─── Case: a DIFFERENT caller cannot touch this patient's appointment ──
  console.log('\n[security] Wrong caller phone → cannot cancel/reschedule');
  {
    const id = await makeAppointment(
      pool, clinicId, docs['Dr. Priyanka Bhosale'].id, '2026-05-25T15:30:00+05:30'
    );
    // Spoofed/other caller (different number) tries to cancel PHONE's appointment.
    const r = await updateAppointment(
      { appointment_id: id, cancel: true },
      { pool, clinicId, patientPhone: '+919999000011', currentDatetime: NOW_ISO, calendar: calOK }
    );
    assert('blocked: success=false',     r.success === false, JSON.stringify(r));
    assert('blocked: "not found"',       /not found/i.test(r.error_message || ''));
    const { rows: [appt] } = await pool.query(`SELECT status FROM appointments WHERE id=$1`, [id]);
    assert('appointment NOT cancelled',  appt && appt.status === 'booked', `status=${appt && appt.status}`);
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    for (const f of failures) console.log(' -', f.name, f.detail ? `(${f.detail})` : '');
    process.exit(1);
  }
  console.log('\n✓ All updateAppointment tests passing.');
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
