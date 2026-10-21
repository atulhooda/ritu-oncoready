#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A STAFF-ONLY CANCEL/RESCHEDULE REQUEST BECOMES A ROW BEFORE RITU PROMISES A CALL.
//
// At a clinic with AGENT_MAY_CANCEL=off (Skin Essence) Ritu says: "I'll note
// your request, the clinic will call you." Until 2026-09-13 that sentence had
// no row behind it — nothing reached the desk's Needs-you queue. The same
// class as "callback laga deti hoon" without REQUEST_CALLBACK.
//
// Driven through processLeanRaw with the sentinel the model would emit, the
// pool intercepted. MUT-STAFF-ONLY-NO-ROW restores the old shape: the promise
// is spoken with nothing written — the "a row exists" proof must go red.
//
// Run:            node tests/test-staff-request-noted-driven.js
// Prove it fails: MUTANT=MUT-STAFF-ONLY-NO-ROW node tests/test-staff-request-noted-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nSTAFF-ONLY REQUEST → CALLBACK ROW — driven\n');

(async () => {
  const config = require('../config.js');
  const db = require('../db.js');
  const brain = require('../brain-lean.js');
  config.agentMayCancel = false;
  config.agentMayReschedule = false; // a staff-only clinic keeps both (split 2026-09-15)
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr. Daksha Patel', specialty: 'Dermatologist', windows: [], taken: [] }] });

  const inserts = [];
  db.pool.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/INSERT INTO callbacks/i.test(s)) { inserts.push({ sql: s, params }); return { rows: [{ id: `cb-${inserts.length}` }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  if (MUTANT === 'MUT-STAFF-ONLY-NO-ROW') {
    db.logStaffRequest = async () => 'phantom'; // says "noted", writes nothing
    console.log('  [MUTANT] MUT-STAFF-ONLY-NO-ROW — the promise is spoken, no row is written\n');
  }

  const ctx = { clinicId: 'c1', callerPhone: '+91 98765 43210', patientName: 'Reena', languageCode: 'gu-IN',
                patientTextAll: 'મારી કાલની અપૉઇન્ટમેન્ટ સાંજે કરી દો', currentDatetime: new Date().toISOString(), driftReasked: false };

  const moved = await brain.processLeanRaw('UPDATE_APPOINTMENT:{"dateTime":"2026-09-16T18:00:00+05:30","patientName":"Reena"}', ctx);
  ok('reschedule at a staff-only clinic: nothing is moved, the request is noted, the policy line is spoken in Gujarati', () => {
    assert.strictEqual(moved.booked, false);
    assert.strictEqual(moved.cancelled, false);
    assert.strictEqual(moved.canned, true);
    assert.strictEqual(moved.text, brain.cannedLine('cancelPolicy', ctx));
    assert.match(moved.text, /સ્ટાફ/);
  });
  ok('a callbacks row exists with the request kind, the normalized phone and the asked-for time', () => {
    assert.strictEqual(inserts.length, 1, `${inserts.length} insert(s)`);
    const p = inserts[0].params;
    assert.strictEqual(p[0], 'c1');
    assert.strictEqual(p[1], 'Reena');
    assert.strictEqual(p[2], '9876543210');
    assert.strictEqual(p[3], 'Reschedule request');
    assert.match(String(p[4]), /2026-09-16T18:00:00\+05:30/);
  });
  ok('the reply is flagged as a callback so the call outcome reads "callback", not "inquiry"', () => {
    assert.strictEqual(moved.callbackRequested, true);
  });

  const cancelled = await brain.processLeanRaw('CANCEL_APPOINTMENT:{"patientName":"Reena"}', ctx);
  ok('cancel at a staff-only clinic: not cancelled, noted as a Cancel request', () => {
    assert.strictEqual(cancelled.cancelled, false);
    assert.strictEqual(cancelled.text, brain.cannedLine('cancelPolicy', ctx));
    assert.strictEqual(inserts.length, 2, `${inserts.length} insert(s)`);
    assert.strictEqual(inserts[1].params[3], 'Cancel request');
  });

  // The write fails → no promise. (Under the mutant logStaffRequest is stubbed, so this runs the same.)
  db.pool.query = async (sql) => { if (/INSERT INTO callbacks/i.test(String(sql))) throw new Error('db down'); return { rows: [], rowCount: 0 }; };
  const failed = await brain.processLeanRaw('CANCEL_APPOINTMENT:{"patientName":"Reena"}', ctx);
  ok('when the row cannot be written, Ritu does NOT say the clinic will call', () => {
    if (MUTANT === 'MUT-STAFF-ONLY-NO-ROW') return; // the mutant never writes; covered above
    assert.notStrictEqual(failed.text, brain.cannedLine('cancelPolicy', ctx));
    assert.strictEqual(failed.text, brain.cannedLine('callbackError', ctx));
  });

  if (MUTANT && fail === 0) {
    console.log(`\n  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`);
    process.exit(1);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
