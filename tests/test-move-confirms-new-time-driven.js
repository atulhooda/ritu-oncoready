#!/usr/bin/env node
'use strict';
// A PHONE MOVE ENDS THE CALL WITH THE NEW TIME, LIKE A BOOKING DOES.
//
// callHandler records `result.booking.appointment_time` / `result.appointmentTime`
// from a booking turn and hands them to the call-end WhatsApp (crm.logCall →
// sendConfirmation) and the calls row. The UPDATE_APPOINTMENT success path
// returned neither, so a patient who moved their slot on the phone got a
// confirmation reading "your scheduled time". Driven through processLeanRaw
// with the two tools stubbed on their module objects.
//
// Run:            node tests/test-move-confirms-new-time-driven.js
// Prove it fails: MUTANT=MUT-MOVE-NO-BOOKING node tests/test-move-confirms-new-time-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

(async () => {
  console.log('\nMOVE CONFIRMS THE NEW TIME — driven\n');
  const config = require('../config.js');
  const db = require('../db.js');
  const find = require('../tools/findPatientAppointment');
  const update = require('../tools/updateAppointment');
  const brain = require('../brain-lean.js');
  config.agentMayReschedule = true; config.agentMayCancel = false;
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr. Daksha Patel', specialty: 'Dermatologist', windows: [], taken: [] }] });
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  const NEW = '2026-09-18T12:30:00.000Z';
  find.execute = async () => ({ appointments: [{ appointment_id: 'a1', appointment_time: '2026-09-18T10:00:00.000Z', doctor_name: 'Dr. Daksha Patel', doctor_id: 'd1', patient_name: 'Reena' }], distinct_patient_names: ['Reena'] });
  let calls = 0;
  update.execute = async () => { calls++; return { success: true, action: 'rescheduled', appointment_id: 'a1', doctor_name: 'Dr. Daksha Patel', new_appointment_time: NEW }; };
  if (MUTANT === 'MUT-MOVE-NO-BOOKING') {
    const real = brain.processLeanRaw;
    brain.processLeanRaw = async (...a) => { const r = await real(...a); delete r.booking; delete r.appointmentTime; return r; }; // the old shape
  }
  const ctx = { clinicId: 'c1', callerPhone: '+91 98765 43210', patientName: 'Reena', languageCode: 'gu-IN', patientTextAll: 'કાલે બપોરે કરી દો', currentDatetime: '2026-09-17T05:00:00.000Z', driftReasked: false };
  const r = await brain.processLeanRaw('UPDATE_APPOINTMENT:{"dateTime":"2026-09-18T18:00:00+05:30","patientName":"Reena"}', ctx);
  ok('the move ran through the tool once and is spoken as done', () => { assert.strictEqual(calls, 1); assert.strictEqual(r.rescheduled, true); assert.strictEqual(r.booked, true); });
  ok('the result carries booking.appointment_time and appointmentTime = the NEW time (what callHandler records for the call-end WhatsApp)', () => {
    assert.ok(r.booking, 'booking missing');
    assert.strictEqual(r.booking.appointment_time, NEW);
    assert.strictEqual(r.booking.appointment_id, 'a1');
    assert.strictEqual(r.booking.doctor_name, 'Dr. Daksha Patel');
    assert.strictEqual(r.appointmentTime, NEW);
  });
  ok('the spoken line names the doctor and a time, in Gujarati', () => { assert.match(r.text, /[઀-૿]/); assert.match(r.text, /Daksha/); });
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
