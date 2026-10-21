#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// "हो गया जी!" WITH NO ROW BEHIND IT — TWICE IN 30 DAYS.
//
// Calls 34f1c281 (2026-08-25) and f98508df (2026-08-26): Ritu offers a slot,
// the caller says yes, Ritu says "हो गया जी!", and the appointments table on
// that handset holds nothing. The patient will arrive for an appointment that
// does not exist.
//
// The mechanism had two halves, and both are fixed here:
//
//  1. TWO DETECTORS FOR ONE QUESTION. The non-streamed guard (claimsBooked)
//     matches a bare "हो गया". The streamed guard was a separate, deliberately
//     looser regex that needed a booking noun within 28 characters — and the
//     prompt's own rule 5 tells the model to open a booking claim with exactly
//     "हो गया जी!". Production streams. Sentence one is yielded before the
//     sentinel at the end can be seen, so the loose guard was the only thing
//     that could stop it, and it was written not to. Measured over 30 days of
//     real turns: 748 Ritu turns, 6 in the gap between the two guards, all 6
//     right after an offer — 4 real bookings, 2 false — and ZERO innocent
//     "हो गया" turns, which is the case the looseness existed to protect.
//     The streamed guard is now DERIVED from the non-streamed ones.
//
//  2. A WORD LIST FOR "YES". The pre-route sent confirm turns to the verified
//     path by matching the caller's words against a list that had करते/करतो/करो
//     but not करता, ठीक but not चल. Both callers used the missing forms. It now
//     also keys on Ritu's OWN last sentence being an offer question.
//
// This file drives the REAL getLeanResponseStream with the model stubbed —
// the guard's position relative to the yield is the whole property, and a
// regex test alone cannot see position.
//
// Run:            node tests/test-streamed-false-confirmation.js
// Prove it fails: MUTANT=MUT-LOOSE-STREAMED-GUARD node tests/test-streamed-false-confirmation.js
//                 MUTANT=MUT-NO-OFFER-CONTEXT     node tests/test-streamed-false-confirmation.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;
if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

console.log('\nSTREAMED FALSE CONFIRMATION — one guard, and the offer-context pre-route\n');

// The pre-2026-08-29 streamed regex, kept ONLY so the mutant can restore it.
const OLD_STREAMED = /(अपॉइंटमेंट|अपॉइंटमेण्ट|appointment|बुक|\bbook|भेट|कैंसि?ल|cancel|रद्द|ಬುಕ್|ಅಪಾಯಿಂಟ್|ರದ್ದು|புக்|அப்பாயின்ட்|ரத்து|బుక్|అపాయింట్|రద్దు|বুক|অ্যাপয়েন্ট|বাতিল|બુક|એપોઇન્ટ|રદ|ബുക്ക്|അപ്പോയിന്റ്|റദ്ദ|ବୁକ୍|ଆପଏଣ୍ଟ|ਬੁੱਕ|ਅਪਾਇੰਟ)[^]{0,28}(हो गय|हो गई|कर दी|कर दिया|पक्क(?![ाी]? ?कर(?: ?द)?[ूें])|निश्चित|केली|booked|confirmed|cancell?ed|scheduled|reserved|\bdone\b|ಮಾಡಿದ|ಆಗಿದೆ|ಆಯಿತು|ಖಚಿತ|செய்த|முடிந்த|பதிவு|చేశ|చేసా|అయింది|ఖరారు|করেছি|নিশ্চিত|કરી દીધ|પાકી|ചെയ്ത|ഉറപ്പിച്ച|କରିଦେ|ਕਰ ਦਿੱਤ)|(हो गय|कर दी|कर दिया|booked|confirmed|cancell?ed|scheduled|ಮಾಡಿದ|ಆಗಿದೆ|செய்த|చేశ)[^]{0,25}(अपॉइंटमेंट|appointment|बुक|\bbook|ಬುಕ್|புக்|బుక్)|you'?re\s+(all\s+set|booked)|(whatsapp|व्हाट्स|डिटेल|details?|confirmation|कन्फर्मेशन|message|मैसेज|link|लिंक)[^]{0,20}(भेज द(?!ू|ें)|\bsent\b)|(भेज द(?!ू|ें)|\bsent\b)[^]{0,20}(whatsapp|व्हाट्स|डिटेल|details?|confirmation|message|मैसेज)/i;

