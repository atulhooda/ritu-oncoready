#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE FALSE-CONFIRMATION INVARIANT, ON THE WHATSAPP PATH.
//
// Voice has held this for months: a stated booking ⟺ a committed row. WhatsApp
// never held it at all. Its old brain returned an ACTION STRING that whatsapp.js
// executed, and then sent the model's message UNCONDITIONALLY — so "ho gaya ji"
// went out whether or not anything happened. Its reschedule branch did nothing
// at all and still replied.
//
// Now WhatsApp runs brain-lean through whatsappChannel.runTurn, and the
// invariant is meant to hold STRUCTURALLY: the adapter never composes a message,
// it forwards result.text, and on every failure path brain-lean has already
// replaced that text with an audited canned line.
//
// This test asserts the property, not the plumbing:
//     claimsBooked(sent body)  ⟺  result.booked && result.booking.appointment_id
//
// THE CASE THAT MATTERS MOST is `existing appointment + claim + no sentinel`.
// brain-lean disables its false-booking guard when context.appointmentBooked is
// true. The natural WhatsApp mapping — "this patient already has an
// appointment" — would switch the guard off PERMANENTLY for exactly the people
// most likely to be told "ho gaya" about a second, uncommitted one. The adapter
// hardcodes it false; this test is what stops someone "fixing" that later.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const path = require('path');
const REPO = path.resolve(__dirname, '..');

const CLINIC = '11111111-1111-1111-1111-111111111111';
const DOCTOR = '22222222-2222-2222-2222-222222222222';
const PHONE = '919876543210';

const CLAIM = 'हो गया जी! डॉ. मनोज देव के साथ आज शाम 5:00 की अपॉइंटमेंट बुक कर दी है।';
const sentinel = (iso) => CLAIM + '\n' +
  `BOOK_APPOINTMENT:{"doctor":"Dr. Manoj Dev","patientName":"Test Patient","reason":"checkup","dateTime":"${iso}"}`;

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

