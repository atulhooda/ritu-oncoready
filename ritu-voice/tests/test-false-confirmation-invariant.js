// ═══════════════════════════════════════════════════════════════════════════
// tests/test-false-confirmation-invariant.js
//
// S7 "verified-then-speak", tested at the PATH level instead of the text level.
//
// The existing S7 adapter (ritu-evals/suite/adapters/verified-then-speak.js)
// replays (spoken_line, db_committed) pairs against a COPY of the claimsBooked
// regex. That can only ever prove the regex is right — it can never catch a
// spoken confirmation that never reached the regex. Live call
// d487e311cde2c3705304658dbcb71a7r (2026-07-27) was exactly that: the
// BOOK_APPOINTMENT branch of processLeanRaw returns before the guard, and on an
// idempotent tool hit it returned the model's verbatim "हो गया … बुक कर दी है"
// with booked:false — so the patient heard a confirmation while the call record,
// the WhatsApp trigger (crm.js:19) and calls.outcome (db.js:261) all said
// "not booked".
//
// THE INVARIANT (both directions — this is the whole point):
//   For every result leaving processLeanRaw,
//     claimsBooked.test(result.text)  ⟺  the call now holds a committed row
//                                        (result.booked === true, with
//                                         result.booking.appointment_id),
//                                        or context.appointmentBooked was
//                                        already true (licensed reaffirmation).
//   → left-to-right stops a FALSE confirmation reaching the patient.
//   → right-to-left stops a TRUE confirmation being reported as booked:false,
//     which is what silently suppressed the WhatsApp and the CRM row.
//
// Run: node tests/test-false-confirmation-invariant.js
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const path = require('path');
const REPO = path.resolve(__dirname, '..');

const CLINIC = '11111111-1111-1111-1111-111111111111';
const DOCTOR = '22222222-2222-2222-2222-222222222222';
const PHONE = '+919876543210';

// The exact line Ritu spoke on the live call.
const SPOKEN = 'हो गया जी! डॉ. मनोज देव के साथ आज शाम 5:00 की अपॉइंटमेंट बुक कर दी है। और कुछ मदद चाहिए जी?';

function makeSentinel(iso) {
  return SPOKEN + '\n' +
    `BOOK_APPOINTMENT:{"doctor":"Dr. Manoj Dev","patientName":"Test Patient","reason":"checkup","dateTime":"${iso}"}`;
}