// ORDER IS LOAD-BEARING. brain-lean destructures both streamWithFailover and
// STREAMED_FALSE_CONFIRM at require time, so the stub and the mutant must land
// on the modules BEFORE brain-lean is loaded — the same lesson the scheduler
// test paid for by reaching the real Meta endpoint.
const guards = require('../confirmGuards.js');
if (MUTANT === 'MUT-LOOSE-STREAMED-GUARD') guards.STREAMED_FALSE_CONFIRM = OLD_STREAMED;
const llm = require('../llm');
let script = [];
llm.streamWithFailover = async function* () {
  for (const part of script) yield { content: part, provider: 'stub', model: 'stub' };
  yield { done: true, usage: null };
};
const lean = require('../brain-lean.js');

async function run(parts) {
  script = parts;
  const out = [];
  for await (const y of lean.getLeanResponseStream([{ role: 'user', content: 'हाँ जी' }], { languageCode: 'hi-IN' })) out.push(y);
  return out;
}
const firstKind = (out) => (out[0] && out[0].kind) || '(nothing)';
const sentenceBeforeFallback = (out) => {
  const fb = out.findIndex((y) => y.kind === 'fallback-required');
  return out.slice(0, fb < 0 ? out.length : fb).some((y) => y.kind === 'sentence');
};

