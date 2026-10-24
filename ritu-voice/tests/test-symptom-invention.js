#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// RITU INVENTED A COMPLAINT, SPOKE IT AS FACT, AND IT BECAME THE RECORD.
//
// Live call b2045aa9 (2026-08-25). The caller asked whether a doctor was in and
// until when, then for a doctor who does not exist. He named no symptom in the
// entire call. Ritu: "पेट दर्द की परेशानी है तो डॉ. दिव्या साने आज शाम 5:00 से
// 7:30 बजे तक उपलब्ध हैं।" — and booked a gastroenterologist with reason
// "पेट दर्द". symptomGuard caught it; it ran once, at call end, into diagnostics.
//
// The gate that now runs on the reply path is NARROWER than that audit, on
// purpose. Measured over 748 real Ritu turns, the audit flags 10 — eight are
// roster descriptions ("हड्डी के डॉक्टर हैं") that assert nothing about the
// caller. The gate looks only for a complaint attributed TO THE CALLER
// ("X की परेशानी है", "आपको X है", "you have X"): 24 turns carry such a frame,
// exactly one is unsupported, and it is that call.
//
// Run:            node tests/test-symptom-invention.js
// Prove it fails: MUTANT=MUT-AUDIT-ONLY    node tests/test-symptom-invention.js
//                 MUTANT=MUT-RECORD-ANYWAY node tests/test-symptom-invention.js
// ═══════════════════════════════════════════════════════════════════════════
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);
console.log('\nSYMPTOM INVENTION — the narrow gate, and the record\n');

// brain-lean destructures these at require time: patch BEFORE loading it.
const guard = require('../symptomGuard.js');
if (MUTANT === 'MUT-AUDIT-ONLY') guard.unsupportedAttributions = () => [];
if (MUTANT === 'MUT-RECORD-ANYWAY') guard.reasonSupported = () => true;
const brain = require('../brain-lean.js');
const bookTool = require('../tools/bookAppointment');
const db = require('../db.js');
const realQuery = db.pool.query; db.pool.query = async () => ({ rows: [] });
brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'डॉ. दिव्या साने', specialty: 'Gastroenterologist', windows: [], taken: [] }] });

const LIVE_PATIENT = 'सध्या डॉक्टर उपलब्ध आहेत का आत्ता क्लिनिकमध्ये? किती वाजेपर्यंत असतील? डॉक्टर उपरे से मिलने का है मुझे।';
const LIVE_REPLY = 'माफ़ कीजिए, डॉक्टर उपरे यहाँ नहीं हैं। पेट दर्द की परेशानी है तो डॉ. दिव्या साने आज शाम 5:00 से 7:30 बजे तक उपलब्ध हैं। उनके पास बुक करूँ?';
const ctx = (extra) => ({ languageCode: 'hi-IN', clinicId: 'c1', callerPhone: '+919999999999', patientName: 'सिद्धार्थ', driftReasked: false, ...extra });

