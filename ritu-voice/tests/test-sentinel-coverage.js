#!/usr/bin/env node
// ─── A PATIENT HEARD A SENTINEL READ ALOUD ──────────────────────────────────
// LIVE CALL c791e4114d5658031b7b6bbdf3f81a8b, 2026-08-11 09:54:50 IST.
// Recorded verbatim in calls.transcript as a Ritu turn:
//
//   REQUEST_CALLBACK:{"patientName":"Siddharth","specialty":"Oncologist",
//                     "reason":"Cancer consultation"}
//
// Spoken. In Marathi TTS. The next Ritu turn is 24 seconds later.
//
// REQUEST_CALLBACK was added to brain-lean.js on 2026-08-10 (79f2677) and to
// nothing else. There were FOUR hand-maintained lists of sentinel names:
//
//   1. brain.js SENTINEL_NAMES ................ what cleanResponse strips
//   2. brain-streaming.js SENTINEL_LINE ....... where spoken output stops
//   3. brain-streaming.js scanForBookingIntent  what forces non-streaming
//   4. brain-lean.js prompt declarations ...... what the MODEL is told to emit
//
// Only #4 was updated. So the streaming path did not recognise it as machine
// text and spoke it, AND did not hand the turn to the non-streaming path, so
// processLeanRaw never ran and no callbacks row was written. Both halves of the
// fix, undone by the copies — the very bug 79f2677 existed to close.
//
// tests/test-callback-recorded.js passed throughout. It drives processLeanRaw
// directly, which is the path production never took for this turn.
//
// THIS TEST DERIVES THE LIST FROM THE PROMPT. Any sentinel the model is taught
// to emit must be strippable and must force a handoff. A future sentinel added
// to brain-lean.js alone fails here instead of on a call.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('AGENT_MAY_CANCEL', 'on', 'the agent-side cancel/reschedule path itself is under test; the staff-only profile is covered by test-cancel-staff-only.js');
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nSENTINEL COVERAGE — what the model is told to emit, no patient may hear\n');

const lean = require('../brain-lean.js');
const { cleanResponse, SENTINEL_NAMES } = require('../brain.js');
const streaming = require('../brain-streaming.js');

// ── derive the truth from the prompt, not from a list we keep by hand ──────
const prompt = lean.buildSystemPrompt({ rosterSlice: { sliced: false, text: '', count: 0, total: 0 } });
const block = prompt.slice(prompt.indexOf('SENTINELS'));
const end = block.indexOf('\n\n');
const declared = [...new Set(
  (end > 0 ? block.slice(0, end) : block)
    .split('\n')
    .map((l) => (l.match(/^([A-Z][A-Z_]{3,}):/) || [])[1])
    .filter(Boolean)
)];

// Sentinels carrying a JSON payload act on the world (a row is written) and so
// must force the non-streaming path. Bare flags (END_CALL:true, PATIENT_NAME:x)
// only annotate the turn and may stream.
const payloadDeclared = declared.filter((n) => new RegExp(`^${n}:\\s*\\{`, 'm').test(block));

console.log(`  prompt declares: ${declared.join(', ')}`);
console.log(`  of those, payload-bearing: ${payloadDeclared.join(', ')}\n`);

ok('the prompt actually declares sentinels (guard against a silent parse)', () => {
  assert(declared.length >= 4, `parsed only ${declared.length} — the SENTINELS block moved and this test is now blind`);
  assert(declared.includes('BOOK_APPOINTMENT'), 'BOOK_APPOINTMENT not parsed; the parser is wrong, not the code');
});

// ── 1. nothing the model is taught to emit may reach the patient ──────────
// Each sentinel is tested in the SHAPE the prompt declares for it: payload
// sentinels get JSON, bare flags get their value. Feeding every name a JSON
// payload would test END_CALL in a form it never takes.
const payloadFor = (name) => payloadDeclared.includes(name)
  ? `{"patientName":"Siddharth","specialty":"Oncologist","reason":"Cancer consultation"}`
  : (name === 'END_CALL' || name === 'EMERGENCY_DETECTED' ? 'true' : 'Siddharth');

for (const name of declared) {
  ok(`${name} is never spoken`, () => {
    const spoken = 'ठीक आहे जी, मी बघते.';
    const out = cleanResponse(`${spoken}\n${name}:${payloadFor(name)}`);
    assert(!out.includes(name),
      `cleanResponse left "${name}" in the spoken text — a patient hears it read aloud, ` +
      `exactly as on call c791e411 (2026-08-11). Add it to brain.js SENTINEL_NAMES.\n      got: ${JSON.stringify(out)}`);
    assert(out.includes('मी बघते'), `the real reply was destroyed along with the sentinel: ${JSON.stringify(out)}`);
  });
}

// ── 1b. the model does not type exactly what the prompt shows ─────────────
// MEASURED 2026-08-11, before the fix: END_CALL and EMERGENCY_DETECTED were
// stripped by /NAME:true/g — case-sensitive, no space — while NAME_CONFIRMED
// and TIME_CONFIRMED used /\s*true/gi. So one extra space spoke the flag, and
// EMERGENCY_DETECTED leaking means machine text at the worst possible moment.
for (const variant of ['END_CALL: true', 'END_CALL:True', 'END_CALL:TRUE',
  'EMERGENCY_DETECTED: true', 'EMERGENCY_DETECTED:True',
  'NAME_CONFIRMED: true', 'TIME_CONFIRMED:TRUE']) {
  ok(`"${variant}" is stripped despite the spacing/case`, () => {
    const out = cleanResponse(`ठीक आहे जी.\n${variant}`);
    assert(!/[A-Z_]{5,}/.test(out),
      `a one-space deviation reaches the patient's ear: ${JSON.stringify(out)}`);
  });
}

// ── 2. a bare / malformed payload must not leak either ────────────────────
ok('a truncated payload still does not reach the patient', () => {
  // The model gets cut off mid-JSON more often than it emits clean sentinels.
  const out = cleanResponse('ठीक आहे.\nREQUEST_CALLBACK:{"patientName":"Sid","specialty":');
  assert(!out.includes('REQUEST_CALLBACK'), `truncated sentinel spoken: ${JSON.stringify(out)}`);
});

// ── 3. anything that WRITES must leave the streaming path ─────────────────
for (const name of payloadDeclared) {
  ok(`${name} forces the non-streaming path`, () => {
    assert(typeof streaming.scanForBookingIntent === 'function',
      'scanForBookingIntent is no longer exported — this test cannot see the handoff decision');
    assert(streaming.scanForBookingIntent(`bol diya.\n${name}:{"patientName":"X"}`),
      `${name} writes to the database but streams. Streaming SPEAKS first and PARSES after, ` +
      `so the promise is made before the row exists — and on call c791e411 the row never existed at all.`);
  });
}

// ── 4. the lists must agree, which is the whole point ────────────────────
ok('every payload sentinel in the prompt is in brain.js SENTINEL_NAMES', () => {
  const missing = payloadDeclared.filter((n) => !SENTINEL_NAMES.includes(n));
  assert.deepStrictEqual(missing, [],
    `declared to the model but absent from the one list: ${missing.join(', ')}. ` +
    `That is the 2026-08-11 bug precisely.`);
});

ok('SENTINEL_NAMES contains nothing the prompt never declares', () => {
  // The reverse drift: a sentinel removed from the prompt but still stripped is
  // harmless, but it means the two have diverged and nobody noticed.
  const orphan = SENTINEL_NAMES.filter((n) => !declared.includes(n));
  assert.deepStrictEqual(orphan, [],
    `stripped but never declared to the model: ${orphan.join(', ')}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
