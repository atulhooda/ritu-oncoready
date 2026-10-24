#!/usr/bin/env node
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha } = require('../tools/testHelpers/setupDb');
const { execute: requestCallback, ETA_TEXT } = require('../tools/requestCallback');
const { normalizePhone } = require('../tools/utils/phoneNormalizer');

let pass = 0, fail = 0, failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push({ name, detail }); }
}

const NOW_ISO = '2026-05-25T12:00:00+05:30';
const PHONE   = '+919876543210';

async function main() {
  const { pool, clinicId } = await setupTestDb();
  await seedSaiShradha(pool, clinicId);

  // ─── Case 1: valid callback request ────────────────────────────────────
  console.log('\n[1] Valid callback request');
  {
    const r = await requestCallback(
      { patient_name: 'Anjali Verma', specialty: 'Neurology', reason: 'chronic migraine' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO }
    );
    assert('success=true',                r.success === true, JSON.stringify(r));
    assert('callback_id returned',        !!r.callback_id);
    assert('eta_text matches ETA',        r.eta_text === ETA_TEXT);
    const { rows: [cb] } = await pool.query(`SELECT status, patient_phone, specialty FROM callbacks WHERE id=$1`, [r.callback_id]);
    assert('DB row status=pending',       cb && cb.status === 'pending');
    assert('phone stored normalized',     cb && cb.patient_phone === normalizePhone(PHONE));
    assert('matched on-call specialty',   cb && /Neuro/i.test(cb.specialty));
  }

  // ─── Case 2: duplicate within 2 hours → returns existing ID ────────────
  console.log('\n[2] Duplicate within 2 hours → idempotent');
  {
    const first = await requestCallback(
      { patient_name: 'Manish Kapoor', specialty: 'Urology', reason: 'pain' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO }
    );
    const oneHourLater = '2026-05-25T13:00:00+05:30';
    const second = await requestCallback(
      { patient_name: 'Manish Kapoor', specialty: 'Urology', reason: 'pain' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: oneHourLater }
    );
    assert('first.success=true',                first.success === true);
    assert('second.success=true',               second.success === true);
    assert('second is idempotent',              second.idempotent === true);
    assert('same callback_id',                  second.callback_id === first.callback_id);
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int as n FROM callbacks WHERE clinic_id=$1 AND patient_phone=$2 AND specialty='Urology'`,
      [clinicId, normalizePhone(PHONE)]
    );
    assert('only one DB row for that combo',    n === 1, `got ${n}`);
  }

  // ─── Case 2b: same combo but >2 hours later → new row ──────────────────
  console.log('\n[2b] Same combo >2 hours later → new row');
  {
    const threeHoursLater = '2026-05-25T16:00:00+05:30';
    const r = await requestCallback(
      { patient_name: 'Manish Kapoor', specialty: 'Urology', reason: 'pain' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: threeHoursLater }
    );
    assert('success=true',                      r.success === true);
    assert('not idempotent (window expired)',   !r.idempotent);
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int as n FROM callbacks WHERE clinic_id=$1 AND patient_phone=$2 AND specialty='Urology'`,
      [clinicId, normalizePhone(PHONE)]
    );
    assert('now 2 DB rows for that combo',      n === 2, `got ${n}`);
  }

  // ─── Case 3: invalid specialty (no on-call match at this clinic) ───────
  console.log('\n[3] Invalid specialty (no on-call match)');
  {
    const r = await requestCallback(
      { patient_name: 'Rohit', specialty: 'Dermatology', reason: 'rashes' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO }
    );
    assert('success=false',                     r.success === false);
    assert('error rejects unsupported specialty', /not recognized|no on-call doctor/i.test(r.error_message), r.error_message);
  }

  // ─── Case 4: empty patient name → validation error ─────────────────────
  console.log('\n[4] Empty patient name');
  {
    const r = await requestCallback(
      { patient_name: '   ', specialty: 'Neurology', reason: 'migraine' },
      { pool, clinicId, patientPhone: PHONE, currentDatetime: NOW_ISO }
    );
    assert('success=false',                     r.success === false);
    assert('error mentions patient_name',       /patient_name/i.test(r.error_message));
  }

  // ─── Case 5: ETA text format check ────────────────────────────────────
  console.log('\n[5] ETA text format');
  {
    const r = await requestCallback(
      { patient_name: 'Saira Khan', specialty: 'Pediatric', reason: 'baby cough' },
      { pool, clinicId, patientPhone: '+919999900000', currentDatetime: NOW_ISO }
    );
    assert('eta_text in confirmation',          r.confirmation_text && r.confirmation_text.includes(ETA_TEXT));
    assert('confirmation mentions specialty',   r.confirmation_text && /Pediatric/i.test(r.confirmation_text));
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    for (const f of failures) console.log(' -', f.name, f.detail ? `(${f.detail})` : '');
    process.exit(1);
  }
  console.log('\n✓ All requestCallback tests passing.');
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