async function run() {
  // ── REQUIRE ORDER IS LOAD-BEARING. DO NOT REARRANGE. ───────────────────────
  // brain-lean.js:21 does `const { completeWithFailover } = require('./llm')`,
  // i.e. it captures the function BY VALUE at its own load time. Patching
  // llm.completeWithFailover after brain-lean is loaded therefore does nothing
  // — brain-lean keeps calling the original, the test quietly makes REAL LLM
  // calls, and every `raw` fixture below is ignored while the assertions still
  // report on whatever the live model happened to say.
  //
  // That is not hypothetical: the first run of this file did exactly that. The
  // tell was `[LLM] provider=gemini …` in the output of a test that must make
  // zero network calls. Same trap as the TTS stub that never took effect
  // (2026-07-30) — a stub applied after the consumer destructured it.
  //
  // So: patch llm FIRST, then require brain-lean.
  const llm = require(path.join(REPO, 'llm'));
  let rawCompletion0 = '';
  let llmCalls = 0;
  llm.completeWithFailover = async () => { llmCalls++; return { content: rawCompletion0 }; };

  const brain = require(path.join(REPO, 'brain-lean'));
  const db = require(path.join(REPO, 'db'));
  const bookTool = require(path.join(REPO, 'tools', 'bookAppointment'));
  const { claimsBooked } = require(path.join(REPO, 'confirmGuards'));

  brain._setRosterForTest({
    text: '',
    doctors: [{
      id: DOCTOR, name: 'Dr. Manoj Dev', specialty: 'General Physician',
      active: true, is_on_call: false, fee_inr: 500, schedules: [],
      windows: [0, 1, 2, 3, 4, 5, 6].map(dow => ({ dow, start: '00:00', end: '23:59' })),
    }],
  });

  // Stub every I/O edge. The point of the test is what the ADAPTER does with the
  // brain's answer, so the brain is real and everything around it is fake.
  let toolAnswer = null;
  bookTool.execute = async () => (typeof toolAnswer === 'function' ? toolAnswer() : toolAnswer);

  db.getConversationHistory = async () => ([{ role: 'user', content: 'शाम 5 बजे बुक कर दो' }]);
  db.pool = { query: async () => ({ rows: [] }) };

  const wa = require(path.join(REPO, 'whatsappChannel'));

  const when = new Date(Date.now() + 2 * 3600 * 1000);
  when.setMinutes(0, 0, 0);
  const ISO = when.toISOString();
  const CONV = { id: 1, language: 'hi-IN' };

  const CASES = [
    {
      name: 'sentinel + committed row → claim allowed, booked true',
      raw: sentinel(ISO),
      tool: { success: true, appointment_id: 'appt-new', appointment_time: ISO, doctor_name: 'Dr. Manoj Dev' },
      expectBooked: true,
    },
    {
      name: 'sentinel + idempotent hit (row already at that time) → still a real booking',
      raw: sentinel(ISO),
      tool: { success: true, appointment_id: 'appt-existing', idempotent: true, appointment_time: ISO, doctor_name: 'Dr. Manoj Dev' },
      expectBooked: true,
    },
    {
      name: 'sentinel + success WITHOUT appointment_id → must not claim',
      raw: sentinel(ISO),
      tool: { success: true, appointment_time: ISO, doctor_name: 'Dr. Manoj Dev' },
      expectBooked: false,
    },
    {
      name: 'sentinel + slot unavailable → must not claim',
      raw: sentinel(ISO),
      tool: { success: false, error_message: 'busy', alternatives: [{ date: '2026-08-03', day_name: 'Mon', suggested_time: '10:00' }] },
      expectBooked: false,
    },
    {
      name: 'sentinel + tool throws → must not claim',
      raw: sentinel(ISO),
      tool: () => { throw new Error('connection terminated'); },
      expectBooked: false,
    },
    {
      name: 'sentinel names an unknown doctor → must not claim',
      raw: CLAIM + '\nBOOK_APPOINTMENT:{"doctor":"Dr. Nobody","patientName":"Test Patient","dateTime":"' + ISO + '"}',
      tool: { success: true, appointment_id: 'appt-x', appointment_time: ISO },
      expectBooked: false,
    },
    {
      name: 'claim with NO sentinel → must not claim',
      raw: CLAIM,
      tool: null,
      expectBooked: false,
    },
    {
      // THE ONE THAT GUARDS THE ADAPTER'S OWN DESIGN DECISION.
      name: 'RETURNING patient (already has an appointment) claims a SECOND booking, no sentinel → must STILL not claim',
      raw: CLAIM,
      tool: null,
      expectBooked: false,
      // simulate the tempting-but-wrong mapping being absent: loadPatientContext
      // finds a patient, but the adapter must not turn that into a licence.
      existingPatient: true,
    },
  ];

  for (const c of CASES) {
    rawCompletion0 = c.raw;
    toolAnswer = c.tool;
    if (c.existingPatient) {
      db.pool = { query: async () => ({ rows: [{ id: 'p1', name: 'Test Patient' }] }) };
    } else {
      db.pool = { query: async () => ({ rows: [] }) };
    }

    const result = await wa.runTurn({ phone: PHONE, conv: CONV, patientName: 'Test Patient' });
    const body = String(result.text || '');
    const claimed = claimsBooked.test(body);
    const committed = !!(result.booked && result.booking && result.booking.appointment_id);

    check(c.name, () => {
      if (claimed !== committed) {
        throw new Error(
          `INVARIANT BROKEN — text claims booked=${claimed}, committed=${committed}\n` +
          `      sent: ${JSON.stringify(body.slice(0, 130))}`);
      }
      if (committed !== c.expectBooked) {
        throw new Error(`expected booked=${c.expectBooked}, got ${committed}`);
      }
      if (/^[A-Z][A-Z_]{3,}:/m.test(body)) {
        throw new Error(`a machine sentinel reached the patient: ${JSON.stringify(body.slice(0, 130))}`);
      }
      if (!body.trim()) throw new Error('empty message would have been sent');
    });
  }

  // ── the check must be able to fail ─────────────────────────────────────────
  check('MUTATION: claimsBooked actually fires on the claim sentence', () => {
    if (!claimsBooked.test(CLAIM)) {
      throw new Error('claimsBooked does not match "बुक कर दी है" — every case above passes vacuously');
    }
    if (claimsBooked.test('कौन से डॉक्टर को दिखाना है जी?')) {
      throw new Error('claimsBooked matches an ordinary question — it would fire everywhere');
    }
  });

  check('MUTATION: language mapping gives Hindi patients Hindi, not Marathi', () => {
    const f = wa.languageFields('hi-IN');
    if (f.languageCode !== null || f.hindiInCall !== true) {
      throw new Error(`hi-IN must map to {languageCode:null, hindiInCall:true}, got ${JSON.stringify(f)}`);
    }
    const k = wa.languageFields('kn-IN');
    if (k.languageCode !== 'kn-IN') throw new Error('kn-IN must pin languageCode');
    const m = wa.languageFields('mr-IN');
    if (m.hindiInCall !== false) throw new Error('mr-IN must not set hindiInCall');
  });

  check('MUTATION: the LLM stub is actually in effect (no network calls)', () => {
    if (llmCalls !== CASES.length) {
      throw new Error(
        `stub was called ${llmCalls} times for ${CASES.length} cases — brain-lean is NOT using it, ` +
        'so every fixture above was ignored and real LLM output was scored instead');
    }
  });

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('harness error:', e); process.exit(1); });
