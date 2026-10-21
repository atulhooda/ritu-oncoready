#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A TEST CALL IS STAMPED AS ONE, SO IT NEVER BECOMES A CLINIC NUMBER.
//
// The ten scripted Gujarati test calls will be the first rows on the clinic's
// desk. Without a stamp they sit in "why calls didn't book" forever, and every
// later demo call joins them. config.testCallerPhones (TEST_CALLER_PHONES) is
// the list of OUR numbers; db.logCallToDb writes calls.is_test = TRUE for them
// (migration 019). Both sides go through normalizePhone, so the env can be
// written "+91 98765 43210" and the caller ID can arrive as "09876543210".
//
// Driven: logCallToDb runs against an intercepted pool; the INSERT's parameter
// list is inspected. MUT-ISTEST-LIST-IGNORED empties the list the stamp reads
// from — the "listed number is stamped" proof must go red.
//
// Run:            node tests/test-call-is-test-driven.js
// Prove it fails: MUTANT=MUT-ISTEST-LIST-IGNORED node tests/test-call-is-test-driven.js
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

console.log('\nCALL LOG — is_test stamp, driven\n');

(async () => {
  const config = require('../config.js');
  const db = require('../db.js');

  // The list, as a human would type it into Railway.
  config.testCallerPhones = MUTANT === 'MUT-ISTEST-LIST-IGNORED' ? [] : ['+91 98765 43210', '0 91234 56789'];

  const inserts = [];
  db.pool.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/INSERT INTO calls/i.test(s)) inserts.push({ sql: s, params });
    // Patient resolution gets nothing back; upsertPatient tolerates that and
    // the call row is written with patient_id NULL, which is what matters here.
    return { rows: [], rowCount: 0 };
  };

  const base = { callSid: 'CA-test', durationSeconds: 30, outcome: 'inquiry_only', transcript: [] };
  await db.logCallToDb({ ...base, callSid: 'CA-1', callerPhone: '09876543210' });      // listed (leading 0 form)
  await db.logCallToDb({ ...base, callSid: 'CA-2', callerPhone: '+919123456789' });    // listed (E.164 form)
  await db.logCallToDb({ ...base, callSid: 'CA-3', callerPhone: '9999999999' });       // a real caller
  await db.logCallToDb({ ...base, callSid: 'CA-4', callerPhone: null });               // no caller id at all

  const byId = Object.fromEntries(inserts.map((i) => [i.params[1], i]));

  ok('every call row is written with an is_test column', () => {
    assert.strictEqual(inserts.length, 4, `${inserts.length} INSERT(s)`);
    for (const i of inserts) assert.match(i.sql, /is_test\)/, `is_test missing from: ${i.sql}`);
  });
  ok('a listed number, in a different format, is stamped is_test = true', () => {
    assert.strictEqual(byId['CA-1'].params[13], true, `CA-1 is_test=${byId['CA-1'].params[13]}`);
    assert.strictEqual(byId['CA-2'].params[13], true, `CA-2 is_test=${byId['CA-2'].params[13]}`);
  });
  ok('a real caller is stamped is_test = false', () => {
    assert.strictEqual(byId['CA-3'].params[13], false);
  });
  ok('a call with no caller id is never a test call', () => {
    assert.strictEqual(byId['CA-4'].params[13], false);
  });
  ok('isTestCaller is exported and normalizes both sides', () => {
    assert.strictEqual(db.isTestCaller('98765 43210'), MUTANT ? false : true);
    assert.strictEqual(db.isTestCaller('12345'), false);
  });

  if (MUTANT && fail === 0) {
    console.log(`\n  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`);
    process.exit(1);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
