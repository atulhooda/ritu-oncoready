#!/usr/bin/env node
'use strict';
// A CALLBACK REQUEST WITHOUT A REASON IS STILL A CALLBACK.
// brain-lean built the tool call with `cb.reason || reason || null` and `reason`
// was never declared: every reason-less REQUEST_CALLBACK threw ReferenceError,
// no callbacks row, no staff alert, "could not be registered" spoken. Since
// 79f2677 (2026-08-11). Driven through processLeanRaw with the tool stubbed.
// Run: node tests/test-callback-no-reason-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
(async () => {
  console.log('\nCALLBACK WITHOUT A REASON — driven\n');
  const db = require('../db.js'); db.pool.query = async () => ({ rows: [], rowCount: 0 });
  const tool = require('../tools/requestCallback');
  const brain = require('../brain-lean.js');
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr. Suhas Kalshetty', specialty: 'Cardiology', is_on_call: true, windows: [], taken: [] }] });
  const calls = [];
  tool.execute = async (args) => { calls.push(args); return { success: true, callback_id: 'cb-1', specialty: 'Cardiology', eta_text: 'today' }; };
  const ctx = { clinicId: 'c1', callSid: 'CA-1', callerPhone: '+91 98765 43210', patientName: 'Reena', languageCode: 'gu-IN', patientTextAll: 'x', driftReasked: false };
  const r1 = await brain.processLeanRaw('REQUEST_CALLBACK:{"patientName":"Reena","specialty":"Cardiology"}', ctx);
  ok('no reason at all → the tool is called with reason null and the callback is arranged', () => {
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].reason, null); assert.strictEqual(r1.callbackRequested, true);
  });
  const r2 = await brain.processLeanRaw('REQUEST_CALLBACK:{"patientName":"Reena","specialty":"Cardiology","reason":""}', ctx);
  ok('an empty reason behaves the same', () => { assert.strictEqual(calls.length, 2); assert.strictEqual(calls[1].reason, null); assert.strictEqual(r2.callbackRequested, true); });
  const r3 = await brain.processLeanRaw('REQUEST_CALLBACK:{"patientName":"Reena","specialty":"Cardiology","reason":"chest pain since morning"}', ctx);
  ok('a given reason is passed through', () => { assert.strictEqual(calls[2].reason, 'chest pain since morning'); assert.strictEqual(r3.callbackRequested, true); });
  console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
})();