(async () => {
  // ── [1] THE TWO LIVE CALLS, REPLAYED THROUGH THE REAL STREAM ─────────────
  await ok('a bare "हो गया जी!" as sentence one is handed off, never yielded', async () => {
    const out = await run(['हो गया', ' जी!', ' डॉ. मनोज Deo जी के साथ कल शाम 5:00 बजे।']);
    assert.strictEqual(firstKind(out), 'fallback-required', `first yield was ${firstKind(out)} — the sentence reached TTS`);
    assert.strictEqual(out[0].reason, 'false_confirmation_no_sentinel');
    assert.strictEqual(sentenceBeforeFallback(out), false, 'a sentence was yielded before the handoff — audio on the wire, cannot be taken back');
  });
  await ok('a done-word with a time but no booking noun is still a claim', async () => {
    const out = await run(['हो गया जी!', ' कल सुबह 10:00 बजे आ जाइए।']);
    assert.strictEqual(firstKind(out), 'fallback-required', `first yield was ${firstKind(out)}`);
  });
  await ok('English: "I\'ve booked you in" no longer streams (was pinned as acceptable)', async () => {
    const out = await run(["I've booked", ' you in with Dr. Sharma.']);
    assert.strictEqual(firstKind(out), 'fallback-required', `first yield was ${firstKind(out)}`);
  });

  // ── [2] VERIFIED-THEN-SPEAK ON THE STREAMED PATH ─────────────────────────
  await ok('a REAL booking (sentinel at the end) still never speaks sentence one first', async () => {
    const out = await run(['हो गया जी!', ' डॉ. मनोज देव के साथ बुक कर दिया है.',
      '\nBOOK_APPOINTMENT:{"doctor":"Dr. Manoj Deo","patientName":"X","reason":"Y","dateTime":"2026-09-01T10:00:00+05:30"}']);
    assert.strictEqual(firstKind(out), 'fallback-required', `first yield was ${firstKind(out)}`);
    assert.strictEqual(sentenceBeforeFallback(out), false,
      'the confirmation was spoken BEFORE the non-streamed path could write the row — if that write fails, the claim is false');
  });

  // ── [3] NO NEEDLESS FALLBACK — the case the looseness claimed to protect ──
  await ok('an ordinary turn streams sentence by sentence with no handoff', async () => {
    const out = await run(['जी सतीश जी।', ' डॉक्टर कल सुबह उपलब्ध हैं।']);
    assert.ok(out.some((y) => y.kind === 'sentence'), 'nothing was streamed');
    assert.ok(!out.some((y) => y.kind === 'fallback-required'), 'an innocent turn fell back');
  });
  await ok('"समझ गई" and "ठीक है जी" are not claims', async () => {
    const out = await run(['समझ गई जी।', ' ठीक है, कौन सा दिन ठीक रहेगा?']);
    assert.ok(!out.some((y) => y.kind === 'fallback-required'), 'a non-claim fell back');
  });

  // ── [4] ONE DEFINITION — the streamed guard cannot disagree with the others ──
  const unified = (t) => guards.claimsBooked.test(t) || guards.claimsCancelled.test(t) || guards.claimsSent.test(t);
  const INLINE = ['हो गया जी!', 'हो गया जी! कल सुबह 10:00 बजे आ जाइए।', "I've booked you in with Dr. Sharma.",
    'I have scheduled your visit for 5 pm.', 'डॉक्टर के साथ आपका समय पक्का कर दिया है।', 'ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ರದ್ದಾಗಿದೆ.',
    'जी सतीश जी, डॉक्टर कल सुबह उपलब्ध हैं।', 'अपॉइंटमेंट बुक कर दूँगी।', 'बुक झाली नाही.'];
  await ok('for every sentence, streamed verdict === non-streamed verdict', async () => {
    for (const t of INLINE) {
      assert.strictEqual(guards.STREAMED_FALSE_CONFIRM.test(t), unified(t), `the two guards disagree on: ${t}`);
    }
  });
  const corpusPath = path.join(__dirname, '..', '..', 'ritu-evals', 'data', 'false-confirm-corpus.json');
  if (fs.existsSync(corpusPath)) {
    const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    await ok(`…and across the frozen corpus (${corpus.items.length} items), matching each pinned verdict`, async () => {
      for (const it of corpus.items) {
        assert.strictEqual(guards.STREAMED_FALSE_CONFIRM.test(it.text), unified(it.text), `guards disagree on ${it.id}: ${it.text}`);
        assert.strictEqual(guards.STREAMED_FALSE_CONFIRM.test(it.text), it.detector_expected.streamed, `corpus pin is stale for ${it.id}: ${it.text}`);
      }
      assert.ok(corpus.items.some((it) => it.text === 'हो गया जी!'), 'the live sentence is not in the corpus — the hole that let it through is still there');
    });
  } else {
    console.log('  ⊘ ritu-evals corpus not present — inline property only');
  }

  // ── [5] THE PRE-ROUTE keys on Ritu's OFFER, not on how the caller says yes ──
  const { CallHandler, lastRituTurnWasOffer } = require('../callHandler.js');
  if (MUTANT === 'MUT-NO-OFFER-CONTEXT') CallHandler.prototype._lastRituTurnWasOffer = () => false;
  const h = () => Object.create(CallHandler.prototype);
  await ok('"हां जी, करता।" after "…बुक करूँ?" takes the verified path (live call 34f1c281)', async () => {
    const x = h(); x._lastRituText = 'डॉक्टर मनोज Deo जी की फीस ₹900 है, कल शाम 5:00 बजे बुक करूँ?';
    assert.strictEqual(x._isBookingLikelyTurn('हां जी, करता।'), true, 'streamed — करता is not in the yes-list, and nothing else caught it');
  });
  await ok('"चल ठीक है।" after "…पक्का कर दूँ?" takes the verified path (live call f98508df)', async () => {
    const x = h(); x._lastRituText = 'कल सुबह 10:00 बजे का समय पक्का कर दूँ?';
    assert.strictEqual(x._isBookingLikelyTurn('चल ठीक है।'), true, 'streamed — चल is not in the yes-list');
  });
  await ok('the offer test is anchored on the LAST sentence, so an old mention does not stick', async () => {
    assert.strictEqual(lastRituTurnWasOffer('अपॉइंटमेंट बुक करूँ? डॉ. देव की फीस ₹900 है।'), false, 'a booking word three sentences back should not count');
    assert.strictEqual(lastRituTurnWasOffer('डॉ. देव की फीस ₹900 है। कल शाम 5:00 बजे बुक करूँ?'), true);
  });
  await ok('a turn with no offer behind it still streams', async () => {
    const x = h(); x._lastRituText = 'डॉ. मनोज देव जी की फीस ₹900 है।';
    assert.strictEqual(x._isBookingLikelyTurn('मुझे कल दिखाना है'), false, 'an ordinary turn lost its streaming');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
})();
