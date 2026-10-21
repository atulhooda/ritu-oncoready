#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Verifies the calls-logging write path: the new columns accept data and the
// transcript JSONB round-trips (Devanagari preserved) — mirrors db.js
// logCallToDb's exact INSERT. Runs on pg-mem (no live DB).
//
// Run: node tests/test-call-logging.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb } = require('../tools/testHelpers/setupDb');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const { pool, clinicId } = await setupTestDb();
  // THE HAND-KEPT COPY OF MIGRATION 002 IS GONE. These three ALTERs used to sit
  // here because setupTestDb loaded migration 001 ONLY — so the test maintained
  // its own idea of the schema next to the real one, and drifted. With
  // TEST_DATABASE_URL it then collided outright ("column language already
  // exists"), and once the pg-mem double learned to follow the later migrations
  // too, it collided there as well.
  //
  // Both backends now apply 002, so the copy is not just redundant, it is a
  // second source of truth for a schema that already has one. That is the
  // defect class this repo has paid for five times over.

  const transcript = [
    { role: 'patient', text: 'मेरे पीरियड्स डिले हो रहे हैं', time: '2026-06-05T17:59:44.000Z' },
    { role: 'ritu',    text: 'डॉ. प्रियंका भोसले से मिल सकती हैं', time: '2026-06-05T17:59:46.000Z' },
    { role: 'patient', text: 'सोमवार का', time: '2026-06-05T18:00:18.000Z' },
    { role: 'ritu',    text: '✅ सोमवार 8 जून 3:00 बजे बुक हो गई', time: '2026-06-05T18:00:34.000Z' },
  ];

  // Exact shape of db.js logCallToDb INSERT.
  await pool.query(
    `INSERT INTO calls (clinic_id, exotel_call_sid, patient_phone, patient_id,
                        patient_name, duration_seconds, outcome, whatsapp_sent,
                        appointment_id, transcript, language, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11)
     ON CONFLICT (exotel_call_sid) DO NOTHING`,
    [
      clinicId, 'sid_test_001', '+919876543210', null,
      'Seema', 83, 'booked',
      null,
      JSON.stringify(transcript), 'hi-IN', 'periods delay',
    ]
  );

  const { rows } = await pool.query(
    `SELECT exotel_call_sid, outcome, language, reason, transcript, duration_seconds
     FROM calls WHERE exotel_call_sid = $1`,
    ['sid_test_001']
  );
  console.log('\n[calls write path]');
  assert('row inserted', rows.length === 1);
  const r = rows[0] || {};
  assert('outcome persisted',  r.outcome === 'booked');
  assert('language persisted', r.language === 'hi-IN', `got ${r.language}`);
  assert('reason persisted',   r.reason === 'periods delay', `got ${r.reason}`);
  assert('duration persisted', r.duration_seconds === 83);

  // transcript JSONB round-trips (pg returns object; pg-mem may return a string).
  let t = r.transcript;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch {} }
  assert('transcript is an array of 4 turns', Array.isArray(t) && t.length === 4, `got ${JSON.stringify(t).slice(0,80)}`);
  assert('transcript roles intact', Array.isArray(t) && t[0].role === 'patient' && t[1].role === 'ritu');
  assert('Devanagari preserved',    Array.isArray(t) && /पीरियड्स/.test(t[0].text), `got ${Array.isArray(t) ? t[0].text : '-'}`);
  assert('timestamps preserved',    Array.isArray(t) && t[3].time === '2026-06-05T18:00:34.000Z');

  // A call with no transcript / no booking (inquiry) still logs.
  await pool.query(
    `INSERT INTO calls (clinic_id, exotel_call_sid, patient_phone, patient_id,
                        patient_name, duration_seconds, outcome, whatsapp_sent,
                        appointment_id, transcript, language, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11)
     ON CONFLICT (exotel_call_sid) DO NOTHING`,
    [clinicId, 'sid_test_002', '+917017886366', null, null, 12, 'hangup', null, null, 'hi-IN', null]
  );
  const { rows: r2 } = await pool.query(`SELECT outcome, transcript FROM calls WHERE exotel_call_sid='sid_test_002'`);
  assert('non-booking call still logged', r2.length === 1 && r2[0].outcome === 'hangup');
  assert('null transcript is fine',       r2.length === 1 && (r2[0].transcript == null));

  console.log(`\n${pass}/${pass + fail} passing`);
  if (fail) { console.log('✗ FAILURES'); process.exit(1); }
  console.log('✓ All call-logging tests passing.');
  process.exit(0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
