#!/usr/bin/env node
// ─── THE FEATURE THAT WAS BUILT, SHIPPED, AND NEVER ASKED FOR ───────────────
// reportIntake.js can receive a WhatsApp photo of a lab report or prescription,
// store it, and auto-summarize it for the doctor's pre-visit read. It has been
// able to do that since it was written. Nothing ever asked a patient to send one.
//
// THREE INDEPENDENT BLOCKERS, all three real, found 2026-08-15:
//
//   1. The voice call never mentioned reports. The deterministic history machine
//      has exactly two stages (duration, meds/allergy) and the prompt says
//      "2 sawaal MAX — questionnaire NAHI". No report step existed to disable.
//
//   2. ENABLE_REPORT_INTAKE was off. It gates the intake handler AND the ask.
//
//   3. The WhatsApp invitation that DID exist was unreachable. It is appended to
//      `msg`, which sendTemplateOrText takes as its plainText FALLBACK:
//
//          if (usable) sid = await sendWhatsAppTemplate(...)
//          if (!sid && (!usable || mark.templateDead)) sid = await sendWhatsAppMessage(to, plainText)
//
//      `confirmation` defaults to 'appointment_confirmation', so the name is
//      always truthy; the clinic's template is approved and sends; the fallback
//      never runs. Eleven languages of invitation, never transmitted — the same
//      dead-fallback shape whatsapp.js:106 already documents as a past defect.
//
// THE ASK IS SPOKEN ON THE CALL because a template send does NOT open the 24h
// customer-service window, so free text cannot chase it, and a photo cannot
// travel over voice. The call is the only place the ask is free AND deliverable.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('flips ENABLE_REPORT_INTAKE both ways — the flag itself is under test');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.CLINIC_MODE = 'lean';

const assert = require('assert');
const { cannedLine } = require('../brain-lean.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nREPORT-INTAKE ASK — the request that was never made\n');

// ── 1. THE ASK EXISTS IN EVERY LANGUAGE RITU ANSWERS IN ────────────────────
const LANGS = ['hi-IN', 'mr-IN', 'en-IN', 'kn-IN', 'pa-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'ml-IN', 'od-IN'];

ok('every language has a report ask, and it names WhatsApp', () => {
  for (const lang of LANGS) {
    const line = cannedLine('reportAsk', { languageCode: lang });
    assert(line, `${lang} has no reportAsk line`);
    assert(/WhatsApp/i.test(line),
      `${lang} does not name WhatsApp: "${line}" — a photo cannot travel over voice, so the ` +
      `line MUST tell the patient where to send it`);
  }
});

ok('the ask is a STATEMENT, not a question', () => {
  // It is spoken after the booking is already committed. A question re-opens
  // the conversation and forces the model to handle an answer nothing branches
  // on — which is how a closing line turns into three more turns.
  for (const lang of LANGS) {
    const line = cannedLine('reportAsk', { languageCode: lang });
    assert(!/[?？]/.test(line), `${lang} asks a question: "${line}"`);
  }
});

ok('no language silently falls back to Hindi', () => {
  // cannedLine falls back to hi-IN for a missing key, so a missing Kannada line
  // would be spoken IN HINDI to a Kannada caller and this suite would not
  // notice — the exact failure class that put Bengali text in a Kannada record.
  const hi = cannedLine('reportAsk', { languageCode: 'hi-IN' });
  for (const lang of LANGS.filter((l) => l !== 'hi-IN')) {
    assert.notStrictEqual(cannedLine('reportAsk', { languageCode: lang }), hi,
      `${lang} returned the HINDI line — the key is missing from the table`);
  }
});

// ── 2. THE GATE: ASK ONLY IF WE WOULD ACTUALLY KEEP THE PHOTO ──────────────
// Driven through the real _maybeReportAsk, not a reimplementation of it.
const CallHandler = require('../callHandler.js');

function handler({ flag, booked }) {
  if (flag) process.env.ENABLE_REPORT_INTAKE = 'true';
  else delete process.env.ENABLE_REPORT_INTAKE;
  const h = new CallHandler('report_test', '+919876543210', null, 'exotel');
  h.appointmentBooked = booked;
  return h;
}

ok('FLAG OFF: silent. Asking for a file we would discard is worse than not asking', () => {
  // reportIntake.js:23 returns false and logs "ignored" when the flag is off —
  // the patient photographs their file, sends it, gets nothing back, and
  // concludes the clinic lost it.
  const h = handler({ flag: false, booked: true });
  assert.strictEqual(h._maybeReportAsk(), null);
});

ok('NOT BOOKED YET: silent — reports are a pre-visit thing, and there is no visit', () => {
  const h = handler({ flag: true, booked: false });
  assert.strictEqual(h._maybeReportAsk(), null);
});

ok('BOOKED + FLAG ON: the ask is produced', () => {
  const h = handler({ flag: true, booked: true });
  const line = h._maybeReportAsk();
  assert(line, 'no ask was produced on the one path that should produce it');
  assert(/WhatsApp/i.test(line), `the produced line does not name WhatsApp: "${line}"`);
});

ok('ONCE PER CALL — a booked call has several turns left after booking', () => {
  // Step 6 of the flow asks "और कुछ मदद चाहिए?" and then says goodbye, so this
  // injector is reached again. Repeating it would be the most bot-like thing
  // in the call, at its warmest moment.
  const h = handler({ flag: true, booked: true });
  assert(h._maybeReportAsk(), 'first ask missing');
  assert.strictEqual(h._maybeReportAsk(), null, 'asked twice');
  assert.strictEqual(h._maybeReportAsk(), null, 'asked a third time');
});

ok('NO HANDSET: silent — there is no WhatsApp thread for a photo to land in', () => {
  process.env.ENABLE_REPORT_INTAKE = 'true';
  const h = new CallHandler('report_test_nophone', null, null, 'exotel');
  h.appointmentBooked = true;
  assert.strictEqual(h._maybeReportAsk(), null);
});

// ── 3. THE WHATSAPP COPY IS STILL DEAD, AND THAT IS RECORDED ───────────────
ok('the whatsapp.js invitation is still on the FALLBACK path, and says so', () => {
  // Not a behaviour assertion — a documentation one. The invitation stays (it
  // is correct when a template really is dead), but the next person to read it
  // must not believe patients receive it. If someone moves it onto the template
  // path for real, this test should be deleted along with the warning.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'whatsapp.js'), 'utf8');
  const i = src.indexOf('const REPORT_ASK = {');
  assert(i > 0, 'the REPORT_ASK block is gone — if it moved into the template, delete this test');
  const preamble = src.slice(Math.max(0, i - 1400), i);
  assert(/ONLY SHIPS ON THE FALLBACK PATH/.test(preamble),
    'the REPORT_ASK block no longer carries the warning that it is normally never sent');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
