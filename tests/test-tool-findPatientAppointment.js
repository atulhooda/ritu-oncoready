#!/usr/bin/env node
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha } = require('../tools/testHelpers/setupDb');
const { execute: findPatientAppointment } = require('../tools/findPatientAppointment');
const { normalizePhone } = require('../tools/utils/phoneNormalizer');

let pass = 0, fail = 0, failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push({ name, detail }); }
}

// Pin "now" so we control what counts as past vs future.
const NOW_ISO  = '2026-05-25T12:00:00+05:30';  // Monday noon IST
const PHONE_FAM = '+919876543210';

async function main() {
  const { pool, clinicId } = await setupTestDb();
  const docs = await seedSaiShradha(pool, clinicId);
  const normPhone = normalizePhone(PHONE_FAM);

  // Seed two patients under the same phone (family scenario).
  const { rows: [papa] } = await pool.query(
    `INSERT INTO patients (clinic_id, phone, name) VALUES ($1, $2, 'Papa Sharma') RETURNING id`,
    [clinicId, normPhone]
  );
  const { rows: [self] } = await pool.query(
    `INSERT INTO patients (clinic_id, phone, name) VALUES ($1, $2, 'Rahul Sharma') RETURNING id`,
    [clinicId, normPhone]
  );

  // Future booked: Papa with Patwardhan on Tue
  const { rows: [futurePapa] } = await pool.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source)
     VALUES ($1, $2, $3, '2026-05-26T19:00:00+05:30', 'BP check', 'booked', 'ritu') RETURNING id`,
    [clinicId, papa.id, docs['Dr. Kapil Patwardhan'].id]
  );
  // Future booked: Rahul with Gaikwad on Wed
  const { rows: [futureSelf] } = await pool.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source)
     VALUES ($1, $2, $3, '2026-05-27T16:00:00+05:30', 'fever', 'booked', 'ritu') RETURNING id`,
    [clinicId, self.id, docs['Dr. Vikas Gaikwad'].id]
  );
  // Cancelled appointment for Rahul — should NOT be returned.
  await pool.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source)
     VALUES ($1, $2, $3, '2026-05-28T16:00:00+05:30', 'cancelled visit', 'cancelled', 'ritu')`,
    [clinicId, self.id, docs['Dr. Vikas Gaikwad'].id]
  );
  // Past appointment for Papa — should NOT be returned (the DATE filter, which
  // is why status stays 'booked': a 'completed' row would be excluded by status
  // and the test would pass without ever exercising the date).
  //
  // A DIFFERENT DOCTOR, and that is not cosmetic. This used to reuse
  // Dr. Kapil Patwardhan, who already holds Papa's future booked row above —
  // two active rows for one (clinic, patient, doctor). Migration 005's
  // uniq_active_patient_doctor forbids exactly that, so real Postgres answered
  // `duplicate key value violates unique constraint "uniq_active_patient_doctor"`.
  // pg-mem only ever loaded migration 001, so the index did not exist there and
  // the fixture seeded a state PRODUCTION CANNOT REACH — the test was green
  // against a database shaped differently from the one it ships to.
  await pool.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source)
     VALUES ($1, $2, $3, '2026-05-20T19:00:00+05:30', 'past visit', 'booked', 'ritu')`,
    [clinicId, papa.id, docs['Dr. Priyanka Bhosale'].id]
  );

  // ─── Case 1: Two patients same phone, NO name → both appointments ──────
  console.log('\n[1] Two patients same phone, name not provided');
  {
    const r = await findPatientAppointment({}, { pool, clinicId, patientPhone: PHONE_FAM, currentDatetime: NOW_ISO });
    assert('returns both appointments',     r.appointments.length === 2, `got ${r.appointments.length}`);
    assert('marks ambiguous=true',          r.ambiguous === true);
    assert('distinct_patient_names lists both', r.distinct_patient_names.length === 2);
    assert('appointments ordered by time',  r.appointments[0].appointment_time < r.appointments[1].appointment_time);
  }

  // ─── Case 1b: Same setup but WITH name → only matching one ─────────────
  console.log('\n[1b] Same setup, name=Rahul → only Rahul\'s appointment');
  {
    const r = await findPatientAppointment({ patient_name: 'Rahul' }, { pool, clinicId, patientPhone: PHONE_FAM, currentDatetime: NOW_ISO });
    assert('returns 1 appointment',         r.appointments.length === 1, `got ${r.appointments.length}`);
    assert('returned patient name matches', r.appointments[0].patient_name === 'Rahul Sharma');
    assert('ambiguous=false when name given', r.ambiguous === false);
  }

  // ─── Case 2: Cancelled appointments not returned ───────────────────────
  console.log('\n[2] Cancelled appointment in history → not returned');
  {
    const r = await findPatientAppointment({ patient_name: 'Rahul' }, { pool, clinicId, patientPhone: PHONE_FAM, currentDatetime: NOW_ISO });
    const cancelled = r.appointments.find(a => a.status === 'cancelled');
    assert('no cancelled rows in response', !cancelled);
    assert('only booked rows returned',     r.appointments.every(a => a.status === 'booked'));
  }

  // ─── Case 3: Past appointments not returned ────────────────────────────
  console.log('\n[3] Past appointment → not returned');
  {
    const r = await findPatientAppointment({ patient_name: 'Papa' }, { pool, clinicId, patientPhone: PHONE_FAM, currentDatetime: NOW_ISO });
    assert('returns only 1 (future)',       r.appointments.length === 1, `got ${r.appointments.length}`);
    const t = new Date(r.appointments[0].appointment_time).getTime();
    assert('appointment is in the future',  t > new Date(NOW_ISO).getTime());
  }

  // ─── Case 4: Patient with no appointments → empty array (not error) ────
  console.log('\n[4] Patient with no appointments → empty array');
  {
    const r = await findPatientAppointment({}, { pool, clinicId, patientPhone: '+919999999999', currentDatetime: NOW_ISO });
    assert('appointments=[]',               Array.isArray(r.appointments) && r.appointments.length === 0);
    assert('distinct_patient_names=[]',     r.distinct_patient_names.length === 0);
    assert('ambiguous=false',               r.ambiguous === false);
  }

  // ─── Case 5: Phone with +91 vs without ─────────────────────────────────
  console.log('\n[5] Phone normalization: +91 prefix vs raw 10-digit both match');
  {
    const withPlus = await findPatientAppointment({}, { pool, clinicId, patientPhone: '+919876543210', currentDatetime: NOW_ISO });
    const raw      = await findPatientAppointment({}, { pool, clinicId, patientPhone: '9876543210',    currentDatetime: NOW_ISO });
    assert('+91-prefixed returns 2',        withPlus.appointments.length === 2);
    assert('raw 10-digit returns 2',        raw.appointments.length === 2);
    assert('both return same appointment IDs',
      JSON.stringify(withPlus.appointments.map(a => a.appointment_id).sort()) ===
      JSON.stringify(raw.appointments.map(a => a.appointment_id).sort()));
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    for (const f of failures) console.log(' -', f.name, f.detail ? `(${f.detail})` : '');
    process.exit(1);
  }
  console.log('\n✓ All findPatientAppointment tests passing.');
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
