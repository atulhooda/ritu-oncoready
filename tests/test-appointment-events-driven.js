#!/usr/bin/env node
'use strict';
// EVERY CHANGE RITU MAKES TO AN APPOINTMENT LANDS IN THE DESK'S ACTION LOG.
//
// appointment_events (migration 019/007) is what the desk's Recent panel,
// Ledger and undo read. updateAppointment (cancel / move) and bookAppointment
// (booked / same-day move) now write there with actor 'ritu' and the channel
// the turn came from. Driven with an in-memory pool; the log write is
// best-effort and must never fail the committed change.
//
// Run:            node tests/test-appointment-events-driven.js
// Prove it fails: MUTANT=MUT-EVENT-NOT-LOGGED node tests/test-appointment-events-driven.js
require('./_bootstrap');
require('./_bootstrap').unpin('AGENT_MAY_CANCEL', 'on', 'the agent-side cancel path itself is under test');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const events = require('../appointmentEvents');
const config = require('../config');
config.agentMayCancel = true; config.agentMayReschedule = true;
if (MUTANT === 'MUT-EVENT-NOT-LOGGED') events.recordAppointmentEvent = async () => null; // the change happens, the desk never hears
const { execute: updateAppointment } = require('../tools/updateAppointment');

function fakePool(appt) {
  const log = [];
  return {
    log,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      log.push({ s, params });
      if (/SELECT a\.id, a\.clinic_id/.test(s)) return { rows: appt ? [appt] : [], rowCount: appt ? 1 : 0 };
      if (/SELECT timezone/i.test(s)) return { rows: [{ timezone: 'Asia/Kolkata' }], rowCount: 1 };
      if (/UPDATE appointments SET status = 'cancelled'/.test(s)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO appointment_events/.test(s)) return { rows: [{ id: 41 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}
const future = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
const APPT = { id: 'a1', clinic_id: 'c1', patient_id: 'p1', doctor_id: 'd1', appointment_time: future, status: 'booked', google_calendar_event_id: null, doctor_name: 'Dr. Daksha Patel', doctor_specialty: 'Dermatology', is_on_call: false };

(async () => {
  console.log('\nAPPOINTMENT EVENTS — driven\n');

  // 1. a cancel on WhatsApp writes one 'cancelled' event, actor ritu, channel whatsapp
  {
    const pool = fakePool({ ...APPT });
    const r = await updateAppointment({ appointment_id: 'a1', cancel: true }, { pool, clinicId: 'c1', patientPhone: '+91 98765 43210', channel: 'whatsapp', callSid: 'wa:conv-7' });
    const ev = pool.log.filter((q) => /INSERT INTO appointment_events/.test(q.s));
    ok('cancel succeeds and one appointment_events row is written', () => { assert.strictEqual(r.success, true); assert.strictEqual(ev.length, 1); });
    ok('the row: cancelled, actor ritu, channel whatsapp, before/after JSON, a note naming the conversation', () => {
      const p = ev[0].params;
      assert.deepStrictEqual(p.slice(0, 4), ['c1', 'a1', 'cancelled', 'ritu']);
      assert.strictEqual(p[5], 'whatsapp');
      assert.strictEqual(JSON.parse(p[7]).status, 'booked');
      assert.deepStrictEqual(JSON.parse(p[8]), { status: 'cancelled' });
      assert.match(String(p[10]), /wa:conv-7/);
    });
    ok('the columns are the desk\'s, in the desk\'s order (check:sync pairs the statements)', () => {
      assert.match(ev[0].s, /\(clinic_id, appointment_id, action, actor, actor_label, channel, call_id, before, after, undo_of, note\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11\) RETURNING id/);
    });
  }

  // 2. a cancel on a call → channel call; the log write failing never fails the cancel
  {
    const pool = fakePool({ ...APPT });
    const real = pool.query;
    pool.query = async (sql, params) => { if (/INSERT INTO appointment_events/.test(String(sql))) { const e = new Error('relation "appointment_events" does not exist'); e.code = '42P01'; throw e; } return real(sql, params); };
    const r = await updateAppointment({ appointment_id: 'a1', cancel: true }, { pool, clinicId: 'c1', patientPhone: '+91 98765 43210' });
    ok('a database without migration 019 still cancels; the log write is best-effort', () => assert.strictEqual(r.success, true));
  }

  // 3. the helper itself: a move row, and a throwing pool returns null instead of throwing
  {
    const seen = [];
    const id = await events.recordAppointmentEvent({ query: async (s, p) => { seen.push(p); return { rows: [{ id: 9 }] }; } },
      { clinicId: 'c1', appointmentId: 'a1', action: 'moved', channel: 'call', before: { appointment_time: 'T1' }, after: { appointment_time: 'T2' } });
    ok('recordAppointmentEvent writes a moved row with before/after and returns its id', () => {
      if (MUTANT === 'MUT-EVENT-NOT-LOGGED') return;
      assert.strictEqual(id, '9'); assert.strictEqual(seen[0][2], 'moved'); assert.strictEqual(JSON.parse(seen[0][7]).appointment_time, 'T1');
    });
    const none = await events.recordAppointmentEvent({ query: async () => { throw new Error('boom'); } }, { clinicId: 'c1', appointmentId: 'a1', action: 'booked' });
    ok('a failing write returns null, never throws', () => assert.strictEqual(none, null));
    ok('channelOf / noteOf', () => {
      assert.strictEqual(events.channelOf({ channel: 'whatsapp' }), 'whatsapp'); assert.strictEqual(events.channelOf({}), 'call'); assert.strictEqual(events.channelOf(undefined), 'call');
      assert.strictEqual(events.noteOf({ callSid: 'CA123' }), 'via CA123'); assert.strictEqual(events.noteOf({}), null);
    });
  }

  // 4. the split refusal at layer 3
  {
    config.agentMayReschedule = false; config.agentMayCancel = true;
    const pool = fakePool({ ...APPT });
    const mv = await updateAppointment({ appointment_id: 'a1', new_datetime: future }, { pool, clinicId: 'c1', patientPhone: '+91 98765 43210' });
    const cn = await updateAppointment({ appointment_id: 'a1', cancel: true }, { pool, clinicId: 'c1', patientPhone: '+91 98765 43210' });
    ok('reschedule OFF, cancel ON: the tool refuses the move and allows the cancel', () => {
      assert.strictEqual(mv.success, false); assert.strictEqual(mv.fail_kind, 'staff_only');
      assert.strictEqual(cn.success, true);
    });
    config.agentMayReschedule = true; config.agentMayCancel = false;
    const cn2 = await updateAppointment({ appointment_id: 'a1', cancel: true }, { pool: fakePool({ ...APPT }), clinicId: 'c1', patientPhone: '+91 98765 43210' });
    ok('reschedule ON, cancel OFF: the tool refuses the cancel', () => { assert.strictEqual(cn2.success, false); assert.strictEqual(cn2.fail_kind, 'staff_only'); });
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
