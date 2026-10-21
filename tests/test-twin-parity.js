#!/usr/bin/env node
'use strict';
// TWIN PARITY — the registry that did not exist.
//
// Every rule in this product has at least two surfaces that must behave
// identically (streamed/non-streamed reply, voice/WhatsApp guards, speak/
// _speakSentence, the voice context builders/the WhatsApp one). Eight fixes
// in one week each landed on the ONE surface where the incident was seen; an
// adversarial audit (2026-09-03) found the sibling still carrying the gap in
// every case. This file names the twins ONCE and drives BOTH sides of each
// with the same fixtures, asserting the observable outcome agrees.
//
// A divergence is either a failure or a KNOWN entry with a written reason —
// never silent. KNOWN entries are printed on every run; the list may shrink,
// and an entry that stops diverging is reported so it can be removed.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-WA-DROPS-DRIFT        — the WhatsApp builder loses driftReasked
//   MUTANT=MUT-WA-ADVICE-NO-STANDDOWN — WhatsApp deflects the meds answer (voice runs in a child, unaffected)
//   MUTANT=MUT-WA-OWN-PROBE          — WhatsApp composes its own emergency probe
//   MUTANT=MUT-SPEAK-BYPASSES-HISTORY — a deterministic line is spoken without the history push (applied in the voice child)
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

// ── the registry ─────────────────────────────────────────────────────────────
const TWINS = {
  reply:   { a: 'brain-lean.processLeanRaw (non-streamed)', b: 'brain-lean.getLeanResponseStream (streamed)', observable: 'is the model text spoken verbatim?' },
  guards:  { a: 'callHandler._onTranscript (voice)',        b: 'whatsappGuards.runInboundGuards (WhatsApp)', observable: 'which deterministic guard answered' },
  speech:  { a: 'callHandler.speak',                        b: 'callHandler.speakStream → _speakSentence',    observable: 'text and options that reached TTS; counters; transcript' },
  context: { a: 'voice context builders',                   b: 'whatsappChannel.buildLeanContext',            observable: 'the policy keys the brain receives' },
};
// Documented divergences. Each must carry a reason; each is printed every run.
const KNOWN = [
  { twin: 'reply', fixture: 'false booked claim', context: 'hi post-booking',
    reason: 'non-streamed exempts claimsBooked/claimsSent once appointmentBooked (a re-confirm loop, brain-lean ~1826); the streamed guard has no exemption — safe only because post-booking never streams (callHandler dispatch). Unify when the exemption is revisited.' },
  { twin: 'reply', fixture: 'false send claim', context: 'hi post-booking', reason: 'same exemption as the booked claim' },
  { twin: 'speech', fixture: 'degenerate markdown',
    reason: 'speak() substitutes the fallback line for a degenerate reply; _speakSentence SKIPS the sentence (the turn\'s other sentences carry on). A whole-turn degenerate stream therefore says nothing — to unify at the turn level.' },
];
const knownKey = (k) => `${k.twin}|${k.fixture}|${k.context || ''}`;
const knownSet = new Set(KNOWN.map(knownKey));
const seenKnown = new Set();
const divergences = [];
function compare(twin, fixture, context, a, b) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  const key = `${twin}|${fixture}|${context || ''}`;
  if (same) return true;
  if (knownSet.has(key)) { seenKnown.add(key); return 'known'; }
  divergences.push({ twin, fixture, context, a, b });
  return false;
}

