#!/usr/bin/env node
// ─── A CALLBACK PROMISED AND NEVER RECORDED ─────────────────────────────────
// brain-lean.js:389 instructs the model, for an on-call specialist:
//
//     on-call doctor → book mat kar, "कॉलबैक लगा देती हूँ" bol
//     ("don't book — say 'I'll arrange a callback'")
//
// and brain-lean.js:218 marks every on-call doctor in the roster with
// "book mat kar, callback lagao". So Ritu is told to promise a callback.
//
// VERIFIED IN PRODUCTION, 2026-08-11:
//     active on-call doctors ......... 11  (of 25 — nearly half the roster)
//     rows in the callbacks table ..... 0
//
// The parts all exist. `callbacks` has been in the schema since migration 001.
// tools/requestCallback.js is written and registered in tools/index.js as
// `request_callback`. But that registry is the TOOL-CALLING brain's, and
// production runs CLINIC_MODE=lean — brain-lean.js drives on SENTINELS
// (BOOK_APPOINTMENT, CANCEL_APPOINTMENT, UPDATE_APPOINTMENT) and has no
// CALLBACK sentinel at all. grep for a caller of requestCallback outside
// tools/index.js returns nothing.
//
// So the promise is reachable and the recording is not. A patient asks for a
// neurologist, hears "मैं कॉलबैक लगा देती हूँ", hangs up satisfied, and no
// human will ever see that they called. Nothing errors. Nothing logs. The
// clinic cannot even discover it happened.
//
// This is the same failure shape as the booking sentinel the prompt warns about
// in capitals at brain-lean.js:382 — "jab tak USI turn mein CANCEL_APPOINTMENT
// emit nahi kiya, 'कैंसिल कर दिया' KABHI mat bol" — a spoken promise with no
// committed row behind it. Booking got verified-then-speak; callbacks never did.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nCALLBACK — a promise Ritu makes must leave a row behind\n');

(async () => {
  const lean = require('../brain-lean.js');

  await ok('the lean prompt still promises a callback for on-call doctors', () => {
    // If this ever stops being true the rest of the file is moot — but so is
    // the bug, and someone should notice deliberately rather than by silence.
    const p = lean.buildSystemPrompt({ rosterSlice: { sliced: false, text: '', count: 0, total: 0 } });
    assert(/callback|कॉलबैक/i.test(p), 'the callback promise vanished from the prompt');
  });

  await ok('THE GAP: the lean brain can EMIT a callback sentinel', () => {
    // Without a sentinel there is no path from the promise to the table, no
    // matter what the tool registry contains.
    const p = lean.buildSystemPrompt({ rosterSlice: { sliced: false, text: '', count: 0, total: 0 } });
    // The DECLARATION, not a mention. REQUEST_CALLBACK appears twice — in the
    // on-call rule and in the sentinel list — and the first version of this
    // test matched either, so deleting the declaration left it green. The model
    // copies the shape from the list; a rule that names a sentinel the list
    // never declares is a rule it cannot follow.
    assert(/^REQUEST_CALLBACK:\{.*specialty.*\}\s*$/m.test(p),
      'REQUEST_CALLBACK is not DECLARED in the sentinel list with its argument shape — ' +
      'the prompt tells Ritu to promise a callback but never shows her how to record one');
    // and the rule must demand it, or the model will promise without emitting
    assert(/on-call doctor[^\n]*REQUEST_CALLBACK/.test(p),
      'the on-call rule no longer requires the sentinel alongside the promise');
  });

  await ok('processLeanRaw acts on REQUEST_CALLBACK and reports it', async () => {
    const db = require('../db.js');
    const real = db.pool.query.bind(db.pool);
    const seen = [];
    db.pool.query = async (sql, params) => {
      seen.push({ sql: String(sql).replace(/\s+/g, ' ').slice(0, 60), params });
      if (/INSERT INTO callbacks/i.test(sql)) return { rows: [{ id: 'cb-1' }], rowCount: 1 };
      if (/FROM doctors/i.test(sql)) return { rows: [{ id: 'doc-1', name: 'Dr. TBD', specialty: 'Neurologist', is_on_call: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    try {
      const out = await lean.processLeanRaw(
        'ठीक है जी, मैं कॉलबैक लगा देती हूँ.\nREQUEST_CALLBACK:{"patientName":"सिद्धार्थ","specialty":"Neurologist","reason":"सिर दर्द"}',
        { clinicId: 'clinic-1', callerPhone: '+919876543210', languageCode: 'hi-IN' }
      );
      assert(out && out.callbackRequested,
        `the sentinel was emitted and nothing acted on it: ${JSON.stringify(out && Object.keys(out))}`);
      assert(seen.some((q) => /INSERT INTO callbacks/i.test(q.sql)),
        `no row was written to callbacks: ${JSON.stringify(seen.map((q) => q.sql))}`);
    } finally { db.pool.query = real; }
  });

  await ok('a callback the DB refuses is NOT spoken as arranged', async () => {
    // Verified-then-speak, the same rule booking already follows. A promise the
    // database rejected must not reach the patient as a confirmation.
    const db = require('../db.js');
    const real = db.pool.query.bind(db.pool);
    db.pool.query = async (sql) => {
      if (/INSERT INTO callbacks/i.test(sql)) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    };
    try {
      const out = await lean.processLeanRaw(
        'ठीक है जी, मैं कॉलबैक लगा देती हूँ.\nREQUEST_CALLBACK:{"patientName":"सिद्धार्थ","specialty":"Neurologist","reason":"चक्कर आना"}',
        { clinicId: 'clinic-1', callerPhone: '+919876543210', languageCode: 'hi-IN' }
      );
      // (with a reason, so the failure below is the DATABASE's — a reason-less
      // sentinel used to fail earlier on an undeclared identifier and passed this
      // test for the wrong reason; see test-callback-no-reason-driven.js)
      assert(!out.callbackRequested, 'a failed insert was reported as a successful callback');
      assert(!/कॉलबैक लगा दी|arranged/i.test(out.text || ''),
        `told the patient the callback was arranged after the write failed: ${out.text}`);
    } finally { db.pool.query = real; }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
