#!/usr/bin/env node
'use strict';
// The fourth verb. BOOK, CANCEL and SEND claims were guarded; MOVE was not —
// on either twin. An adversarial replay (2026-09-03) drove the REAL streamed
// generator with a compliant UPDATE turn and got SENTENCE("…बदल दी है।"),
// SENTENCE, then fallback-required: the claim was audio on the wire before the
// sentinel arrived — the exact mechanism 6a6ca85 fixed for BOOK. Post-booking,
// where every turn is non-streamed and claimsBooked stands down, "kal karo" →
// "बदल दिया है" with no sentinel at all: the patient was told it moved, nothing
// moved. And a booking turn whose confirmation carried an invented complaint
// was spoken verbatim, because the attribution gate sits below the book block.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-NO-MOVE-STREAMED   — the streamed guard is the old three-verb regex
//   MUTANT=MUT-MOVE-QUIET         — claimsMoved never matches (non-streamed gate gone)
//   MUTANT=MUT-DRIFT-VERBATIM     — the attribution guard finds nothing on a booking turn
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

// ── ORDER IS LOAD-BEARING: brain-lean destructures these at require ──────────
const guards = require('../confirmGuards.js');
const OLD_STREAMED = new RegExp([guards.claimsBooked.source, guards.claimsCancelled.source, guards.claimsSent.source].join('|'), 'i');
if (MUTANT === 'MUT-NO-MOVE-STREAMED') guards.STREAMED_FALSE_CONFIRM = OLD_STREAMED;
if (MUTANT === 'MUT-MOVE-QUIET') guards.claimsMoved = /$^/;
const symptomGuard = require('../symptomGuard.js');
if (MUTANT === 'MUT-DRIFT-VERBATIM') symptomGuard.unsupportedAttributions = () => [];
const llm = require('../llm');
let script = [];
llm.streamWithFailover = async function* () {
  for (const part of script) yield { content: part, provider: 'stub', model: 'stub' };
  yield { done: true, usage: null };
};
const brain = require('../brain-lean.js');
const bookTool = require('../tools/bookAppointment');
const db = require('../db.js');
const config = require('../config.js');
db.pool.query = async () => ({ rows: [] });
brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'डॉ. दिव्या साने', specialty: 'Gastroenterologist', windows: [], taken: [] }] });
const ctx = (extra) => ({ languageCode: 'hi-IN', clinicId: 'c1', callerPhone: '+919999999999', patientName: 'सिद्धार्थ', driftReasked: false, ...extra });

const claims = ['ठीक है जी, कल शाम 5 बजे के लिए बदल दिया है।', 'आपकी अपॉइंटमेंट कल शाम 6 बजे के लिए बदल दी है।', 'शिफ्ट कर दी है जी।',
  'Done, I have moved your appointment to tomorrow 5 pm.', 'I have rescheduled it for Monday.', 'तुमची अपॉइंटमेंट उद्या बदलली आहे.', 'badal di hai ji, kal shaam 5 baje.'];
const quiet = ['क्या मैं आपकी अपॉइंटमेंट बदल दूँ?', 'बदल दीजिए ना', 'आप समय बदलना चाहते हैं?', 'It cannot be moved, sorry.', 'मुझे कल का टाइम बदलना है', 'badal dun kya ji?'];