async function run() {
  const brain = require(path.join(REPO, 'brain-lean'));
  const { claimsBooked } = require(path.join(REPO, 'confirmGuards'));
  const bookTool = require(path.join(REPO, 'tools', 'bookAppointment'));

  brain._setRosterForTest({
    text: '',
    doctors: [{ id: DOCTOR, name: 'Dr. Manoj Dev', specialty: 'General Physician', active: true, is_on_call: false, schedules: [] }]
  });

  // Stub the tool at the module boundary: this test is about what brain-lean does
  // with the tool's ANSWER, not about SQL. (tests/test-tool-bookAppointment.js
  // owns the tool's own contract.)
  const realExecute = bookTool.execute;
  let toolAnswer = null;
  bookTool.execute = async () => {
    if (typeof toolAnswer === 'function') return toolAnswer();
    return toolAnswer;
  };

  const when = new Date(Date.now() + 2 * 3600 * 1000);
  when.setMinutes(0, 0, 0);
  const ISO = when.toISOString();
  const CTX = { clinicId: CLINIC, callerPhone: PHONE, patientName: 'Test Patient', languageCode: 'hi-IN' };

  const CASES = [
    {
      name: 'sentinel + fresh INSERT → speaks the confirmation AND reports booked',
      raw: makeSentinel(ISO),
      ctx: CTX,
      tool: { success: true, appointment_id: 'appt-new', appointment_time: ISO, doctor_name: 'Dr. Manoj Dev' }
    },
    {
      name: 'sentinel + IDEMPOTENT hit (row already there) → same confirmation, must ALSO report booked',
      raw: makeSentinel(ISO),
      ctx: CTX,
      // exactly what tools/bookAppointment.js returns when the active row for this
      // patient+doctor is already at the requested time (deployed ffe4fe9 and the
      // migration-005 rewrite both return this shape)
      tool: { success: true, appointment_id: 'appt-existing', idempotent: true, appointment_time: ISO, doctor_name: 'Dr. Manoj Dev' }
    },
    {
      name: 'sentinel + RESCHEDULE (row moved) → confirmation licensed, booked',
      raw: makeSentinel(ISO),
      ctx: CTX,
      tool: { success: true, appointment_id: 'appt-moved', action: 'rescheduled', appointment_time: ISO, doctor_name: 'Dr. Manoj Dev' }
    },
    {
      name: 'sentinel + slot unavailable → must NOT speak a confirmation',
      raw: makeSentinel(ISO),
      ctx: CTX,
      tool: { success: false, error_message: 'busy', alternatives: [{ date: '2026-07-28', day_name: 'Tue', suggested_time: '10:00' }] }
    },
    {
      name: 'sentinel + tool THROWS → must NOT speak a confirmation',
      raw: makeSentinel(ISO),
      ctx: CTX,
      tool: () => { throw new Error('connection terminated'); }
    },
    {
      name: 'NO sentinel, nothing booked → must NOT speak a confirmation',
      raw: SPOKEN,
      ctx: CTX,
      tool: null
    }
  ];

  CASES.push({
    name: 'DEFENCE-IN-DEPTH: sentinel + success with NO appointment_id → confirmation must not stand',
    raw: makeSentinel(ISO),
    ctx: CTX,
    tool: { success: true, doctor_name: 'Dr. Manoj Dev' } // no row id = no proof
  });
  CASES.push({
    name: 'LICENSED: no sentinel but the call already holds a row → reaffirmation allowed',
    raw: SPOKEN,
    ctx: { ...CTX, appointmentBooked: true },
    tool: null
  });

  let failures = 0;
  for (const c of CASES) {
    toolAnswer = c.tool;
    const r = await brain.processLeanRaw(c.raw, c.ctx);

    // NO `!r.canned` EXEMPTION. It used to read
    //
    //     const claims = !r.canned && claimsBooked.test(r.text || '');
    //
    // justified as "canned lines are audited constants, not model output — the
    // guard polices the MODEL". That reasoning is wrong: a patient told their
    // appointment is confirmed when no row exists is harmed identically whether
    // the sentence came from the model or from a constant. The exemption made
    // every canned line a blind spot in the guard that matters most.
    //
    // PROVEN 2026-08-13. Mutate brain-lean so a THROWN booking returns
    // cannedLine('confirmBooking') instead of cannedLine('bookingError') — a
    // patient hearing "अपॉइंटमेंट पक्की कर दी है" after the insert raised — and
    // the old file printed:
    //
    //     PASS  sentinel + tool THROWS → must NOT speak a confirmation
    //     ALL PASS — invariant: a spoken booking claim ⟺ a committed row
    //
    // Removing the exemption costs nothing: all 8 cases still pass against
    // unmutated code, including the three where a canned confirmation is
    // legitimately spoken, because those carry a committed row and are licensed
    // by `mayClaim`. The exemption was buying blindness and nothing else.
    const claims = claimsBooked.test(r.text || '');
    const committed = !!(r.booking && r.booking.success && r.booking.appointment_id);

    const mayClaim = committed || !!c.ctx.appointmentBooked;
    const speaksUnbacked = claims && !mayClaim;          // patient told a lie
    const rowNotReported = committed && r.booked !== true; // truth not recorded → no WhatsApp, outcome=inquiry_only

    const ok = !speaksUnbacked && !rowNotReported;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`        model-text-claims-booking=${claims}  committed-row=${committed}  result.booked=${r.booked}  appointment_id=${(r.booking && r.booking.appointment_id) || null}`);
    if (speaksUnbacked) console.log(`        ✗ SPOKE AN UNBACKED CONFIRMATION: ${r.text}`);
    if (rowNotReported) console.log(`        ✗ ROW COMMITTED BUT REPORTED booked=${r.booked} → no WhatsApp (crm.js:19), calls.outcome='inquiry_only' (db.js:261)`);
  }

  bookTool.execute = realExecute;
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — invariant: a spoken booking claim ⟺ a committed row`);
  return failures;
}

module.exports = { run };

if (require.main === module) {
  run().then(f => process.exit(f ? 1 : 0)).catch(e => { console.error(e); process.exit(2); });
}
