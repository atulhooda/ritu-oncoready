#!/usr/bin/env node
// ─── ONE HANDSET, TWO PATIENTS, A DESTRUCTIVE WRITE ─────────────────────────
// Shared family phones are the norm in Indian clinics, and the schema says so
// out loud: patients is UNIQUE (clinic_id, phone, name), with db.js commenting
// "a later real name creates a distinct row (family-friendly)". So several
// people per number is a designed-for state, not an edge case.
//
// tools/findPatientAppointment.js:91 computes exactly the flag this needs —
//
//     const ambiguous = !patient_name && distinct_patient_names.length > 1;
//     note: `Multiple patient names registered on this phone: … Ask the
//            patient which one.`
//
// — and NOTHING in production reads it. The only readers are its own unit test.
// brain-lean.js destructures `appointments` and drops `ambiguous`,
// `distinct_patient_names` and `note` on the floor, then takes appts[0] over a
// list ordered `appointment_time ASC`. So on a shared handset the cancel lands
// on whoever's visit is SOONEST — and soonest-first is precisely the wrong
// tie-break, because the family member about to be seen is the one who loses
// their slot.
//
// AND THE FLAG WOULD NOT HAVE BEEN ENOUGH. `ambiguous` requires patient_name to
// be EMPTY. context.patientName is seeded from getReturningPatientName
// (db.js:56) = `ORDER BY created_at DESC LIMIT 1` — the most recently
// REGISTERED name on the phone, not whoever is on the line. So Ritu can greet
// Papa as "Rahul जी", filter the lookup to '%rahul%', and cancel the son's
// appointment while reporting ambiguous=false. That is why this file asserts on
// the CANDIDATES' own patient_name values, which are true in both directions,
// rather than on the flag.
//
// Nothing in the audio would reveal it: confirmCancel says "क्या मैं आपकी
// अपॉइंटमेंट कैंसिल कर दूँ जी?" and `cancelled` interpolates only {doctor}. For
// a family sharing a GP the doctor name is often right for BOTH people.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('AGENT_MAY_CANCEL', 'on', 'the agent-side cancel/reschedule path itself is under test; the staff-only profile is covered by test-cancel-staff-only.js');
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

// The household from the repo's own fixture (tests/test-tool-findPatientAppointment.js):
// Papa registered FIRST, Rahul second, one number. Papa's visit is SOONER.
const PAPA  = { appointment_id: 'appt-papa',  patient_name: 'Papa Sharma',  doctor_id: 'doc-1', doctor_name: 'Dr. Vikas Gaikwad', appointment_time: '2026-08-10T11:30:00.000Z' };
const RAHUL = { appointment_id: 'appt-rahul', patient_name: 'Rahul Sharma', doctor_id: 'doc-1', doctor_name: 'Dr. Vikas Gaikwad', appointment_time: '2026-08-11T11:30:00.000Z' };

// Stub the two tools brain-lean calls, then drive processLeanRaw.
function harness({ appointments, distinct }) {
  const calls = { find: [], update: [] };
  const fpa = require('../tools/findPatientAppointment.js');
  const upd = require('../tools/updateAppointment.js');
  const realFind = fpa.execute, realUpd = upd.execute;
  fpa.execute = async (args) => {
    calls.find.push(args);
    const name = (args && args.patient_name || '').trim().toLowerCase();
    const rows = name ? appointments.filter(a => a.patient_name.toLowerCase().includes(name)) : appointments;
    return {
      appointments: rows,
      distinct_patient_names: distinct,
      ambiguous: !name && distinct.length > 1,
      note: null,
    };
  };
  upd.execute = async (args) => { calls.update.push(args); return { success: true, doctor_name: 'Dr. Vikas Gaikwad' }; };
  return { calls, restore: () => { fpa.execute = realFind; upd.execute = realUpd; } };
}

const CTX = { clinicId: 'clinic-1', callerPhone: '+919876543210', languageCode: 'hi-IN', currentDatetime: '2026-08-08T08:00:00+05:30' };