(async () => {
  // ── [1] the live call, replayed ─────────────────────────────────────────
  const r1 = await brain.processLeanRaw(LIVE_REPLY, ctx({ patientTextAll: LIVE_PATIENT }));
  await ok('the invented complaint is not spoken — Ritu asks what the trouble is instead', async () => {
    assert.strictEqual(r1.canned, true, `spoke the model's text: ${r1.text}`);
    assert.doesNotMatch(r1.text, /पेट दर्द/, `still asserts stomach pain: ${r1.text}`);
    assert.match(r1.text, /किस तकलीफ़/, `not the re-ask line: ${r1.text}`);
    assert.ok(r1.symptomDrift && r1.symptomDrift.length, 'the result does not report the drift for the call to record');
  });
  await ok('the same reply is spoken when the caller DID say it', async () => {
    const r = await brain.processLeanRaw(LIVE_REPLY, ctx({ patientTextAll: 'मुझे पेट में दर्द है दो दिन से' }));
    assert.notStrictEqual(r.canned, true, `a supported complaint was suppressed: ${r.text}`);
    assert.match(r.text, /पेट दर्द/);
  });
  await ok('second drift in the same call: the clause is STRIPPED, not re-asked (no loop)', async () => {
    const r = await brain.processLeanRaw(LIVE_REPLY, ctx({ patientTextAll: LIVE_PATIENT, driftReasked: true }));
    assert.doesNotMatch(r.text, /पेट दर्द/, `the invented clause survived: ${r.text}`);
    assert.match(r.text, /डॉक्टर उपरे यहाँ नहीं हैं/, `the true clause was lost too: ${r.text}`);
    assert.doesNotMatch(r.text, /किस तकलीफ़/, 're-asked a second time — this is the loop');
  });

  // ── [2] what must pass — the eight roster lines the audit flagged, and an echo ──
  for (const t of ['डॉ. संजय Wagh (Orthopedic Surgeon) जी हैं।', 'डॉ. संजय Wagh जी, हड्डी के डॉक्टर हैं।', 'जी नहीं, वो हड्डी के सर्जन हैं।',
    'डॉ. संजय वाघ जी orthopedic surgeon हैं, आज दोपहर 12:30 बजे तक मिल सकते हैं।', 'समझ गई जी, पेट दर्द। ये तकलीफ़ आपको कब से है?', 'कौन सी तकलीफ़ है जी?']) {
    await ok(`passes: "${t.slice(0, 50)}"`, async () => {
      const r = await brain.processLeanRaw(t, ctx({ patientTextAll: 'मुझे appointment chahiye' }));
      assert.notStrictEqual(r.canned, true, `gated a legitimate line: ${r.text}`);
    });
  }

  // ── [3] THE RECORD: an unsupported reason is not written ────────────────
  const realExec = bookTool.execute; let seen = null;
  bookTool.execute = async (args) => { seen = args; return { success: true, appointment_id: 'A', action: 'booked', appointment_time: new Date('2026-09-03T10:00:00+05:30'), doctor_name: 'डॉ. दिव्या साने' }; };
  const BOOK = (reason) => `हो गया जी!\nBOOK_APPOINTMENT:{"doctor":"डॉ. दिव्या साने","patientName":"सिद्धार्थ","reason":"${reason}","dateTime":"2026-09-03T10:00:00+05:30"}`;
  await brain.processLeanRaw(BOOK('पेट दर्द'), ctx({ patientTextAll: LIVE_PATIENT }));
  await ok('reason "पेट दर्द" with no such complaint from the caller → written as NULL', async () => {
    assert.ok(seen, 'the booking tool was not called'); assert.strictEqual(seen.reason, null, `reason written: ${JSON.stringify(seen.reason)}`);
  });
  seen = null; await brain.processLeanRaw(BOOK('पेट दर्द'), ctx({ patientTextAll: 'मुझे पेट में दर्द है' }));
  await ok('the same reason, when the caller said it → kept', async () => assert.strictEqual(seen.reason, 'पेट दर्द'));
  seen = null; await brain.processLeanRaw(BOOK('routine checkup'), ctx({ patientTextAll: LIVE_PATIENT }));
  await ok('a non-clinical reason ("routine checkup") has nothing to contradict → kept', async () => assert.strictEqual(seen.reason, 'routine checkup'));
  await ok('and the booking itself still happened (the record is honest, not empty)', async () => assert.ok(seen && seen.doctor_id === 'd1'));
  bookTool.execute = realExec;

  // ── [4] the streamed path hands off before the first yield ──────────────
  const llm = require('../llm'); const realStream = llm.streamWithFailover;
  let script = []; llm.streamWithFailover = async function* () { for (const c of script) yield { content: c }; yield { done: true }; };
  delete require.cache[require.resolve('../brain-lean.js')];
  if (MUTANT === 'MUT-AUDIT-ONLY') guard.unsupportedAttributions = () => [];
  const brain2 = require('../brain-lean.js');
  script = ['पेट दर्द की परेशानी', ' है तो डॉ. दिव्या साने आज उपलब्ध हैं।', ' बुक करूँ?'];
  const out = []; for await (const y of brain2.getLeanResponseStream([{ role: 'user', content: 'x' }], ctx({ patientTextAll: LIVE_PATIENT }))) out.push(y);
  await ok('streamed: the assertion triggers a handoff before any sentence is spoken', async () => {
    assert.strictEqual(out[0] && out[0].kind, 'fallback-required', `first yield: ${JSON.stringify(out[0])}`);
    assert.strictEqual(out[0].reason, 'symptom_drift');
  });
  llm.streamWithFailover = realStream; db.pool.query = realQuery;

  // ── [5] the call wires the once-per-call flag everywhere ────────────────
  await ok('callHandler passes driftReasked from all seven builders and sets it at all three sites', async () => {
    const src = require('fs').readFileSync('callHandler.js', 'utf8');
    assert.strictEqual((src.match(/driftReasked: this\._driftReasked,/g) || []).length, 7);
    assert.strictEqual((src.match(/if \(result\.symptomDrift && result\.symptomDrift\.length\) this\._driftReasked = true;/g) || []).length, 3, 'a result-consumption site does not record the re-ask');
  });

  // ─── [6] THE GUARD SEES EVERY SCRIPT, AND THE RETURN IS VETTED LIKE THE ROW ──
  // The frames covered hi/mr/en and the mapping saw only Devanagari/Latin, so a
  // Gujarati clinic (Skin Essence, gu-IN) had an invention guard that could not
  // fire; and a Marathi caller's true complaint was refused as invented when the
  // model wrote it in Hindi (पोट→Gastro vs पेट→Internal Medicine). The booked
  // path's RETURNED reason (→ calls.reason, the Sheet) was never vetted at all.
  console.log('\n[6] Gujarati frames; cross-script reasons; the returned reason is the vetted one');
  await ok('Gujarati attribution with no support is caught', async () => {
    const u = guard.unsupportedAttributions('મને ખંજવાળ છે', 'તમને પેટમાં દુખાવો છે તો ડૉક્ટર ને બતાવીએ?');
    assert.ok(u.length > 0, 'guard blind to Gujarati');
  });
  await ok('Gujarati attribution the patient DID say is not flagged', async () => {
    const u = guard.unsupportedAttributions('મને પેટમાં દુખાવો છે', 'તમને પેટમાં દુખાવો છે તો ડૉક્ટર ને બતાવીએ?');
    assert.deepStrictEqual(u, []);
  });
  await ok('a Marathi complaint supports the same complaint written in Hindi', async () =>
    assert.strictEqual(guard.reasonSupported('पोटात दुखतंय दोन दिवसांपासून', 'पेट दर्द'), true));
  await ok('...and Kannada supports it too', async () =>
    assert.strictEqual(guard.reasonSupported('ಹೊಟ್ಟೆ ನೋವು ಇದೆ', 'पेट दर्द'), true));
  await ok('an invented complaint is still refused', async () =>
    assert.strictEqual(guard.reasonSupported('मुझे खुजली है', 'पेट दर्द'), false));
  {
    const realExec = bookTool.execute;
    bookTool.execute = async () => ({ success: true, appointment_id: 'A6', action: 'booked', appointment_time: new Date('2026-09-03T10:00:00+05:30'), doctor_name: 'डॉ. दिव्या साने' });
    const BOOK = (reason) => `हो गया जी!\nBOOK_APPOINTMENT:{"doctor":"डॉ. दिव्या साने","patientName":"सिद्धार्थ","reason":"${reason}","dateTime":"2026-09-03T10:00:00+05:30"}`;
    const invented = await brain.processLeanRaw(BOOK('पेट दर्द'), ctx({ patientTextAll: 'मुझे खुजली है दो दिन से' }));
    await ok('booked-path RETURN carries no invented reason (calls.reason, Sheet)', async () => { assert.strictEqual(invented.booked, true); assert.strictEqual(invented.reason, null); });
    const real = await brain.processLeanRaw(BOOK('पेट दर्द'), ctx({ patientTextAll: 'मुझे पेट में दर्द है' }));
    await ok('booked-path RETURN keeps a supported reason', async () => assert.strictEqual(real.reason, 'पेट दर्द'));
    bookTool.execute = realExec;
  }

// ─── [7] the FAILURE branches return the vetted reason too ─────────────────
console.log('\n[7] unknown-doctor branch: the returned reason is vetted');
{
  const BOOK_UNKNOWN = (reason) => `हो गया जी!\nBOOK_APPOINTMENT:{"doctor":"डॉ. कोई नहीं","patientName":"सिद्धार्थ","reason":"${reason}","dateTime":"2026-09-03T10:00:00+05:30"}`;
  const r = await brain.processLeanRaw(BOOK_UNKNOWN('पेट दर्द'), ctx({ patientTextAll: 'मुझे खुजली है' }));
  await ok('unknown doctor + invented reason → reason null on the return', async () => { assert.strictEqual(r.booked, false); assert.strictEqual(r.reason, null); });
  const r2 = await brain.processLeanRaw(BOOK_UNKNOWN('पेट दर्द'), ctx({ patientTextAll: 'मुझे पेट में दर्द है' }));
  await ok('unknown doctor + supported reason → reason kept', async () => assert.strictEqual(r2.reason, 'पेट दर्द'));
}

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