(async () => {
  console.log('\nMOVE CLAIM TRUTH — the verb every guard forgot\n');

  console.log('[1] the claim regex: statements of a completed move, not questions or requests');
  for (const t of claims) await ok(`claim: "${t.slice(0, 40)}"`, async () => assert.ok(require('../confirmGuards.js').claimsMoved.test(t) || MUTANT === 'MUT-MOVE-QUIET'));
  for (const t of quiet) await ok(`quiet: "${t.slice(0, 40)}"`, async () => assert.ok(!require('../confirmGuards.js').claimsMoved.test(t)));

  console.log('\n[2] streamed: a move claim is handed off BEFORE its first sentence is yielded');
  const run = async (parts, context) => { script = parts; const out = []; for await (const y of brain.getLeanResponseStream([{ role: 'user', content: 'कल शाम 6 बजे कर दो' }], ctx(context))) out.push(y); return out; };
  const firstKind = (out) => (out[0] && out[0].kind) || '(nothing)';
  await ok('compliant UPDATE turn: first yield is fallback-required, no sentence before it', async () => {
    const out = await run(['ठीक है सतीश जी,', ' आपकी अपॉइंटमेंट कल शाम 6 बजे के लिए बदल दी है।', ' और कुछ?\nUPDATE_APPOINTMENT:{"appointmentId":"A","dateTime":"2026-09-04T18:00:00+05:30"}'], { appointmentBooked: true, bookedThisCall: { appointment_id: 'A' } });
    assert.strictEqual(firstKind(out), 'fallback-required', `first yield was ${firstKind(out)} — the claim reached TTS`);
    assert.ok(!out.slice(0, out.findIndex((y) => y.kind === 'fallback-required')).some((y) => y.kind === 'sentence'), 'a sentence was yielded before the handoff');
  });
  await ok('English move claim: same handoff', async () => {
    const out = await run(['Done,', ' I have moved your appointment to tomorrow 5 pm.'], { appointmentBooked: true });
    assert.strictEqual(firstKind(out), 'fallback-required', `first yield was ${firstKind(out)}`);
  });
  await ok('a plain reply with no claim still streams', async () => {
    const out = await run(['जी बिल्कुल,', ' कल शाम 5 बजे का समय खाली है।'], { appointmentBooked: true });
    assert.strictEqual(firstKind(out), 'sentence', `first yield was ${firstKind(out)}`);
  });

  console.log('\n[3] non-streamed, POST-booking: a move claim with no sentinel is replaced, not spoken');
  const expectKey = config.agentMayCancel ? 'confirmMove' : 'cancelPolicy';
  for (const t of claims.slice(0, 4)) {
    await ok(`"${t.slice(0, 36)}" → canned ${expectKey}`, async () => {
      const r = await brain.processLeanRaw(t, ctx({ appointmentBooked: true, bookedThisCall: { appointment_id: 'A' } }));
      assert.strictEqual(r.canned, true, `spoken verbatim: ${r.text}`);
      assert.strictEqual(r.text, brain.cannedLine(expectKey, ctx({})));
      assert.ok(!/बदल दि|moved|rescheduled/i.test(r.text), 'the claim survived into the spoken text');
    });
  }
  await ok('PRE-booking too (the model may claim a move for an appointment it never saw)', async () => {
    const r = await brain.processLeanRaw(claims[0], ctx({ appointmentBooked: false }));
    assert.strictEqual(r.canned, true);
  });
  await ok('a question about moving is NOT replaced', async () => {
    const r = await brain.processLeanRaw(quiet[0], ctx({ appointmentBooked: true }));
    assert.ok(!r.canned, 'replaced'); assert.strictEqual(r.text, quiet[0]);
  });

  console.log('\n[4] a move REQUEST takes the verified (non-streamed) path, where the sentinel is parsed');
  {
    const { CallHandler } = require('../callHandler.js');
    const h = { _lastRituTurnWasOffer: () => false };
    const likely = (t) => CallHandler.prototype._isBookingLikelyTurn.call(h, t);
    for (const t of ['मेरी कल की अपॉइंटमेंट का टाइम बदलना है, शाम 6 बजे', 'shift kar do kal ke liye', 'can we reschedule to Monday?', 'उद्याची वेळ बदलायची आहे', 'ಸಮಯ ಬದಲಾಯಿಸಬಹುದಾ'])
      await ok(`routes non-streamed: "${t.slice(0, 40)}"`, async () => assert.strictEqual(likely(t), true));
    await ok('an ordinary turn still streams', async () => assert.strictEqual(likely('मुझे दो दिन से सिर दर्द है'), false));
  }

  console.log('\n[5] a BOOKING turn whose confirmation invents a complaint is spoken canned, not verbatim');
  {
    const realExec = bookTool.execute;
    bookTool.execute = async () => ({ success: true, appointment_id: 'B5', action: 'booked', appointment_time: new Date('2026-09-03T10:00:00+05:30'), doctor_name: 'डॉ. दिव्या साने' });
    const BOOK = (line) => `${line}\nBOOK_APPOINTMENT:{"doctor":"डॉ. दिव्या साने","patientName":"सिद्धार्थ","reason":"checkup","dateTime":"2026-09-03T10:00:00+05:30"}`;
    const invented = await brain.processLeanRaw(BOOK('आपको पेट दर्द की परेशानी है तो डॉ. दिव्या साने के साथ आज सुबह 10 बजे बुक कर दिया है।'), ctx({ patientTextAll: 'मुझे खुजली है दो दिन से' }));
    await ok('booked, but the spoken confirmation is the canned line', async () => { assert.strictEqual(invented.booked, true); assert.strictEqual(invented.canned, true); assert.ok(!/पेट दर्द/.test(invented.text), `invented complaint spoken: ${invented.text}`); });
    const honest = await brain.processLeanRaw(BOOK('पेट दर्द की परेशानी है तो डॉ. दिव्या साने के साथ आज सुबह 10 बजे बुक कर दिया है।'), ctx({ patientTextAll: 'मुझे पेट में दर्द है' }));
    await ok('a supported complaint keeps the model\'s own confirmation', async () => { assert.strictEqual(honest.booked, true); assert.strictEqual(honest.canned, false); });
    bookTool.execute = realExec;
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