console.log('\nSHARED HANDSET — a cancel must not guess which family member\n');

(async () => {
  const { processLeanRaw } = require('../brain-lean.js');

  await ok('THE BUG: two patients on one phone, no name given — must NOT cancel a guess', async () => {
    const h = harness({ appointments: [PAPA, RAHUL], distinct: ['Papa Sharma', 'Rahul Sharma'] });
    try {
      const out = await processLeanRaw('CANCEL_APPOINTMENT:{}', { ...CTX, patientName: null });
      assert.strictEqual(h.calls.update.length, 0,
        `a destructive cancel was issued for ${JSON.stringify(h.calls.update[0])} while TWO patients share this ` +
        `number — appts[0] is the SOONEST visit, so the family member about to be seen silently loses their slot`);
      assert.strictEqual(out.cancelled, undefined || out.cancelled, 'must not report a cancellation');
      assert(!out.cancelled, 'reported cancelled=true without cancelling anything');
      assert(out.text && out.text.length > 0, 'no question was asked');
      assert(/Papa|Rahul/.test(out.text),
        `the question must name the candidates so the caller can pick: ${out.text}`);
    } finally { h.restore(); }
  });

  await ok('THE WORSE CASE: a WRONG name filter still must not guess', async () => {
    // ambiguous === false here, because a name WAS supplied — just the wrong
    // one, from getReturningPatientName's newest-registered row. Papa calls and
    // is filtered to Rahul.
    const h = harness({ appointments: [PAPA, RAHUL], distinct: ['Papa Sharma', 'Rahul Sharma'] });
    try {
      const out = await processLeanRaw('CANCEL_APPOINTMENT:{}', { ...CTX, patientName: 'Rahul Sharma' });
      assert.strictEqual(h.calls.update.length, 0,
        'cancelled on a name the CALLER never said — it came from the newest-registered row on the handset');
      assert(!out.cancelled);
    } finally { h.restore(); }
  });

  await ok('ONE patient on the phone — unchanged, still cancels immediately', async () => {
    // The guard must not cost the common case a turn.
    const h = harness({ appointments: [PAPA], distinct: ['Papa Sharma'] });
    try {
      const out = await processLeanRaw('CANCEL_APPOINTMENT:{}', { ...CTX, patientName: 'Papa Sharma' });
      assert.strictEqual(h.calls.update.length, 1, 'a single-patient phone was made to answer a pointless question');
      assert.strictEqual(h.calls.update[0].appointment_id, 'appt-papa');
      assert.strictEqual(out.cancelled, true, 'a legitimate cancel stopped working');
    } finally { h.restore(); }
  });

  await ok('the caller NAMES the person — cancels that one, no question', async () => {
    const h = harness({ appointments: [PAPA, RAHUL], distinct: ['Papa Sharma', 'Rahul Sharma'] });
    try {
      const out = await processLeanRaw('CANCEL_APPOINTMENT:{"patientName":"Papa Sharma"}', { ...CTX, patientName: null });
      assert.strictEqual(h.calls.update.length, 1, 'an explicitly named patient still got a question');
      assert.strictEqual(h.calls.update[0].appointment_id, 'appt-papa', 'cancelled the WRONG named person');
      assert.strictEqual(out.cancelled, true);
    } finally { h.restore(); }
  });

  await ok('two appointments for the SAME person is a time choice, not a person choice', async () => {
    // Must still act. Only a PERSON ambiguity earns a question; asking "which
    // of your own two appointments" on every repeat visitor would be noise.
    const second = { ...PAPA, appointment_id: 'appt-papa-2', appointment_time: '2026-08-12T11:30:00.000Z' };
    const h = harness({ appointments: [PAPA, second], distinct: ['Papa Sharma'] });
    try {
      const out = await processLeanRaw('CANCEL_APPOINTMENT:{}', { ...CTX, patientName: 'Papa Sharma' });
      assert.strictEqual(h.calls.update.length, 1, 'one person with two appointments was blocked');
      assert.strictEqual(out.cancelled, true);
    } finally { h.restore(); }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
