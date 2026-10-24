#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A MARATHI CALLER STAYS MARATHI — AND CAN COME BACK.
//
// Live call 82a3d38c (2026-08-29, 520s, in front of a client). A Marathi
// speaker: four Marathi turns, then Ritu switched to Hindi and never returned —
// not even when asked "मराठीत बोलू शकता?", to which she said "जी बिल्कुल!" in
// Hindi. Three root causes, each closed here:
//
//   1. The Hindi/Marathi decision was Sarvam's language TAG on two 3-token
//      fragments (its own comment: wrong on 50–80% of those), then the model's
//      own reply, then a patient-side check that flipped TO Hindi and never
//      back. Replayed through the classifier already in the code, the first
//      four patient turns vote Marathi. Now the patient's TEXT decides, every
//      turn, both ways; the tag never sets it; the model's reply never sets it;
//      an explicit request sets it and holds.
//   2. The request detector's verb gate accepted imperatives (बोलो, बोला) and
//      not the polite ability form (बोलू शकता). He asked the politest way.
//   3. The symptom lexicon knew पैर and not पाय: Marathi 7/10, Hindi 10/10 —
//      leg, chest, back missing. A sore leg was booked with a cardiologist.
//
// Run:            node tests/test-marathi-stays-marathi.js
// Prove it fails: MUTANT=MUT-ONE-WAY          node tests/test-marathi-stays-marathi.js
//                 MUTANT=MUT-REQUEST-IGNORED  node tests/test-marathi-stays-marathi.js
//                 MUTANT=MUT-TAG-DECIDES      node tests/test-marathi-stays-marathi.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()'); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;
// MUTANT=MUT-PAIR-NO-FLOOR — pairLanguage flips to Hindi on a single strong token (the pre-2026-09-03 rule);
// patched BEFORE callHandler/whatsapp are required, since both destructure it.
if (MUTANT === 'MUT-PAIR-NO-FLOOR') { const s = require('../sarvam.js'); s.pairLanguage = (t, c) => s.looksLikeHindi(t) ? 'hi-IN' : (s.looksLikeMarathi(t) ? 'mr-IN' : c); }
if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);
console.log('\nMARATHI STAYS MARATHI — the pair follows the patient, both ways\n');

const sarvam = require('../sarvam.js');
let pairLanguage = sarvam.pairLanguage;
if (MUTANT === 'MUT-ONE-WAY') pairLanguage = (t, cur) => (cur === 'hi-IN' ? 'hi-IN' : sarvam.pairLanguage(t, cur));

// The real call's patient turns, in order (calls table, 82a3d38cb1e3f0…).
const CALL = [
  'माझा पाय दुखतोय.', 'Satish.', 'सहा वर्षापासून नाही.', 'मराठीत बोलू शकता?',
  'नहीं, अभी कोई दवाई नहीं चल रही। कौन सी दवा चल रही है अभी?',   // turn 9: accommodating Ritu's Hindi
  'कौन डॉक्टर हैं?', 'त्यांना त्यांच्याशी बोलत असेल तर।',
  'नाही, पण मला पहिले जाणून घ्यायचं आहे की माझा इलाज होईल की नाही.',
];

// ── [1] THE DECISION, replayed on the real call ─────────────────────────
ok('the first four patient turns keep the call Marathi (the tag said Hindi)', () => {
  let cur = 'mr-IN';
  for (const t of CALL.slice(0, 4)) { cur = pairLanguage(t, cur); assert.strictEqual(cur, 'mr-IN', `after "${t}" → ${cur}`); }
});
ok('a Marathi sentence after a Hindi one flips BACK (this is the property one-way lacked)', () => {
  let cur = 'hi-IN';
  cur = pairLanguage(CALL[7], cur);
  assert.strictEqual(cur, 'mr-IN', `"${CALL[7]}" left the call at ${cur}`);
});
ok('the accommodation turn is Hindi-looking, and the next Marathi turn recovers', () => {
  let cur = 'mr-IN';
  for (const t of CALL) cur = pairLanguage(t, cur);
  assert.strictEqual(cur, 'mr-IN', `end of the replay: ${cur}`);
});

