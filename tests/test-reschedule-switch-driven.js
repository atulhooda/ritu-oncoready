#!/usr/bin/env node
'use strict';
// A PATIENT MAY MOVE THEIR OWN APPOINTMENT WHILE CANCELLING STAYS WITH STAFF.
//
// Until 2026-09-15 one switch (AGENT_MAY_CANCEL) gated both UPDATE_APPOINTMENT
// and CANCEL_APPOINTMENT, so a clinic that reserved cancellation for its desk
// (Skin Essence) also lost patient-driven rescheduling on calls and WhatsApp.
// config.agentMayReschedule is the second switch. Driven through
// processLeanRaw with the pool intercepted: under (reschedule on, cancel off)
// a move sentinel must reach the appointment lookup, not the staff-request
// row; a cancel sentinel must still become a staff request.
//
// Run:            node tests/test-reschedule-switch-driven.js
// Prove it fails: MUTANT=MUT-SPLIT-IGNORED node tests/test-reschedule-switch-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

(async () => {
  console.log('\nRESCHEDULE SWITCH — driven\n');
  const config = require('../config.js');
  const db = require('../db.js');
  const brain = require('../brain-lean.js');
  config.agentMayCancel = false;
  config.agentMayReschedule = true;
  if (MUTANT === 'MUT-SPLIT-IGNORED') config.agentMayReschedule = config.agentMayCancel; // the old world: one switch
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr. Daksha Patel', specialty: 'Dermatologist', windows: [], taken: [] }] });

  const seen = [];
  const inserts = [];
  db.pool.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');
    seen.push(s);
    if (/INSERT INTO callbacks/i.test(s)) { inserts.push({ sql: s, params }); return { rows: [{ id: `cb-${inserts.length}` }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 }; // no appointments found → the move path ends in "not found", not in a staff request
  };
  const ctx = { clinicId: 'c1', callerPhone: '+91 98765 43210', patientName: 'Reena', languageCode: 'gu-IN',
                patientTextAll: 'મારી કાલની અપૉઇન્ટમેન્ટ સાંજે કરી દો', currentDatetime: new Date().toISOString(), driftReasked: false };

  const moved = await brain.processLeanRaw('UPDATE_APPOINTMENT:{"dateTime":"2026-09-16T18:00:00+05:30","patientName":"Reena"}', ctx);
  ok('reschedule ON, cancel OFF: a move sentinel reaches the appointment lookup — no staff-request row, no policy line', () => {
    assert.strictEqual(inserts.length, 0, `${inserts.length} callback row(s) written`);
    assert.notStrictEqual(moved.text, brain.cannedLine('cancelPolicy', ctx));
    assert.ok(seen.some((s) => /FROM appointments/i.test(s)), 'the patient\'s appointments were looked up');
    assert.notStrictEqual(moved.callbackRequested, true);
  });

  const cancelled = await brain.processLeanRaw('CANCEL_APPOINTMENT:{"patientName":"Reena"}', ctx);
  ok('the same clinic: a cancel sentinel is still a staff request, and the line says CANCEL is staff-only (not "cancel or reschedule")', () => {
    assert.strictEqual(cancelled.cancelled, false);
    assert.strictEqual(cancelled.text, brain.cannedLine('cancelStaffOnly', ctx));
    assert.ok(!/રીશેડ્યૂલ/.test(cancelled.text), 'must not claim rescheduling is staff-only');
    assert.match(cancelled.text, /કેન્સલ/);
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].params[3], 'Cancel request');
  });

  ok('the prompt teaches UPDATE_APPOINTMENT and not CANCEL_APPOINTMENT under this split', () => {
    const p = brain.buildSystemPrompt(ctx);
    const text = typeof p === 'string' ? p : JSON.stringify(p);
    assert.ok(/UPDATE_APPOINTMENT:\{/.test(text), 'UPDATE example present');
    assert.ok(!/CANCEL_APPOINTMENT:\{/.test(text), 'CANCEL example absent');
  });

  ok('config: unset AGENT_MAY_RESCHEDULE follows AGENT_MAY_CANCEL; on/off override it', () => {
    const rule = config._agentMayRescheduleFrom;
    assert.strictEqual(rule({ AGENT_MAY_CANCEL: 'off' }), false);
    assert.strictEqual(rule({ AGENT_MAY_CANCEL: 'off', AGENT_MAY_RESCHEDULE: 'on' }), true);
    assert.strictEqual(rule({ AGENT_MAY_CANCEL: 'on', AGENT_MAY_RESCHEDULE: 'off' }), false);
    assert.strictEqual(rule({ AGENT_MAY_CANCEL: 'on' }), true);
    assert.strictEqual(rule({}), true);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
