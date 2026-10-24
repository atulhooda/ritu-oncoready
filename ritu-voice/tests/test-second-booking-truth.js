#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// SINCE MIGRATION 013, "KAL KARO" COULD SILENTLY MAKE A SECOND APPOINTMENT.
//
// Rule 7(a) told the model: re-emit BOOK_APPOINTMENT with the new time and the
// same doctor — "system usi appointment ko MOVE kar dega". That was true while
// uniq_active_patient_doctor allowed one active row per patient per doctor.
// Migration 013 scoped that to the DAY so a course of sittings stops
// overwriting itself — and from that moment a cross-day re-emit is an INSERT.
// The caller who said "actually, tomorrow" hears a confirmation, keeps the
// original appointment too, and its reminder fires. The prompt promised a move
// and the database did something else: two live instructions disagreeing about
// one fact, which is the shape that produced the empty-roster and Hinglish
// contradictions before it.
//
// Three things close it, and all three are driven here against real code:
//   · the prompt tells the truth per clinic mode (UPDATE_APPOINTMENT when the
//     clinic allows Ritu to reschedule; the staff line when it does not);
//   · a second row in a call that already holds one is SAID SO, canned,
//     whatever the model wrote;
//   · a same-call UPDATE targets the row this call booked, not the soonest.
//
// The two behavioural branches were proved both ways by reverting each in the
// source and watching the assertions below go red (recorded in the commit);
// they have no clean runtime seam for a MUTANT flag, and a mutant that patches
// nothing would be worse than none.
//
// Run: node tests/test-second-booking-truth.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('AGENT_MAY_CANCEL', 'on', 'the agent-side cancel/reschedule path itself is under test; the staff-only profile is covered by test-cancel-staff-only.js');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
console.log('\nSECOND BOOKING IN ONE CALL — the prompt, the spoken line, the UPDATE target\n');

const child = (env, code) => {
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, SKIP_BOOT_AUDIO: '1', ...env }, encoding: 'utf8', cwd: process.cwd() });
  const m = out.match(/\{[^{}]*\}(?![\s\S]*\{[^{}]*\})/); if (!m) throw new Error(`no JSON from child: ${out.slice(-200)}`);
  return JSON.parse(m[0]);
};
const RULE = (p) => { const i = p.indexOf('7. RESCHEDULE'); return p.slice(i, i + 1400); };