(async () => {
  console.log('\nTWIN PARITY — one fixture table, both sides of every twin\n');
  for (const [k, t] of Object.entries(TWINS)) console.log(`  ${k.padEnd(8)} ${t.a}  ⇄  ${t.b}   [${t.observable}]`);

  // ── stubs BEFORE requires (patch-before-require) ────────────────────────────
  const detPath = require.resolve('../emergencyDetector.js');
  const det = require(detPath);
  if (MUTANT === 'MUT-WA-OWN-PROBE') { const { toDevanagari } = require('../translit'); det.composeEmergencyProbe = (t) => `${t} ${toDevanagari(t)}`; }
  const advPath = require.resolve('../medicalAdviceGuard.js');
  if (MUTANT === 'MUT-WA-ADVICE-NO-STANDDOWN') require(advPath).adviceGuardSuppressed = () => false;
  const llm = require('../llm');
  let script = [];
  llm.streamWithFailover = async function* () { for (const part of script) yield { content: part, provider: 'stub', model: 'stub' }; yield { done: true, usage: null }; };
  llm.completeWithFailover = async () => ({ content: script.join(''), usage: null });
  const brain = require('../brain-lean.js');
  const db = require('../db.js'); db.pool.query = async () => ({ rows: [] });
  brain._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'डॉ. दिव्या साने', specialty: 'Gastroenterologist', windows: [], taken: [] }] });
  const { runInboundGuards } = require('../whatsappGuards.js');
  const { detectSensitiveProbe } = require('../sensitiveDataGuard.js');
  const { detectMedicalAdvice } = require('../medicalAdviceGuard.js');
  const { toDevanagari } = require('../translit');

  // ═══ [reply] non-streamed vs streamed: the same raw completion, the same verdict ═══
  console.log('\n[reply] the same raw completion must be spoken verbatim on both sides, or on neither');
  {
    const CTX = {
      'hi pre-booking':  { languageCode: 'hi-IN' },
      'hi post-booking': { languageCode: 'hi-IN', appointmentBooked: true, bookedThisCall: { appointment_id: 'A' } },
      'mr':              {},
      'gu':              { languageCode: 'gu-IN' },
    };
    const base = (extra) => ({ clinicId: 'c1', callerPhone: '+919999999999', patientName: 'सिद्धार्थ', driftReasked: false, patientTextAll: 'मुझे खुजली है दो दिन से', ...extra });
    const FIX = [
      ['false booked claim',  'हो गया जी! कल शाम 5 बजे बुक कर दिया है।'],
      ['false cancel claim',  'आपकी अपॉइंटमेंट कैंसिल कर दी है जी।'],
      ['false send claim',    'मैंने WhatsApp पर डिटेल्स भेज दी हैं।'],
      ['false move claim',    'कल शाम 5 बजे के लिए बदल दिया है।'],
      ['invented complaint',  'आपको पेट दर्द की परेशानी है तो डॉ. दिव्या साने आज शाम 5 बजे उपलब्ध हैं। बुक करूँ?'],
      ['plain reply',         'जी बिल्कुल, कल शाम 5 बजे का समय खाली है।'],
      ['a question',          'क्या मैं आपकी अपॉइंटमेंट का समय बदल दूँ?'],
    ];
    const chunks = (s, n = 6) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };
    for (const [name, raw] of FIX) for (const [cname, cextra] of Object.entries(CTX)) {
      const ns = await brain.processLeanRaw(raw, base(cextra));
      const nonStreamedVerbatim = !ns.canned;
      script = chunks(raw); const out = [];
      for await (const y of brain.getLeanResponseStream([{ role: 'user', content: 'हाँ जी' }], base(cextra))) out.push(y);
      const streamedSpeaks = !!(out[0] && out[0].kind === 'sentence');
      const v = compare('reply', name, cname, { verbatim: nonStreamedVerbatim }, { verbatim: streamedSpeaks });
      await ok(`${name.padEnd(18)} @ ${cname.padEnd(15)} non-streamed ${nonStreamedVerbatim ? 'VERBATIM' : 'replaced'} / streamed ${streamedSpeaks ? 'STREAMS' : 'hands off'}${v === 'known' ? '  (KNOWN)' : ''}`,
        async () => assert.ok(v, `twins disagree — one side would speak "${raw.slice(0, 40)}", the other would not`));
    }
  }

  // ═══ [guards] voice _onTranscript vs WhatsApp runInboundGuards ═══
  console.log('\n[guards] the deterministic guard cascade must answer the same on both channels');
  {
    const DRIVE = `
process.env.SKIP_BOOT_AUDIO = '1';
const { CallHandler } = require('./callHandler.js');
if (process.env.MUTANT === 'MUT-SPEAK-BYPASSES-HISTORY') CallHandler.prototype._sayDeterministic = function (x) { return this.speak(x); };
const h = Object.create(CallHandler.prototype);
let escalated = null; const spoken = [];
Object.assign(h, {
  callSid: 'sid-twin', callerPhone: '+918273500806', startTime: Date.now(),
  conversationHistory: [], transcript: [], _turnLatencies: [], _llmMs: [], _ttsMs: [], _sttMs: [],
  _lastRituText: '', _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
  isSpeaking: false, _ended: false, shouldEndCall: false,
  handleEmergency: async (d) => { escalated = d; },
  speak: async (t) => { spoken.push(t); }, _clearSilenceTimers: () => {}, _startSilenceTimer: () => {},
  _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
  processIntent: async () => null, _langCode: () => 'hi-IN',
  ws: { readyState: 1, send: () => {} }, stt: new Proxy({}, { get: () => () => {} }),   // production pins turn on paths that call this.stt.*
  _processingChain: Promise.resolve(), _turnRoutedToModel: false,
  _pendingTranscript: '', _debounceTimer: null, _speculation: null,
  _completionSpec: null, _historyStage: Number(process.env.__STAGE || 0), _readbackPending: null,
  _medRepeatPending: null, appointmentBooked: false, conversationPhase: 'reason',
  _lastTurnPeakRms: 0, _fillerTurns: 0, _priorMeds: [],
});
let err = null;
process.on('unhandledRejection', (e) => { err = err || String(e && e.stack || e).slice(0, 300); });
(async () => {
  try { await h._onTranscript(process.env.__UTT, { languageCode: 'hi-IN' }); } catch (e) { err = String(e && e.stack || e).slice(0, 300); }
  // the sensitive/advice/intake exits run AFTER the transcript debounce; poll
  // for the dispatch (pending cleared, timer gone) instead of a fixed sleep.
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !escalated && (h._pendingTranscript || h._debounceTimer)) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 150));
  if (process.env.MUTANT === 'MUT-SPEAK-BYPASSES-HISTORY') { /* applied below via prototype */ }
  console.log('__RESULT__' + JSON.stringify({ escalated: escalated ? (escalated.type || 'emergency') : null, spoken, err, history: h.conversationHistory.filter((m) => m.role === 'assistant').map((m) => m.content) }));
  process.exit(0);
})();
`;
    const voice = (utt, stage = 0) => {
      const r = spawnSync(process.execPath, ['-e', DRIVE], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
        env: { ...process.env, __UTT: utt, __STAGE: String(stage), EMERGENCY_V2_ENFORCE: '', EMERGENCY_V2: '', MUTANT: MUTANT === 'MUT-SPEAK-BYPASSES-HISTORY' ? MUTANT : '' } });
      const m = String(r.stdout || '').match(/__RESULT__(\{.*\})/);
      if (!m) throw new Error(`voice child gave no result: ${String(r.stderr || '').slice(-200)}`);
      const { escalated, spoken, err, history } = JSON.parse(m[1]);
      for (const line of spoken) if (!history.includes(line)) unseenLines.push({ utt, line: line.slice(0, 40) });
      if (err && !escalated && !spoken.length) return `error:${err.split('\n')[0].slice(0, 60)}`;
      if (escalated) return escalated === 'self_harm' ? 'self_harm' : 'emergency';
      const probe = utt + ' ' + toDevanagari(utt);
      const sens = detectSensitiveProbe(probe, 'hi-IN'); const adv = detectMedicalAdvice(probe, 'hi-IN');
      if (spoken.length && sens && spoken.includes(sens.response)) return 'sensitive';
      if (spoken.length && adv && spoken.includes(adv.response)) return 'medical_advice';
      if (spoken.length && INTAKE.includes(spoken[0])) return 'intake';
      return spoken.length ? `other:${spoken[0].slice(0, 30)}` : null;
    };
    const unseenLines = [];   // deterministic lines spoken but never pushed to conversationHistory
    // WhatsApp, driven like voice: guards first; if they stand down, the turn
    // runner (whose intake runs the SAME voice methods on a hydrated adapter).
    const INTAKE = Object.values(require('../callHandler.js')._INTAKE_LINES).flatMap((tbl) => Object.values(tbl));
    const dbMod = require('../db.js');
    const toolMod = require('../tools/findPatientAppointment.js');
    const leanPath2 = require.resolve('../brain-lean.js');
    const realLean2 = require.cache[leanPath2].exports;
    const wa = async (utt, lastOutbound = '', stage = 0) => {
      const r = runInboundGuards(utt, 'hi-IN', { lastOutbound, historyStage: stage });
      if (r) return r.kind;
      const saved = { hist: dbMod.getConversationHistory, upd: dbMod.updateConversationIntake, msg: dbMod.saveWhatsAppMessage, meds: dbMod.getPatientMedications, exec: toolMod.execute };
      dbMod.getConversationHistory = async () => [{ role: 'user', content: utt }];
      dbMod.updateConversationIntake = async () => true; dbMod.saveWhatsAppMessage = async () => 'm'; dbMod.getPatientMedications = async () => [];
      toolMod.execute = async () => ({ appointments: [] });
      require.cache[leanPath2].exports = { ...realLean2, getLeanResponse: async () => ({ text: 'ठीक है जी।', canned: false, booked: false, endCall: false }) };
      const waPath2 = require.resolve('../whatsappChannel.js'); delete require.cache[waPath2];
      try {
        const res = await require(waPath2).runTurn({ phone: '919999999999', conv: { id: 9, language: 'hi-IN', intake: { v: 1, stage, at: Date.now() } }, patientName: 'x', patientTextAll: utt, patientId: null });
        return INTAKE.includes(res.text) ? 'intake' : null;
      } finally {
        Object.assign(dbMod, { getConversationHistory: saved.hist, updateConversationIntake: saved.upd, saveWhatsAppMessage: saved.msg, getPatientMedications: saved.meds });
        toolMod.execute = saved.exec; require.cache[leanPath2].exports = realLean2; delete require.cache[waPath2];
      }
    };
    const FIX = [
      ['cardiac',                 'छाती में बहुत ज़्यादा दर्द है'],
      ['seam (itching on chest)', 'दर्द बिल्कुल नहीं, बस खुजली है छाती में'],
      ['kn-script heart attack',  'ಹಾರ್ಟ್ ಅಟ್ಯಾಕ್ ಆಗಿದೆ'],
      ['passive ideation',        'अब जीने का मन नहीं करता'],
      ['emergency ward address',  'emergency ward ka address bhejiye'],
      ['record count probe',      'कितने मरीज़ आज आए?'],
      ['my-name recite probe',    'मेरा नाम क्या है आपके रिकॉर्ड में?'],
      ['advice question',         'कौन सी क्रीम लगाऊँ चेहरे पर?'],
      ['plain booking ask',       'मुझे कल अपॉइंटमेंट चाहिए'],
    ];
    for (const [name, utt] of FIX) {
      const a = voice(utt), b = await wa(utt);
      const v = compare('guards', name, '', { kind: a }, { kind: b });
      await ok(`${name.padEnd(24)} voice ${String(a).padEnd(14)} WhatsApp ${String(b)}${v === 'known' ? '  (KNOWN)' : ''}`, async () => assert.ok(v, 'channels disagree'));
    }
    // the meds answer after Ritu's own meds question stands down on BOTH channels
    const medsQ = 'कोई दवाई चल रही है या किसी चीज़ से एलर्जी?';
    const answer = 'कौन सी दवाई लूँ इसके लिए?';
    const a = voice(answer, 2), b = await wa(answer, '', 2);   // both channels: stage 2 = Ritu just asked meds
    const v = compare('guards', 'advice after meds question', '', { kind: a }, { kind: b });
    await ok(`${'advice after meds question'.padEnd(24)} voice ${String(a).padEnd(14)} WhatsApp ${String(b)}`, async () => assert.ok(v, 'one channel deflects the patient\'s answer to Ritu\'s own question'));
    await ok('every deterministic line voice spoke is in conversationHistory (the model can see it)', async () => assert.deepStrictEqual(unseenLines, [], JSON.stringify(unseenLines)));
    await ok('a complaint gets the intake question on BOTH channels (the twin closed 2026-09-04)', async () => {
      const a2 = voice('मुझे दो दिन से खुजली है'), b2 = await wa('मुझे दो दिन से खुजली है');
      const want = require('../config.js').previsitIntake ? 'intake' : null;   // off for a booking-only clinic (Skin Essence profile)
      assert.strictEqual(a2, want); assert.strictEqual(b2, want);
    });
  }

  // ═══ [speech] speak() vs speakStream → _speakSentence ═══
  console.log('\n[speech] the same text must reach TTS the same way from both paths');
  {
    const sarvamPath = require.resolve('../sarvam.js');
    require(sarvamPath);   // may not be loaded yet in this process
    const realSarvam = require.cache[sarvamPath].exports;
    let calls = [];
    require.cache[sarvamPath].exports = { ...realSarvam, textToSpeech: async () => Buffer.alloc(320),
      streamTTS: (text, onChunk, opts) => { calls.push({ text, opts }); const p = Promise.resolve(); p.abort = () => {}; p.acquiredWarm = true; return p; } };
    delete require.cache[require.resolve('../callHandler.js')];
    const { CallHandler: CH } = require('../callHandler.js');
    const mk = (callLanguage) => { const h = new CH('sid-speech', '+918273500806', { readyState: 1, send: () => {} }, 'test', false);
      h.callLanguage = callLanguage; h._sendMark = () => {}; h._sendSilence = () => {}; h._flushStreamingTail = () => {}; h._sendStreamingAudio = () => {}; h._clearAudio = () => {}; return h; };
    const observe = (h) => ({ tts: calls.map((c) => ({ text: c.text, lang: c.opts && c.opts.languageCode, speaker: c.opts && c.opts.speaker })),
      chars: h._speechChars, sentences: h._ttsSentences, replies: h._speechReplies, transcript: h.transcript.map((t) => t.text) });
    const FIX = [
      ['plain Hindi',          'नमस्ते जी, कैसे मदद करूँ?', null],
      ['stray newlines',       'जी बिल्कुल।\n\nकल आइए।', null],
      ['degenerate markdown',  '## Step 1: something', null],
      ['Latin on a kn-IN call','Please come tomorrow at five.', 'kn-IN'],
    ];
    for (const [name, text, lang] of FIX) {
      calls = []; const h1 = mk(lang); await h1.speak(text); const a = observe(h1);
      calls = []; const h2 = mk(lang);
      async function* one() { yield { kind: 'sentence', text }; yield { kind: 'done', usage: null, result: { text, endCall: false } }; }
      await h2.speakStream(one(), h2._generationId); const b = observe(h2);
      const v = compare('speech', name, '', a, b);
      await ok(`${name.padEnd(22)} ${v === true ? 'identical' : v === 'known' ? 'KNOWN divergence' : 'DIVERGE'}`, async () => assert.ok(v, `speak=${JSON.stringify(a)} stream=${JSON.stringify(b)}`));
    }
    require.cache[sarvamPath].exports = realSarvam;
  }

  // ═══ [context] the voice builders vs the WhatsApp builder ═══
  console.log('\n[context] every policy key a voice builder gives the brain, the WhatsApp builder gives too');
  {
    // capture the context the real voice methods hand to the brain
    const leanPath = require.resolve('../brain-lean.js');
    const realLean = require.cache[leanPath].exports;
    const captured = {};
    require.cache[leanPath].exports = { ...realLean,
      getLeanResponse: async (h, ctx) => { captured.nonStreamed = ctx; return { text: 'ठीक है जी।', canned: false, booked: false, endCall: false, patientName: null, reason: null, emergency: false }; },
      getLeanResponseStream: async function* (h, ctx) { captured.streamed = ctx; yield { kind: 'done', usage: null, result: { text: 'ठीक है जी।', endCall: false } }; },
    };
    delete require.cache[require.resolve('../callHandler.js')];
    const { CallHandler: CH } = require('../callHandler.js');
    const h = new CH('sid-ctx', '+918273500806', { readyState: 1, send: () => {} }, 'test', false);
    h._sendMark = () => {}; h._sendSilence = () => {}; h._flushStreamingTail = () => {}; h._sendStreamingAudio = () => {}; h._clearAudio = () => {}; h.speak = async () => {};
    h.conversationHistory = [];
    try { await h._leanNonStreamedResult('मुझे appointment चाहिए'); } catch (_) { /* only the context is under test */ }
    try { await h.processIntentLeanStream('मुझे appointment चाहिए'); } catch (_) { /* only the context is under test */ }
    require.cache[leanPath].exports = realLean; delete require.cache[require.resolve('../callHandler.js')];
    const waMod = require('../whatsappChannel.js');
    let waCtx = waMod.buildLeanContext({ phone: '+919999999999', language: 'hi-IN', patientName: 'x', patientTextAll: '' });
    if (MUTANT === 'MUT-WA-DROPS-DRIFT') delete waCtx.driftReasked;
    const POLICY = ['appointmentBooked', 'bookedThisCall', 'driftReasked', 'patientTextAll', 'onRosterSlice', 'onLlmUsage', 'hindiInCall', 'languageCode', 'multilingual', 'clinicId', 'callerPhone', 'patientName'];
    for (const side of ['nonStreamed', 'streamed']) {
      await ok(`voice ${side} builder was captured`, async () => assert.ok(captured[side], 'the brain was never called'));
      if (!captured[side]) continue;
      const voiceKeys = Object.keys(captured[side]).filter((k) => POLICY.includes(k)).sort();
      const missing = voiceKeys.filter((k) => !(k in waCtx));
      const v = compare('context', `voice ${side} vs WhatsApp`, '', { policyKeys: voiceKeys }, { policyKeys: voiceKeys.filter((k) => k in waCtx) });
      await ok(`voice ${side} ⊆ WhatsApp: ${voiceKeys.length} policy keys${missing.length ? ' — MISSING on WhatsApp: ' + missing.join(', ') : ''}`, async () => assert.ok(v, `missing: ${missing.join(', ')}`));
    }
    await ok('WhatsApp runTurn hands the brain bookedThisCall (next active row) and driftReasked (last outbound was the ask)', async () => {
      // whatsappChannel destructures brain-lean and the tool at require: stub, then fresh-require it
      const toolPath = require.resolve('../tools/findPatientAppointment.js');
      const realTool = require(toolPath);
      const dbMod = require('../db.js');
      const realHist = dbMod.getConversationHistory;
      let handed = null;
      require.cache[leanPath].exports = { ...realLean, getLeanResponse: async (h, ctx) => { handed = ctx; return { text: 'ठीक है जी।', canned: false, booked: false, endCall: false, patientName: null, reason: null, emergency: false }; } };
      require.cache[toolPath].exports = { ...realTool, execute: async () => ({ appointments: [{ appointment_id: 'W1', appointment_time: new Date('2026-09-05T10:00:00+05:30'), doctor_name: 'डॉ. दिव्या साने' }], distinct_patient_names: [] }) };
      const waPath = require.resolve('../whatsappChannel.js');
      delete require.cache[waPath];
      try {
        const wa = require(waPath);
        const askLine = realLean.cannedLine('askComplaint', wa.buildLeanContext({ phone: '+919999999999', language: 'hi-IN', patientName: 'x', patientTextAll: '' }));
        dbMod.getConversationHistory = async () => [{ role: 'user', content: 'मुझे खुजली है' }, { role: 'assistant', content: askLine }, { role: 'user', content: 'हाँ' }];
        await wa.runTurn({ phone: '+919999999999', conv: { id: 1, language: 'hi-IN' }, patientName: 'x', patientTextAll: 'मुझे खुजली है' });
        assert.ok(handed, 'brain never called');
        assert.strictEqual(handed.driftReasked, true, 'driftReasked not derived from the last outbound');
        assert.strictEqual(handed.appointmentBooked, true);
        assert.strictEqual(handed.bookedThisCall && handed.bookedThisCall.appointment_id, 'W1');
        assert.strictEqual(typeof handed.onLlmUsage, 'function');
      } finally { require.cache[leanPath].exports = realLean; require.cache[toolPath].exports = realTool; dbMod.getConversationHistory = realHist; delete require.cache[waPath]; }
    });
    await ok('WhatsApp builder derives appointmentBooked from bookedThisCall', async () => {
      const c = waMod.buildLeanContext({ phone: '+91', language: 'hi-IN', patientName: 'x', patientTextAll: '', bookedThisCall: { appointment_id: 'Z' } });
      assert.strictEqual(c.appointmentBooked, true); assert.strictEqual(c.bookedThisCall.appointment_id, 'Z');
    });
  }

  // ── the ledger ──────────────────────────────────────────────────────────────
  console.log('\nKNOWN divergences (documented, printed every run):');
  for (const k of KNOWN) console.log(`  ${seenKnown.has(knownKey(k)) ? '•' : '○ (did NOT diverge this run — remove?)'} [${k.twin}] ${k.fixture}${k.context ? ' @ ' + k.context : ''}: ${k.reason.slice(0, 110)}…`);
  if (divergences.length) { console.log('\nUNDOCUMENTED divergences:'); for (const d of divergences) console.log(`  ✗ [${d.twin}] ${d.fixture}${d.context ? ' @ ' + d.context : ''}: a=${JSON.stringify(d.a).slice(0, 120)} b=${JSON.stringify(d.b).slice(0, 120)}`); }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
