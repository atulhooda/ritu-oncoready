#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// NO MACHINE SENTINEL MAY SURVIVE INTO WHAT THE PATIENT RECEIVES.
//
// cleanResponse() strips BOOK_APPOINTMENT and UPDATE_APPOINTMENT but was never
// taught CANCEL_APPOINTMENT — neither in the regex list nor in the line filter.
// So when the model emits a cancel sentinel whose JSON does not parse,
// extractSentinel returns null, the cancel block is skipped, and the raw
// sentinel is handed back as the reply text.
//
// On VOICE this was survivable-but-bad: the TTS reads the JSON aloud as noise.
// On WHATSAPP the patient literally reads
//     CANCEL_APPOINTMENT:{"patientName":"Sid","doctor":""}
// which is the product looking broken at the exact moment someone is trying to
// cancel a medical appointment.
//
// This asserts the GENERAL rule rather than the one bug: no line of anything
// cleanResponse returns may look like a machine sentinel. A future sentinel
// added to the prompt and forgotten here fails this test on the day it ships,
// which is the only reason a test like this is worth having.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { cleanResponse } = require('../brain');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// Anything of the shape UPPER_SNAKE: at the start of a line is machine syntax.
const SENTINEL_TOKEN = /^[A-Z][A-Z_]{3,}:/m;

const SENTINELS = [
  ['BOOK_APPOINTMENT', '{"patientName":"Sid","doctor":"Dr. A","dateTime":"2026-08-02T10:00:00"}'],
  ['UPDATE_APPOINTMENT', '{"patientName":"Sid","doctor":"Dr. A","newDateTime":"2026-08-02T10:00:00"}'],
  ['CANCEL_APPOINTMENT', '{"patientName":"Sid","doctor":""}'],
];

for (const [name, payload] of SENTINELS) {
  check(`${name} is stripped (well-formed)`, () => {
    const out = cleanResponse(`ठीक है जी, कर दिया.\n${name}:${payload}`);
    assert.ok(!out.includes(name), `"${name}" survived into: ${JSON.stringify(out)}`);
    assert.ok(!SENTINEL_TOKEN.test(out), `a sentinel-shaped line survived: ${JSON.stringify(out)}`);
    assert.ok(out.includes('ठीक है जी'), 'the human sentence was destroyed along with the sentinel');
  });

  // The failure that actually reaches patients: the model emits the token with
  // JSON the parser rejects, so the execution path skips it AND the stripper
  // must still remove it. A greedy {...} regex alone does not cover this.
  check(`${name} is stripped (malformed payload)`, () => {
    const out = cleanResponse(`ठीक है जी.\n${name}:{"patientName":"Sid",`);
    assert.ok(!out.includes(name), `"${name}" survived into: ${JSON.stringify(out)}`);
  });
}

check('a bare sentinel with no payload does not survive', () => {
  const out = cleanResponse('ठीक है जी.\nCANCEL_APPOINTMENT:');
  assert.ok(!out.includes('CANCEL_APPOINTMENT'), `survived: ${JSON.stringify(out)}`);
});

// ── the check must be able to fail ───────────────────────────────────────────
check('MUTATION: the detector fires on an unstripped sentinel', () => {
  assert.ok(SENTINEL_TOKEN.test('ठीक है\nCANCEL_APPOINTMENT:{"a":1}'),
    'the sentinel-shaped-line detector does not fire on an obvious sentinel — it proves nothing');
  assert.ok(!SENTINEL_TOKEN.test('ठीक है जी, कल 10 बजे बुक कर दी है.'),
    'the detector fires on ordinary text — it would pass vacuously');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