(async () => {
  // ── [1] THE PROMPT TELLS THE TRUTH, PER CLINIC MODE ──────────────────────
  const on = child({ AGENT_MAY_CANCEL: 'on' }, `const p=require('./brain-lean.js').buildSystemPrompt({},{});const i=p.indexOf('7. RESCHEDULE');process.stdout.write(JSON.stringify({rule:p.slice(i,i+1400)}))`).rule;
  const off = child({ AGENT_MAY_CANCEL: 'off' }, `const p=require('./brain-lean.js').buildSystemPrompt({},{});const i=p.indexOf('7. RESCHEDULE');process.stdout.write(JSON.stringify({rule:p.slice(i,i+1400)}))`).rule;
  await ok('neither mode still promises that a BOOK re-emit will MOVE the appointment', async () => {
    for (const [mode, r] of [['on', on], ['off', off]]) {
      assert.doesNotMatch(r, /usi appointment ko MOVE kar dega/, `${mode}: the pre-013 promise is still in the prompt`);
    }
  });
  await ok('cancel ON: a same-call change is routed through UPDATE_APPOINTMENT, and BOOK re-emit is forbidden', async () => {
    assert.match(on, /UPDATE_APPOINTMENT emit kar naye dateTime/, 'no UPDATE instruction for a same-call change');
    assert.match(on, /BOOK_APPOINTMENT DOBARA mat emit kar/, 'the model is not told a re-emit makes a second appointment');
  });
  await ok('cancel OFF: only a same-day time change re-emits BOOK; a different day goes to staff', async () => {
    assert.match(off, /SIRF USI DIN ka time/, 'same-day scope is not stated');
    assert.match(off, /DOOSRE DIN ko kahe[\s\S]{0,120}clinic staff hi karte hain/, 'a cross-day change is not sent to staff');
    assert.match(off, /do appointments ban jayengi/, 'the consequence of a re-emit is not stated');
    assert.doesNotMatch(off, /UPDATE_APPOINTMENT/, 'a clinic that forbids rescheduling is being taught the sentinel');
  });

  // ── [2] A SECOND ROW IS SAID SO — canned, whatever the model wrote ───────
  const brain = require('../brain-lean.js');
  const bookTool = require('../tools/bookAppointment');
  const db = require('../db.js');
  const realBook = bookTool.execute, realQuery = db.pool.query;
  db.pool.query = async () => ({ rows: [] });
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr. Manoj Deo', specialty: 'Neurologist', windows: [], taken: [] }] });
  const TUE = '2026-09-01T10:00:00+05:30', THU = '2026-09-03T10:00:00+05:30';
  bookTool.execute = async () => ({ success: true, appointment_id: 'B', action: 'booked', appointment_time: new Date(THU), doctor_name: 'Dr. Manoj Deo' });
  const raw = 'हो गया जी! आपकी अपॉइंटमेंट गुरुवार को बदल दी है।\nBOOK_APPOINTMENT:{"doctor":"Dr. Manoj Deo","patientName":"सतीश","reason":"सिर दर्द","dateTime":"' + THU + '"}';
  const ctx = (extra) => ({ languageCode: 'hi-IN', clinicId: 'c1', callerPhone: '+919999999999', patientName: 'सतीश', ...extra });

  const second = await brain.processLeanRaw(raw, ctx({ appointmentBooked: true, bookedThisCall: { appointment_id: 'A', appointment_time: new Date(TUE), doctor_name: 'Dr. Manoj Deo' } }));
  await ok('a second row in a call that already holds one: the caller is told BOTH exist', async () => {
    assert.strictEqual(second.booked, true, 'the booking itself failed');
    assert.strictEqual(second.canned, true, 'the model\'s own "बदल दी" text was spoken instead of the canned truth');
    assert.match(second.text, /एक और अपॉइंटमेंट/, `no "one more appointment": ${second.text}`);
    assert.match(second.text, /पहली अपॉइंटमेंट/, `the first appointment is not mentioned: ${second.text}`);
    assert.doesNotMatch(second.text, /बदल/, `still claims a move: ${second.text}`);
  });
  await ok('…and names both times, so the caller can choose', async () => {
    const t1 = brain.speakableTime(TUE, ctx({})), t2 = brain.speakableTime(THU, ctx({}));
    assert.ok(t1 && t2, 'speakableTime produced nothing');
    assert.ok(second.text.includes(t1), `first time "${t1}" missing from: ${second.text}`);
    assert.ok(second.text.includes(t2), `second time "${t2}" missing from: ${second.text}`);
  });
  const firstOnly = await brain.processLeanRaw(raw, ctx({ appointmentBooked: false, bookedThisCall: null }));
  await ok('a FIRST booking is unchanged (no prior row → the ordinary confirmation)', async () => {
    assert.strictEqual(firstOnly.booked, true);
    assert.doesNotMatch(firstOnly.text, /एक और अपॉइंटमेंट|पहली/, `the second-booking line fired on a first booking: ${firstOnly.text}`);
  });
  bookTool.execute = async () => ({ success: true, appointment_id: 'A', action: 'rescheduled', moved_from: new Date(TUE), appointment_time: new Date(THU), doctor_name: 'Dr. Manoj Deo' });
  const moved = await brain.processLeanRaw(raw, ctx({ appointmentBooked: true, bookedThisCall: { appointment_id: 'A', appointment_time: new Date(TUE) } }));
  await ok('a genuine same-day MOVE of the same row is not called a second appointment', async () => {
    assert.doesNotMatch(moved.text, /एक और अपॉइंटमेंट/, `a move was announced as a second booking: ${moved.text}`);
  });
  bookTool.execute = realBook;

  // ── [3] A SAME-CALL UPDATE TARGETS THE ROW THIS CALL BOOKED ──────────────
  const findTool = require('../tools/findPatientAppointment');
  const updTool = require('../tools/updateAppointment');
  const realFind = findTool.execute, realUpd = updTool.execute;
  findTool.execute = async () => ({ appointments: [
    { appointment_id: 'A', doctor_id: 'd1', doctor_name: 'Dr. Manoj Deo', appointment_time: new Date(TUE) },
    { appointment_id: 'B', doctor_id: 'd1', doctor_name: 'Dr. Manoj Deo', appointment_time: new Date(THU) },
  ] });
  let targeted = null;
  updTool.execute = async (args) => { targeted = args.appointment_id; return { success: true, appointment_time: new Date(THU), doctor_name: 'Dr. Manoj Deo' }; };
  const upd = 'UPDATE_APPOINTMENT:{"dateTime":"2026-09-03T18:00:00+05:30"}';
  await brain.processLeanRaw(upd, ctx({ appointmentBooked: true, bookedThisCall: { appointment_id: 'B', appointment_time: new Date(THU) } }));
  await ok('with a booking made this call, the UPDATE moves THAT row, not the soonest', async () => {
    assert.strictEqual(targeted, 'B', `moved ${targeted} — the soonest upcoming row, which is the other sitting`);
  });
  targeted = null;
  await brain.processLeanRaw(upd, ctx({ appointmentBooked: false, bookedThisCall: null }));
  await ok('with no booking this call, the existing rule holds (soonest upcoming)', async () => {
    assert.strictEqual(targeted, 'A');
  });
  findTool.execute = realFind; updTool.execute = realUpd; db.pool.query = realQuery;

  // ── [4] THE CALL RECORDS ITS FIRST BOOKING AND HANDS IT TO THE BRAIN ─────
  const { CallHandler } = require('../callHandler.js');
  const h = Object.create(CallHandler.prototype); h._bookedThisCall = null; h.doctorName = null;
  h._recordBooking({ booked: true, booking: { appointment_id: 'A', appointment_time: new Date(TUE), doctor_name: 'Dr. Manoj Deo' } });
  h._recordBooking({ booked: true, booking: { appointment_id: 'B', appointment_time: new Date(THU), doctor_name: 'Dr. Manoj Deo' } });
  await ok('the FIRST booking is kept when a second is recorded', async () => {
    assert.strictEqual(h._bookedThisCall.appointment_id, 'A', 'the second booking overwrote the first — the line would name the wrong one');
  });
  await ok('every brain context builder passes bookedThisCall (seven builders, three success sites, one helper)', async () => {
    const src = require('fs').readFileSync('callHandler.js', 'utf8');
    const builders = (src.match(/appointmentBooked: this\.appointmentBooked,/g) || []).length;
    const passed = (src.match(/bookedThisCall: this\._bookedThisCall,/g) || []).length;
    assert.strictEqual(builders, 7, `expected the seven brain-context builders, found ${builders}`);
    assert.strictEqual(passed, 7, `${passed} of ${builders} context builders pass it`);
    const records = (src.match(/this\._recordBooking\(result\);/g) || []).length;
    assert.strictEqual(records, 3, `${records} of the 3 success sites record the booking`);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