// ── [2] A genuine Hindi caller is still recognised — no regression ──────
for (const t of ['मुझे appointment book karwani hai', 'खांसी के लिए अपॉइंटमेंट', 'यार मेरे दांत में दर्द हो रहा था']) {
  ok(`Hindi opener still flips to Hindi: "${t}"`, () => assert.strictEqual(pairLanguage(t, 'mr-IN'), 'hi-IN'));
}
ok('a lone mis-heard "नाही" does NOT flip a Hindi call back (token floor)', () => {
  assert.strictEqual(pairLanguage('नाही', 'hi-IN'), 'hi-IN');
  assert.strictEqual(pairLanguage('नाही जी', 'hi-IN'), 'hi-IN');
});
ok('a lone "हाँ।" does not flip Marathi to Hindi (the pre-existing stay rule)', () => {
  assert.strictEqual(pairLanguage('हाँ।', 'mr-IN'), 'mr-IN');
});
ok('no evidence either way → hold', () => {
  assert.strictEqual(pairLanguage('Satish.', 'mr-IN'), 'mr-IN');
  assert.strictEqual(pairLanguage('Satish.', 'hi-IN'), 'hi-IN');
});

// ── [3] THE HANDLER: tag never decides, text does, a request holds ──────
const { CallHandler } = require('../callHandler.js');
const fresh = () => { const h = Object.create(CallHandler.prototype); h.callSid = 'T'; h.callLanguage = null; h._hindiInCall = false; h._langRequested = null; h._replyVoiceLang = null; h._langPinned = false; h._ended = false; h.stt = { repin: () => {} }; return h; };
if (MUTANT === 'MUT-REQUEST-IGNORED') CallHandler.prototype._updatePairLanguage = function (t) { const b = this._hindiInCall ? 'hi-IN' : 'mr-IN'; const a = sarvam.pairLanguage(t, b); this._hindiInCall = (a === 'hi-IN'); };
if (MUTANT === 'MUT-TAG-DECIDES') { const real = CallHandler.prototype._applyLanguageSwitch; CallHandler.prototype._applyLanguageSwitch = function (code, why) { real.call(this, code, why); if (code === 'hi-IN' || code === 'mr-IN') this._hindiInCall = (code === 'hi-IN'); }; }

ok('the auto-detect tag saying hi-IN does NOT make the reply Hindi', () => {
  const h = fresh(); h._applyLanguageSwitch('hi-IN', 'auto-detect');
  assert.strictEqual(h._hindiInCall, false, 'the tag pinned the reply language — the exact mechanism of call 82a3d38c');
});
ok('the patient\'s Marathi keeps it Marathi through the real call\'s first turns', () => {
  const h = fresh(); for (const t of CALL.slice(0, 4)) h._updatePairLanguage(t);
  assert.strictEqual(h._hindiInCall, false);
});
ok('a Hindi turn flips to Hindi, a Marathi turn flips back', () => {
  const h = fresh(); h._updatePairLanguage(CALL[4]); assert.strictEqual(h._hindiInCall, true);
  h._updatePairLanguage(CALL[7]); assert.strictEqual(h._hindiInCall, false, 'never came back');
});
ok('an explicit request ("Hindi mein bolo") holds against a later Marathi sentence', () => {
  const h = fresh(); h._applyLanguageSwitch('hi-IN', 'patient request');
  assert.strictEqual(h._hindiInCall, true, 'the request did not switch');
  h._updatePairLanguage(CALL[7]);
  assert.strictEqual(h._hindiInCall, true, 'a mixed sentence undid what the caller explicitly asked for');
});
ok('the model answering in Hindi picks the Hindi VOICE for that reply, and does not move the call', () => {
  const h = fresh(); const before = h._currentSpeaker();
  h._replyVoiceLang = 'hi-IN'; const during = h._currentSpeaker(); h._replyVoiceLang = null;
  assert.notStrictEqual(during, before, 'the Hindi reply was spoken in the Marathi voice');
  assert.strictEqual(h._hindiInCall, false, 'a reply-side flip still moves the call');
  assert.strictEqual(h._currentSpeaker(), before);
});

// ── [4] THE REQUEST: the polite form is accepted ─────────────────────────
const h = fresh();
ok('"मराठीत बोलू शकता?" — the live sentence — is recognised as a Marathi request', () => {
  assert.strictEqual(h._detectLanguageRequest('मराठीत बोलू शकता?'), 'mr-IN');
});
for (const [t, code] of [['हिंदी में बोल सकते हो?', 'hi-IN'], ['मराठीत बोलता येईल का?', 'mr-IN'], ['ગુજરાતીમાં બોલી શકો?', 'gu-IN'], ['marathi mein bolo', 'mr-IN']]) {
  ok(`polite/other form → ${code}: "${t}"`, () => assert.strictEqual(h._detectLanguageRequest(t), code));
}
ok('a language name without a speaking verb is not a request', () => {
  assert.strictEqual(h._detectLanguageRequest('मराठी doctor available hai kya'), null);
});

