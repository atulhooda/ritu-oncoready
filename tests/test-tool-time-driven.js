#!/usr/bin/env node
'use strict';
// THE TURN RECORD SAYS WHETHER THE MODEL OR THE TOOL WAS SLOW.
// A real Skin Essence call (16 Sep, 3 turns, 4.0 s dead-air, 3.0 s "llm+tool")
// could not be diagnosed because tool time was folded into the model span.
// brain-lean times every tool execution per call; callHandler takes it at the
// turn's first audio. Driven with a stubbed tool that sleeps.
// Run:            node tests/test-tool-time-driven.js
// Prove it fails: MUTANT=MUT-TOOL-TIME-UNTRACKED node tests/test-tool-time-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);
(async () => {
  console.log('\nTOOL TIME PER TURN — driven\n');
  const config = require('../config.js'); const db = require('../db.js');
  const find = require('../tools/findPatientAppointment'); const update = require('../tools/updateAppointment');
  const brain = require('../brain-lean.js');
  if (MUTANT === 'MUT-TOOL-TIME-UNTRACKED') brain.takeTurnToolMs = () => 0; // the old world: no tool share
  config.agentMayReschedule = true; config.agentMayCancel = false;
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr. Daksha Patel', specialty: 'Dermatologist', windows: [], taken: [] }] });
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  find.execute = async () => { await sleep(60); return { appointments: [{ appointment_id: 'a1', appointment_time: '2026-09-20T10:00:00.000Z', doctor_name: 'Dr. Daksha Patel', doctor_id: 'd1', patient_name: 'Reena' }], distinct_patient_names: ['Reena'] }; };
  update.execute = async () => { await sleep(90); return { success: true, action: 'rescheduled', appointment_id: 'a1', doctor_name: 'Dr. Daksha Patel', new_appointment_time: '2026-09-20T12:30:00.000Z' }; };
  const ctx = { clinicId: 'c1', callSid: 'CA-tool-1', callerPhone: '+91 98765 43210', patientName: 'Reena', languageCode: 'gu-IN', patientTextAll: 'x', currentDatetime: '2026-09-18T05:00:00.000Z', driftReasked: false };
  const r = await brain.processLeanRaw('UPDATE_APPOINTMENT:{"dateTime":"2026-09-20T18:00:00+05:30","patientName":"Reena"}', ctx);
  const took = brain.takeTurnToolMs('CA-tool-1');
  ok('the move ran (find + update) and the call accumulated their time', () => { assert.strictEqual(r.rescheduled, true); assert.ok(took >= 140 && took < 2000, `took ${took} ms`); });
  ok('taking resets: a second take is 0; another call id is 0', () => { assert.strictEqual(brain.takeTurnToolMs('CA-tool-1'), 0); assert.strictEqual(brain.takeTurnToolMs('CA-other'), 0); });
  const other = { ...ctx, callSid: 'CA-tool-2' };
  await brain.processLeanRaw('UPDATE_APPOINTMENT:{"dateTime":"2026-09-20T18:00:00+05:30","patientName":"Reena"}', other);
  ok('calls are kept apart by call id', () => { assert.strictEqual(brain.takeTurnToolMs('CA-tool-1'), 0); assert.ok(brain.takeTurnToolMs('CA-tool-2') >= 140); });
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
