#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EVERY CALL MUST END WITH A REASON, AND THE RIGHT ONE.
//
// The classifier decides what production teaches us. If it is wrong, every
// number built on it is wrong in a way nobody can see — which is worse than the
// single string it replaces.
//
// Three properties, asserted:
//   1. the distinctions that DON'T exist today actually separate
//   2. the cascade is EXHAUSTIVE — nothing reaches `unclassified`
//   3. it CANNOT THROW, whatever rubbish it is handed. This runs inside
//      endCall(); an exception there would cost more than the insight is worth.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { classifyCall, CASCADE, NOT_A_FAILURE, REASON_LABEL } = require('../callOutcome');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const expect = (snap, reason, outcome) => {
  const got = classifyCall(snap);
  assert.strictEqual(got.reason, reason, `reason: expected ${reason}, got ${got.reason}`);
  if (outcome) assert.strictEqual(got.outcome, outcome, `outcome: expected ${outcome}, got ${got.outcome}`);
};

// ── the distinctions that do not exist today ───────────────────────────────
// All four of these are currently stamped with ONE of two strings.

check('happy question ≠ silence timeout (today both "System hung up")', () => {
  expect({ patientTurns: 4, endTrigger: 'llm_end_call' }, 'just_asking', 'inquiry_only');
  expect({ patientTurns: 4, endTrigger: 'silence_hangup' }, 'went_quiet', 'hangup');
});

check('our redeploy is not blamed on the patient (today "Patient hung up")', () => {
  expect({ patientTurns: 3, endTrigger: 'shutdown' }, 'server_restart', 'failed');
});

check('never spoke ≠ could not hear — opposite fixes', () => {
  expect({ patientTurns: 0, dropped: 0, endTrigger: 'ws_close' }, 'never_spoke', 'hangup');
  expect({ patientTurns: 0, dropped: 5, endTrigger: 'ws_close' }, 'couldnt_hear', 'failed');
});

check('no slot the patient could take ≠ booking machinery broke', () => {
  expect({ patientTurns: 6, bookFailKind: 'slot_unavailable' }, 'no_time_offered', 'inquiry_only');
  expect({ patientTurns: 6, bookFailKind: 'unknown_doctor' }, 'booking_broke', 'failed');
});

// ── ordering: the most dangerous / most specific reading wins ──────────────
check('a booked call is booked even if other flags are set', () => {
  expect({ appointmentBooked: true, endTrigger: 'silence_hangup', criticalErrors: 2 }, 'booked', 'booked');
});

check('emergency outranks every failure reason below it', () => {
  expect({ emergencyDetected: true, patientTurns: 0, dropped: 3, endTrigger: 'ws_close' }, 'emergency', 'emergency');
});

check('a restart outranks emergency — it says nothing about the patient', () => {
  // A shutdown mid-emergency tells us about OUR deploy, not about the caller.
  expect({ endTrigger: 'shutdown', emergencyDetected: true }, 'server_restart', 'failed');
});

check('engaged then dropped', () => {
  expect({ patientTurns: 5, endTrigger: 'ws_close' }, 'hung_up_midway', 'hangup');
  expect({ patientTurns: 5, endTrigger: 'exotel_stop' }, 'hung_up_midway', 'hangup');
});

// ── the real 2026-07-30 calls, as a fixture ────────────────────────────────
check('the six live calls of 2026-07-30 classify as they actually were', () => {
  // Five never got past the greeting — one turn each, caller silent.
  expect({ patientTurns: 0, dropped: 0, endTrigger: 'ws_close' }, 'never_spoke');
  // The Punjabi call: 14 turns, garble re-asks, ended mid-booking-offer.
  expect({ patientTurns: 14, dropped: 2, endTrigger: 'ws_close' }, 'hung_up_midway');
});

// ── exhaustiveness ─────────────────────────────────────────────────────────
check('EXHAUSTIVE — no plausible call reaches `unclassified`', () => {
  const triggers = [null, 'shutdown', 'silence_hangup', 'llm_end_call', 'ws_close', 'exotel_stop'];
  const bookFails = [null, 'slot_unavailable', 'unknown_doctor', 'threw'];
  const unclassified = [];
  for (const endTrigger of triggers) {
    for (const bookFailKind of bookFails) {
      for (const patientTurns of [0, 1, 9]) {
        for (const dropped of [0, 3]) {
          for (const criticalErrors of [0, 1]) {
            for (const emergencyDetected of [false, true]) {
              const snap = { endTrigger, bookFailKind, patientTurns, dropped, criticalErrors, emergencyDetected };
              const r = classifyCall(snap);
              if (r.reason === 'unclassified') unclassified.push(JSON.stringify(snap));
            }
          }
        }
      }
    }
  }
  // 576 combinations. Any hole here is a hole in production's record.
  assert.strictEqual(unclassified.length, 0,
    `${unclassified.length} combination(s) unclassified, e.g. ${unclassified[0]}`);
});

check('every reason in the cascade has a plain-language label', () => {
  for (const [reason] of CASCADE) {
    assert.ok(REASON_LABEL[reason], `no label for "${reason}" — the desk would show a raw enum`);
    assert.ok(REASON_LABEL[reason].hi, `no Hindi label for "${reason}"`);
  }
  assert.ok(REASON_LABEL.unclassified, 'the canary itself needs a label');
});

check('successes are not counted as failures', () => {
  for (const r of ['booked', 'emergency', 'just_asking']) {
    assert.ok(NOT_A_FAILURE.has(r), `${r} must not be reported as a failed call`);
  }
  assert.ok(!NOT_A_FAILURE.has('couldnt_hear'), 'couldnt_hear IS a failure');
});

// ── it must never throw into endCall() ─────────────────────────────────────
check('CANNOT THROW on rubbish input', () => {
  const FIXTURES = [undefined, null, 0, '', 'nonsense', [], NaN,
    { patientTurns: 'many' }, { endTrigger: {} },
    { get appointmentBooked() { throw new Error('boom'); } }];
  for (let i = 0; i < FIXTURES.length; i++) {
    const junk = FIXTURES[i];
    const r = classifyCall(junk);
    // NOTE: do NOT JSON.stringify(junk) here. One fixture is an object with a
    // throwing getter, and stringifying it throws INSIDE the assertion message —
    // which made this test fail while the classifier was behaving perfectly.
    // The error message must be safer than the thing it is testing.
    assert.ok(r && typeof r.outcome === 'string' && typeof r.reason === 'string',
      `bad return for fixture #${i}`);
  }
});

// ── the checks must be able to fail ────────────────────────────────────────
check('MUTATION: the cascade actually discriminates', () => {
  const a = classifyCall({ endTrigger: 'llm_end_call', patientTurns: 3 }).reason;
  const b = classifyCall({ endTrigger: 'silence_hangup', patientTurns: 3 }).reason;
  assert.notStrictEqual(a, b, 'two different endings give the same reason — the classifier is a constant');
  assert.strictEqual(classifyCall({ appointmentBooked: true }).reason, 'booked',
    'a booked call is not recognised — every case above is vacuous');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