// ── [5] THE LEXICON: Marathi body parts ──────────────────────────────────
const { specialtiesForSymptom } = require('../tools/symptomMapping.js');
const { toDevanagari } = require('../devanagari.js');
const map = (q) => specialtiesForSymptom(q + ' ' + toDevanagari(q));
ok('"माझा पाय दुखतोय" → Orthopedic (it mapped to nothing; a cardiologist got the booking)', () => {
  assert.ok(map('माझा पाय दुखतोय').some((x) => /ortho/i.test(x)), JSON.stringify(map('माझा पाय दुखतोय')));
});
ok('"छातीत दुखतंय" → Cardiology', () => assert.ok(map('छातीत दुखतंय').some((x) => /cardio/i.test(x)), JSON.stringify(map('छातीत दुखतंय'))));
ok('"कंबर दुखते" → Orthopedic', () => assert.ok(map('कंबर दुखते').some((x) => /ortho/i.test(x)), JSON.stringify(map('कंबर दुखते'))));
ok('Marathi now matches the same ten complaints Hindi does', () => {
  const pairs = [['पाय दुखतोय','पैर में दर्द'],['डोकं दुखतंय','सिर में दर्द'],['पोट दुखतंय','पेट में दर्द'],['दात दुखतोय','दांत में दर्द'],['ताप आलाय','बुखार है'],['छातीत दुखतंय','छाती में दर्द'],['खोकला येतोय','खांसी आ रही है'],['डोळे दुखतात','आँख में दर्द'],['कंबर दुखते','कमर में दर्द'],['त्वचेला खाज','त्वचा में खुजली']];
  const mr = pairs.filter(([m]) => map(m).length).length, hi = pairs.filter(([, h]) => map(h).length).length;
  assert.strictEqual(mr, hi, `Marathi ${mr}/10 vs Hindi ${hi}/10`);
});
ok('"कमरे में" (a room) still does not map — the boundary rule survives', () => {
  assert.strictEqual(map('कमरे में बैठा हूँ').length, 0);
});

// ─── the model-side half of the loop ────────────────────────────────────────
// pairLanguage decides from the patient's words, turn by turn, with a Marathi
// veto. The prompt's Marathi branch still told the model "switch on ONE Hindi
// line and then stay there" — so code and prompt disagreed, and a Marathi
// caller's one Hindi word could still flip the model while the canned lines and
// the voice stayed Marathi. Both branches must now state the same rule.
console.log('\n[prompt] the two branches of the LANGUAGE rule mirror the code');
{
  const { buildSystemPrompt } = require('../brain-lean.js');
  const mr = buildSystemPrompt({}, {});
  const hi = buildSystemPrompt({ hindiInCall: true }, {});
  ok('Marathi branch names the language and forbids the flip', () => { assert.match(mr, /Patient MARATHI mein baat kar raha hai/); assert.match(mr, /Marathi mat chhod/); });
  ok('Marathi branch follows the patient TURN BY TURN, on a FULL line', () => { assert.match(mr, /turn-by-turn/); assert.match(mr, /POORI line/); });
  ok('the old "one Hindi line and stay" instruction is gone', () => assert.doesNotMatch(mr, /ek line bhi/));
  ok('Hindi branch is the mirror image', () => { assert.match(hi, /Patient HINDI mein baat kar raha hai/); assert.match(hi, /Marathi mat bol/); });
}
console.log('\n[reportAsk] the canned line reads the real field, not an undefined twin');
{
  // cannedLine is destructured by callHandler at require: patch BEFORE a fresh require.
  const leanPath = require.resolve('../brain-lean.js');
  const realLean = require.cache[leanPath].exports;
  let seen = null;
  require.cache[leanPath].exports = { ...realLean, cannedLine: (key, opts) => { if (key === 'reportAsk') seen = opts; return 'रिपोर्ट भेजिए'; } };
  // runtimeConfig is destructured by callHandler at require too — and may
  // snapshot env at ITS require — so patch the module the consumer reads.
  const rcPath = require.resolve('../runtimeConfig.js');
  const realRc = require.cache[rcPath] ? require.cache[rcPath].exports : require(rcPath);
  require.cache[rcPath].exports = { ...realRc, runtimeConfig: () => ({ ...realRc.runtimeConfig(), reportIntake: true }) };
  delete require.cache[require.resolve('../callHandler.js')];
  const { CallHandler: CH2 } = require('../callHandler.js');
  const h = Object.create(CH2.prototype);
  Object.assign(h, { callSid: 'sid-ra', callerPhone: '+918273500806', appointmentBooked: true, _reportAskSpoken: false,
    _hindiInCall: true, callLanguage: null, _langCode: () => 'hi-IN', speak: async () => {}, transcript: [] });
  try { h._maybeReportAsk(); } catch (_) { /* only the cannedLine call is under test */ }
  ok('reportAsk receives hindiInCall from _hindiInCall (was this.hindiInCall → undefined)', () => { assert.ok(seen, 'cannedLine(reportAsk) never called'); assert.strictEqual(seen.hindiInCall, true); });
  require.cache[leanPath].exports = realLean;
  require.cache[rcPath].exports = realRc;
  delete require.cache[require.resolve('../callHandler.js')];
}

