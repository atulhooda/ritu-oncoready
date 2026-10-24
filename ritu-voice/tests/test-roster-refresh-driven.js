#!/usr/bin/env node
'use strict';
// A DOCTOR ADDED ON THE DESK IS OFFERED ON THE NEXT CALL, NOT THE NEXT DEPLOY.
//
// Until 2026-09-14 the roster (doctors, schedules, treatments, FAQs, fees) was
// loaded once at boot. brain-lean.refreshRoster re-reads it on a 60 s TTL,
// off the latency path, keeping the last good copy on failure and never
// replacing a roster with an empty one. Driven with db stubs.
//
// Run:            node tests/test-roster-refresh-driven.js
// Prove it fails: MUTANT=MUT-ROSTER-STALE node tests/test-roster-refresh-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.ROSTER_TTL_MS = '60000';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const db = require('../db');
const A = { text: 'Dr. Daksha Patel — Dermatology', doctors: [{ id: 'd1', name: 'Dr. Daksha Patel', specialty: 'Dermatology', fee_inr: 500, is_on_call: false }] };
const B = { text: 'Dr. Daksha Patel — Dermatology\nDr. Jigisha Parekh — Cosmetology', doctors: [...A.doctors, { id: 'd2', name: 'Dr. Jigisha Parekh', specialty: 'Cosmetology', fee_inr: 600, is_on_call: false }] };
const EMPTY = { text: '', doctors: [] };
const answers = [A];
let loads = 0;
const clone = (x) => JSON.parse(JSON.stringify(x));
db.getDoctorsRoster = async () => { loads++; return clone(answers[Math.min(loads - 1, answers.length - 1)]); };
db.getTreatments = async () => ({ text: '', treatments: [] });
db.getClinicFaqs = async () => ({ text: '', faqs: [] });
db.getClinicFeePolicy = async () => null;
db.getTakenSlots = async () => ({});
db.getUpcomingExceptions = async () => [];

const lean = require('../brain-lean');
if (MUTANT === 'MUT-ROSTER-STALE') lean.refreshRoster = async () => false; // the old world: boot once, never again
const names = () => lean._roster().doctors.map((d) => d.name);

(async () => {
  console.log('\nROSTER REFRESH — driven\n');
  await lean.preloadRoster('clinic-1');
  ok('boot: the roster is the first answer', () => assert.deepStrictEqual(names(), ['Dr. Daksha Patel']));

  answers.push(B);
  const before = loads;
  const same = await lean.refreshRoster();
  ok('inside the TTL nothing is re-read', () => { assert.strictEqual(loads, before); assert.strictEqual(same, false); });

  const changed = await lean.refreshRoster({ force: true });
  ok('a doctor added on the desk is in the roster after a refresh', () => {
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(names(), ['Dr. Daksha Patel', 'Dr. Jigisha Parekh']);
  });

  // The change above fires a forced taken-slot refresh (unawaited); let it land
  // before planting a taken list, then refresh with an UNCHANGED roster.
  await new Promise((r) => setTimeout(r, 30));
  lean._roster().doctors[0].taken = ['2026-09-16T12:00:00.000Z'];
  answers.push(B);
  await lean.refreshRoster({ force: true });
  ok('taken slots survive a refresh (carried over by doctor id)', () => assert.deepStrictEqual(lean._roster().doctors[0].taken, ['2026-09-16T12:00:00.000Z']));

  answers.push(EMPTY);
  const emptied = await lean.refreshRoster({ force: true });
  ok('an empty answer never replaces a non-empty roster (a DB error answers empty too)', () => { assert.strictEqual(emptied, false); assert.strictEqual(names().length, 2); });

  db.getDoctorsRoster = async () => { throw new Error('connection reset'); };
  const failed = await lean.refreshRoster({ force: true });
  ok('a failed refresh keeps the last good roster and reports false', () => { assert.strictEqual(failed, false); assert.strictEqual(names().length, 2); });

  ok('the call path and the WhatsApp turn both ask for a refresh (never awaited on the latency path)', () => {
    const fs = require('fs'), path = require('path');
    const ch = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
    const wa = fs.readFileSync(path.join(__dirname, '..', 'whatsappChannel.js'), 'utf8');
    assert.ok(/refreshRoster\(\)\.catch\(\(\) => \{\}\)/.test(ch), 'callHandler start() refreshes the roster');
    assert.ok(/refreshRoster\(\)\.catch\(\(\) => \{\}\)/.test(wa), 'whatsappChannel runTurn refreshes the roster');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
