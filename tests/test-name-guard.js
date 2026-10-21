// ─── A NAME IS SOMEBODY'S NAME ───────────────────────────────────────────────
// Fixtures below are not invented. Every "must be rejected" value was READ OUT
// OF patients.name in the production database on 2026-08-05, and every "must be
// accepted" value is a real patient in that same table. A guard for this is only
// worth having if it is calibrated against what the system actually produced.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { isValidPersonName, cleanPersonName } = require('../nameGuard');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nNAME GUARD — calibrated against real production rows\n');

// Observed in patients.name, with counts as of 2026-08-05.
const JUNK_IN_PROD = [
  ['Unknown', 8], ['your name', 2], ['Patient', 2], ['ಅಪರಿಚಿತ', 2],
  ['.', 1], ['Webhook Probe', 1],
];
// Also observed: real people. These must survive.
const REAL_IN_PROD = [
  'सिद्धार्थ', 'Siddharth', 'विक्रांत दुर्गे', 'रुनाल', 'Atul', 'Prithvi',
  'Rahul K', 'Manish', 'Rashi Pujar', 'Arnav Ramteke', 'Pruthvi', 'Jyothi',
  'Hitesh Reddy', 'Gayatri Devi', 'Rakesh Kumar', 'Mohit Panwar', 'gawda',
  'pramodvishvakarma71913', 'KDS Law Partners',
];

ok('every junk value in the production table is rejected', () => {
  for (const [v, n] of JUNK_IN_PROD) {
    assert(!isValidPersonName(v), `"${v}" (${n} rows in prod) was accepted`);
  }
});

ok('every real patient in the production table is accepted', () => {
  for (const v of REAL_IN_PROD) {
    assert(isValidPersonName(v), `"${v}" is a real patient and was REJECTED`);
  }
});

ok('the question, echoed back, in each language Ritu asks it', () => {
  for (const v of ['your name', 'aapka naam', 'आपका नाम', 'तुमचं नाव', 'my name is', 'naam']) {
    assert(!isValidPersonName(v), `"${v}" was accepted`);
  }
});

ok('bare acknowledgements are not names', () => {
  for (const v of ['ji', 'haan', 'जी', 'हाँ', 'ok', 'sir', 'madam']) {
    assert(!isValidPersonName(v), `"${v}" was accepted`);
  }
});

ok('punctuation and digits are not names', () => {
  for (const v of ['.', '..', '---', '123', '  ', '']) {
    assert(!isValidPersonName(v), `${JSON.stringify(v)} was accepted`);
  }
});

ok('cleanPersonName returns null, never a placeholder', () => {
  // This is the whole reason there are 8 rows saying "Unknown": something wrote
  // a placeholder instead of nothing.
  assert.strictEqual(cleanPersonName('Unknown'), null);
  assert.strictEqual(cleanPersonName('your name'), null);
  assert.strictEqual(cleanPersonName(null), null);
  assert.strictEqual(cleanPersonName('  सिद्धार्थ  '), 'सिद्धार्थ');
  assert.strictEqual(cleanPersonName('Rashi   Pujar'), 'Rashi Pujar');
});

ok('degenerate input cannot throw', () => {
  for (const v of [null, undefined, 0, false, {}, [], 42, NaN]) {
    assert.doesNotThrow(() => isValidPersonName(v));
  }
});

// ── the reason this file exists at all ──────────────────────────────────────
ok('the LEAN brain — the one production runs — actually calls the guard', () => {
  const lean = fs.readFileSync(path.join(__dirname, '..', 'brain-lean.js'), 'utf8');
  assert(/cleanPersonName\(/.test(lean),
    'brain-lean.js does not call cleanPersonName — the guard is in a path production does not take, which is exactly the bug this fixes');
});

ok('the WhatsApp path calls the same guard', () => {
  const wa = fs.readFileSync(path.join(__dirname, '..', 'whatsappChannel.js'), 'utf8');
  assert(/cleanPersonName\(/.test(wa), 'whatsappChannel.js does not call cleanPersonName');
  assert(!/!== 'Unknown'/.test(wa), 'whatsappChannel.js still has its own partial name check');
});

ok('MUTATION: an empty reject-list would fail this file', () => {
  const { NOT_A_NAME } = require('../nameGuard');
  assert(NOT_A_NAME.has('your name'), 'reject-list lost its most-observed entry');
  assert(NOT_A_NAME.size > 40, 'reject-list is suspiciously small');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