// ─── ONE reply-language resolver ────────────────────────────────────────────
// cannedLine, speakableTime and localizeSpoken each resolved the language on
// their own; localizeSpoken read languageCode alone, which is null on every
// Hindi/Marathi call, so spoken dates were localised for the wrong language.
console.log('\n[resolver] canned lines and the date localiser agree on the language');
{
  const lean = require('../brain-lean.js');
  ok('exported',                          () => assert.strictEqual(typeof lean.replyLanguage, 'function'));
  ok('pair: hindiInCall → hi-IN',         () => assert.strictEqual(lean.replyLanguage({ hindiInCall: true }), 'hi-IN'));
  ok('pair: default → mr-IN',             () => assert.strictEqual(lean.replyLanguage({}), 'mr-IN'));
  ok('pinned language wins',              () => assert.strictEqual(lean.replyLanguage({ languageCode: 'kn-IN', hindiInCall: true }), 'kn-IN'));
  const t = 'आपकी अपॉइंटमेंट 2026-09-04 17:30 पर है।';
  ok('localizeSpoken on a Hindi call == localizeSpoken pinned hi-IN (twins agree)', () =>
    assert.strictEqual(lean.localizeSpoken(t, { hindiInCall: true }), lean.localizeSpoken(t, { languageCode: 'hi-IN' })));
  ok('localizeSpoken on a Marathi call == localizeSpoken pinned mr-IN', () =>
    assert.strictEqual(lean.localizeSpoken(t, {}), lean.localizeSpoken(t, { languageCode: 'mr-IN' })));
}

// ─── THE TURN, NOT THE FRAGMENT; THE SAME RULE ON WHATSAPP ─────────────────
// _updatePairLanguage ran on every STT fragment while the LLM got the
// coalesced turn, and the Hindi side had no token floor: one strong fragment
// flipped a Marathi call. WhatsApp decided hi/mr with the script detector
// alone (a marker-less Devanagari line = Hindi). Both now use pairLanguage on
// the accumulated turn, with the same floors, and the everyday Marathi forms
// the marker list never carried (दुखतंय, उद्या, येऊ, कधी, किती, पाहिजे…).
console.log('\n[turn] a lone token is not a language choice; everyday Marathi is Marathi');
{
  const sarvam = require('../sarvam.js');
  ok('one strong Hindi token does not flip a Marathi call',   () => assert.strictEqual(sarvam.pairLanguage('हाँ', 'mr-IN'), 'mr-IN'));
  ok('...nor two',                                            () => assert.strictEqual(sarvam.pairLanguage('हाँ जी', 'mr-IN'), 'mr-IN'));
  ok('a Hindi sentence does',                                 () => assert.strictEqual(sarvam.pairLanguage('मुझे बुखार है', 'mr-IN'), 'hi-IN'));
  ok('everyday Marathi flips a Hindi call back',              () => assert.strictEqual(sarvam.pairLanguage('डोकं दुखतंय, उद्या येऊ का', 'hi-IN'), 'mr-IN'));
  ok('...and "कधी येऊ?" style asks',                          () => assert.strictEqual(sarvam.pairLanguage('डॉक्टर कधी भेटतील, किती वाजता येऊ', 'hi-IN'), 'mr-IN'));
  ok('a Hindi sentence with one Marathi marker stays Marathi (veto)', () => assert.strictEqual(sarvam.pairLanguage('मुझे उद्या आना है', 'mr-IN'), 'mr-IN'));
}
console.log('\n[whatsapp] the thread decides hi/mr by the same rule as voice');
{
  const sarvam = require('../sarvam.js');
  const { resolveInboundLanguage } = require('../whatsapp.js');
  const FIX = [['हाँ', 'mr-IN'], ['मुझे बुखार है', 'mr-IN'], ['डोकं दुखतंय, उद्या येऊ का', 'hi-IN'], ['ठीक है जी', 'mr-IN'], ['उद्या सकाळी येऊ का', 'hi-IN'], ['मुझे कल appointment चाहिए', 'hi-IN']];
  for (const [t, stored] of FIX) ok(`WhatsApp == voice for "${t}" on a ${stored} thread`, () => assert.strictEqual(resolveInboundLanguage(t, stored), sarvam.pairLanguage(t, stored)));
  ok('first message with nothing stored still resolves by script', () => { assert.strictEqual(resolveInboundLanguage('मुझे कल appointment चाहिए', null), 'hi-IN'); assert.strictEqual(resolveInboundLanguage('ನನಗೆ ನಾಳೆ ಬೇಕು', null), 'kn-IN'); });
}
console.log('\n[turn, driven] fragments coalesce before the decision (real _onTranscript, child)');
{
  const { spawnSync } = require('child_process');
  const path = require('path');
  const DRIVE = `
process.env.SKIP_BOOT_AUDIO = '1';
const { CallHandler } = require('./callHandler.js');
const h = Object.create(CallHandler.prototype);
Object.assign(h, {
  callSid: 'sid-pair', callerPhone: '+918273500806', startTime: Date.now(), callLanguage: null, _hindiInCall: false, _langRequested: null,
  conversationHistory: [], transcript: [], _turnLatencies: [], _llmMs: [], _ttsMs: [], _sttMs: [],
  _lastRituText: '', _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
  isSpeaking: false, _ended: false, shouldEndCall: false,
  handleEmergency: async () => {}, speak: async () => {}, _clearSilenceTimers: () => {}, _startSilenceTimer: () => {},
  _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
  processIntent: async () => null, ws: { readyState: 1, send: () => {} }, stt: new Proxy({}, { get: () => () => {} }),
  _processingChain: Promise.resolve(), _turnRoutedToModel: false,
  _pendingTranscript: '', _debounceTimer: null, _speculation: null,
  _completionSpec: null, _historyStage: 0, _readbackPending: null,
  _medRepeatPending: null, appointmentBooked: false, conversationPhase: 'reason',
  _lastTurnPeakRms: 0, _fillerTurns: 0, _priorMeds: [],
});
(async () => {
  // Fragments back to back: a sleep between them let a starved child's hold
  // expire and dispatch the first fragment alone (flaked once in the pre-push
  // gate, 2026-09-04). Then POLL for the dispatch instead of sleeping a fixed
  // time — the holds under the production pins add up to ~2.3 s, and a loaded
  // machine adds more.
  const frags = JSON.parse(process.env.__FRAGS);
  for (const f of frags) { h._onTranscript(f, { languageCode: 'hi-IN' }).catch(() => {}); }
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && (h._pendingTranscript || h._debounceTimer)) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 100));
  console.log('__RESULT__' + JSON.stringify({ hindiInCall: h._hindiInCall }));
  process.exit(0);
})();
`;
  const drive = (frags) => {
    const r = spawnSync(process.execPath, ['-e', DRIVE], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000, env: { ...process.env, __FRAGS: JSON.stringify(frags), MUTANT: '' } });
    const m = String(r.stdout || '').match(/__RESULT__(\{.*\})/); if (!m) throw new Error('child gave no result: ' + String(r.stderr || '').slice(-200));
    return JSON.parse(m[1]).hindiInCall;
  };
  ok('"मुझे" + "बुखार है" as two fragments → one Hindi turn → Hindi',   () => assert.strictEqual(drive(['मुझे', 'बुखार है']), true));
  ok('"हाँ" alone → stays Marathi',                                   () => assert.strictEqual(drive(['हाँ']), false));
  ok('"मुझे" alone (the first fragment of that turn) → stays Marathi', () => assert.strictEqual(drive(['मुझे']), false));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
