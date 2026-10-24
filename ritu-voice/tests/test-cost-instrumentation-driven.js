#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE COST COUNTERS, DRIVEN TO THE DATABASE — NOT READ FROM THE SOURCE.
//
// Three proposed projects each rested on a quantity nobody had measured:
//   speech.chars        — TTS is billed per character and is 54% of a call
//   tts.coldPerSentence — decides whether socket reuse is worth building
//   llm.*               — tokens per turn, and how many were cached
//
// The instrumentation exists because a MISSING log field was once read as
// evidence: an absent cached= was taken to mean Gemini was not caching, a
// ₹25,000/month conclusion followed, and a multi-day rewrite was scoped on it.
// The field had simply never been requested. So this file asserts on the JSONB
// the call actually persists, and — the part that matters — that ABSENT and
// ZERO stay different in that JSONB.
//
// Run: node tests/test-cost-instrumentation-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};

console.log('\nCOST INSTRUMENTATION — driven to the database\n');

(async () => {
  const { CallHandler } = require('../callHandler.js');
  const db = require('../db.js');

  let written = [];
  db.pool.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/INSERT INTO calls/i.test(s)) { written.push({ sql: s, params }); return { rows: [{ id: 'c1' }], rowCount: 1 }; }
    if (/FROM clinics/i.test(s)) return { rows: [{ id: 'clinic-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  const settle = async (ms = 600) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (written.some((w) => /INSERT INTO calls/i.test(w.sql))) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  // Drive a handler that has already spoken, dialled sockets and burned tokens.
  const drive = async (state) => {
    written = [];
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-cost', callerPhone: '+918273500806', callSource: 'exotel',
      startTime: Date.now() - 60000, conversationHistory: [],
      transcript: [{ role: 'patient', text: 'सर दर्द' }, { role: 'ritu', text: 'कब से?' }],
      _llmMs: [], _ttsMs: [], _sttMs: [], _turnLatencies: [900], _fillerTurns: 0,
      _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
      _rosterBrainTurns: 0, _rosterSlicedTurns: 0, _langPinned: true,
      callLanguage: 'hi-IN', languageDetected: 'hi-IN', _ended: false,
      isSpeaking: false, shouldEndCall: true,
      _clearSilenceTimers: () => {}, _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
      speak: async () => {}, ws: { readyState: 3, close: () => {} }, stt: null,
      ...state,
    });
    if (typeof h._langCode !== 'function') h._langCode = () => 'hi-IN';
    try { await h.endCall(); } catch (_) { /* teardown is not under test */ }
    await settle();
    const row = written.find((w) => /INSERT INTO calls/i.test(w.sql));
    if (!row) return null;
    const raw = row.params.find((p) => typeof p === 'string' && /speech|tts|llm/.test(p));
    try { return JSON.parse(raw); } catch { return null; }
  };

  // ─── [1] the numbers reach the row at all ─────────────────────────────────
  console.log('[1] a call that spoke and burned tokens persists all three blocks');
  const d = await drive({
    _speechChars: 724, _speechReplies: 11,
    _ttsSentences: 11, _ttsColdDials: 2,
    _llmTurns: 10, _llmUsageReportedTurns: 10, _llmCachedReportedTurns: 10,
    _llmPromptTokens: 35330, _llmCompletionTokens: 210, _llmCachedTokens: 8167,
  });
  ok('diagnostics reached the INSERT', () => assert(d, 'no diagnostics JSON in the row'));
  ok('speech.chars persisted',        () => assert.strictEqual(d.speech.chars, 724));
  ok('speech.charsPerReply computed', () => assert.strictEqual(d.speech.charsPerReply, 66));
  ok('tts.coldPerSentence computed',  () => assert.strictEqual(d.tts.coldPerSentence, 0.18));
  ok('llm.promptTokensPerTurn computed', () => assert.strictEqual(d.llm.promptTokensPerTurn, 3533));
  ok('llm.cachedRatio computed',      () => assert.strictEqual(d.llm.cachedRatio, 0.23));

  // ─── [2] THE DISTINCTION THE WHOLE FILE EXISTS FOR ────────────────────────
  // "the provider reported nothing" and "the provider reported zero cached" are
  // different facts. Conflating them is what produced the false conclusion.
  console.log('\n[2] absent and zero stay different');
  const none = await drive({
    _speechChars: 300, _speechReplies: 5, _ttsSentences: 5, _ttsColdDials: 0,
    _llmTurns: 8, _llmUsageReportedTurns: 0, _llmCachedReportedTurns: 0,
    _llmPromptTokens: 0, _llmCompletionTokens: 0, _llmCachedTokens: 0,
  });
  ok('turns are still counted when nothing was reported',
    () => assert.strictEqual(none.llm.turns, 8));
  ok('promptTokens is NULL, not 0, when nothing was reported',
    () => assert.strictEqual(none.llm.promptTokens, null));
  ok('cachedTokens is NULL, not 0, when nothing was reported',
    () => assert.strictEqual(none.llm.cachedTokens, null));
  ok('cachedRatio is NULL, not 0, when nothing was reported',
    () => assert.strictEqual(none.llm.cachedRatio, null));

  const zero = await drive({
    _speechChars: 300, _speechReplies: 5, _ttsSentences: 5, _ttsColdDials: 0,
    _llmTurns: 8, _llmUsageReportedTurns: 8, _llmCachedReportedTurns: 8,
    _llmPromptTokens: 12000, _llmCompletionTokens: 100, _llmCachedTokens: 0,
  });
  ok('a reported ZERO cached is 0, not null',
    () => assert.strictEqual(zero.llm.cachedTokens, 0));
  ok('...and is therefore distinguishable from absent',
    () => assert.notStrictEqual(zero.llm.cachedTokens, none.llm.cachedTokens));

  // ─── [3] a silent call must not fake numbers ──────────────────────────────
  console.log('\n[3] a call with no speech reports nothing, not zero-shaped noise');
  const quiet = await drive({
    _speechChars: 0, _speechReplies: 0, _ttsSentences: 0, _ttsColdDials: 0,
    _llmTurns: 0, _llmUsageReportedTurns: 0, _llmCachedReportedTurns: 0,
    _llmPromptTokens: 0, _llmCompletionTokens: 0, _llmCachedTokens: 0,
  });
  ok('charsPerReply is null with no replies',   () => assert.strictEqual(quiet.speech.charsPerReply, null));
  ok('coldPerSentence is null with no sentences', () => assert.strictEqual(quiet.tts.coldPerSentence, null));

  // ─── [4] THE COUNTERS ARE ACTUALLY WIRED ──────────────────────────────────
  // Sections 1-3 set the counters by hand and assert the arithmetic. A mutation
  // proved that insufficient: deleting the line that increments _ttsColdDials
  // left every assertion above GREEN, because nothing above ever runs it.
  // A metric that is only ever assigned by its own test measures a claim.
  //
  // So drive the real speak() with sarvam stubbed, and assert the counters MOVE.
  console.log('\n[4] the counters move when speech actually happens');
  {
    const sarvamPath = require.resolve('../sarvam.js');
    const realSarvam = require.cache[sarvamPath].exports;
    let cold = true;
    require.cache[sarvamPath].exports = {
      ...realSarvam,
      streamTTS: (text, onChunk) => {
        const p = Promise.resolve();
        p.abort = () => {};
        p.acquiredWarm = !cold;   // first call cold, second warm
        cold = false;
        return p;
      },
    };
    delete require.cache[require.resolve('../callHandler.js')];
    const { CallHandler: CH } = require('../callHandler.js');

    const h = Object.create(CH.prototype);
    Object.assign(h, {
      callSid: 'sid-wire', callerPhone: '+918273500806', transcript: [],
      callLanguage: 'hi-IN', _hindiInCall: false, isSpeaking: false, _ended: false,
      _speechChars: 0, _speechReplies: 0, _ttsSentences: 0, _ttsColdDials: 0,
      _sendStreamingAudio: () => {}, _currentSpeaker: () => 'suhani',
      ws: { readyState: 1, send: () => {} },
    });
    await h.speak('नमस्ते जी');       // 9 chars, cold socket
    await h.speak('कैसे मदद करूँ?');   // warm socket

    ok('speech.chars counted from real speak()', () => assert.strictEqual(h._speechChars, 'नमस्ते जी'.length + 'कैसे मदद करूँ?'.length));
    ok('replies counted',                        () => assert.strictEqual(h._speechReplies, 2));
    ok('sentences counted',                      () => assert.strictEqual(h._ttsSentences, 2));
    ok('COLD dials counted, warm ones not',      () => assert.strictEqual(h._ttsColdDials, 1));

    require.cache[sarvamPath].exports = realSarvam;
  }


  // ─── [5] THE STREAMED PATH COUNTS TOO ─────────────────────────────────────
  // Section 4 drives speak() — canned lines and the greeting. Production
  // replies go through speakStream() → _speakSentence(), and for 30 days that
  // path counted NOTHING: diagnostics showed ~21% of the characters Sarvam
  // billed. So drive the real speakStream with the real _speakSentence and
  // only the socket stubbed, and assert every counter moves.
  console.log('\n[5] the streamed reply path counts chars, sentences, one reply, and cold dials');
  {
    const sarvamPath = require.resolve('../sarvam.js');
    const realSarvam = require.cache[sarvamPath].exports;
    let cold = true;
    require.cache[sarvamPath].exports = {
      ...realSarvam,
      textToSpeech: async () => Buffer.alloc(320),      // the boot pre-cache must not dial Sarvam
      streamTTS: (text, onChunk) => {
        const p = Promise.resolve();
        p.abort = () => {};
        p.acquiredWarm = !cold;   // first sentence cold, the rest warm
        cold = false;
        return p;
      },
    };
    delete require.cache[require.resolve('../callHandler.js')];
    const { CallHandler: CH } = require('../callHandler.js');
    const h = new CH('sid-stream', '+918273500806', { readyState: 1, send: () => {} }, 'test', false);
    h._sendMark = () => {}; h._sendSilence = () => {}; h._flushStreamingTail = () => {};
    h._sendStreamingAudio = () => {}; h._clearAudio = () => {};
    const s1 = 'जी बिल्कुल।', s2 = 'आपको क्या तकलीफ़ है?';
    async function* reply() {
      yield { kind: 'sentence', text: s1, ttftMs: 700 };
      yield { kind: 'sentence', text: s2 };
      yield { kind: 'done', usage: { prompt: 1200, completion: 18, cached: 400 },
              result: { text: `${s1} ${s2}`, endCall: false, patientName: null, reason: null, emergency: false } };
    }
    await h.speakStream(reply(), h._generationId);

    ok('speech.chars counted from the REAL streamed path', () => assert.strictEqual(h._speechChars, s1.length + s2.length));
    ok('each streamed sentence is a TTS sentence',        () => assert.strictEqual(h._ttsSentences, 2));
    ok('one streamed reply is ONE reply, not two',         () => assert.strictEqual(h._speechReplies, 1));
    ok('the cold socket for sentence one is counted',      () => assert.strictEqual(h._ttsColdDials, 1));
    ok('the done chunk still reports LLM usage once',      () => assert.strictEqual(h._llmUsageReportedTurns, 1));
    ok('...with the tokens it carried',                    () => assert.strictEqual(h._llmPromptTokens, 1200));
    require.cache[sarvamPath].exports = realSarvam;
  }

  // ─── [6] EVERY BRAIN REQUEST IS METERED, NOT JUST STREAMED ONES ───────────
  // _recordLlmUsage had ONE caller: the streamed 'done' chunk. The speculation,
  // the fallback re-run and every non-streamed turn were spent and never
  // counted — 97 metered turns against 237 real requests over 30 days (41%).
  // The brain now reports usage through the same callback shape as
  // onRosterSlice, so the invariant is mechanical: brain requests == LLM turns.
  console.log('\n[6] a non-streamed brain request records its usage — requests and metered turns agree');
  {
    // brain-lean binds completeWithFailover from llm/index.js, which itself
    // destructured failover.js at ITS require time — so the stub must replace
    // the module brain-lean actually reads. Stubbing failover.js one level
    // deeper left the real provider bound and this section dialled Gemini.
    const failoverPath = require.resolve('../llm/index.js');
    require(failoverPath);
    const orig = require.cache[failoverPath].exports;
    let requests = 0;
    require.cache[failoverPath].exports = {
      ...orig,
      completeWithFailover: async () => { requests++; return { content: 'ठीक है जी, बताइए।', usage: { prompt: 900, completion: 9, cached: 300 } }; },
    };
    // brain-lean destructures at require — stub BEFORE the fresh require.
    delete require.cache[require.resolve('../brain-lean.js')];
    delete require.cache[require.resolve('../callHandler.js')];
    const sarvamPath = require.resolve('../sarvam.js');
    const realSarvam = require.cache[sarvamPath].exports;
    require.cache[sarvamPath].exports = { ...realSarvam, textToSpeech: async () => Buffer.alloc(320) };
    const { CallHandler: CH } = require('../callHandler.js');
    const h = new CH('sid-nonstream', '+918273500806', { readyState: 1, send: () => {} }, 'test', false);
    h.conversationHistory = [];
    const result = await h._leanNonStreamedResult('मुझे appointment चाहिए');

    ok('the non-streamed brain answered',                    () => assert.ok(result && result.text, 'no result text'));
    ok('exactly one provider request was made',              () => assert.strictEqual(requests, 1));
    ok('the request was counted as a brain turn',            () => assert.strictEqual(h._rosterBrainTurns, 1));
    ok('AND as an LLM turn — the two meters agree',          () => assert.strictEqual(h._llmTurns, h._rosterBrainTurns));
    ok('its usage was reported (was 0 for every such turn)', () => assert.strictEqual(h._llmUsageReportedTurns, 1));
    ok('prompt tokens landed',                               () => assert.strictEqual(h._llmPromptTokens, 900));
    ok('cached tokens landed',                               () => assert.strictEqual(h._llmCachedTokens, 300));

    // The driven turn exercises one of three context builders. The other two
    // (speculation, streamed) must carry the same callback — parity, so a
    // builder cannot quietly drop it the way the streamed path dropped TTS.
    const src = fs.readFileSync(require.resolve('../callHandler.js'), 'utf8');
    const slices = (src.match(/onRosterSlice: \(sl\) => this\._noteRosterSlice\(sl\)/g) || []).length;
    const usages = (src.match(/onLlmUsage: \(u\) => this\._recordLlmUsage\(u\)/g) || []).length;
    ok('every builder that reports roster slices reports usage too', () => { assert.ok(slices >= 3, `slices=${slices}`); assert.strictEqual(usages, slices); });

    require.cache[failoverPath].exports = orig;
    require.cache[sarvamPath].exports = realSarvam;
  }


  // ─── [7] A REQUEST ABANDONED BEFORE 'done' WAS STILL SPENT ────────────────
  // The first fix metered the streamed 'done' chunk and the non-streamed call.
  // A stream that ends in fallback-required, or is discarded by barge-in, never
  // reaches 'done' — the provider billed it, brainTurns counted it, the LLM
  // meter did not. The commit that claimed "llm.turns == brainTurns" was wrong
  // for exactly those turns. Now the invariant is WRITTEN into diagnostics.
  console.log('\n[7] abandoned streams count as turns (usage null, never 0); the invariant is written');
  {
    const sarvamPath = require.resolve('../sarvam.js');
    const realSarvam = require.cache[sarvamPath].exports;
    require.cache[sarvamPath].exports = { ...realSarvam, textToSpeech: async () => Buffer.alloc(320),
      streamTTS: () => { const p = Promise.resolve(); p.abort = () => {}; p.acquiredWarm = true; return p; } };
    delete require.cache[require.resolve('../callHandler.js')];
    const { CallHandler: CH } = require('../callHandler.js');
    const mk = () => { const h = new CH('sid-abandon', '+918273500806', { readyState: 1, send: () => {} }, 'test', false);
      h._sendMark = () => {}; h._sendSilence = () => {}; h._flushStreamingTail = () => {}; h._sendStreamingAudio = () => {}; h._clearAudio = () => {}; return h; };

    // fallback-required before any sentence (the pre-speech guard)
    const h1 = mk();
    async function* fb() { yield { kind: 'fallback-required', reason: 'false_confirmation' }; }
    const r1 = await h1.speakStream(fb(), h1._generationId);
    ok('fallback-required stream → the turn is counted',   () => { assert.strictEqual(r1.fallback, true); assert.strictEqual(h1._llmTurns, 1); });
    ok('...with usage ABSENT, not zero',                     () => assert.strictEqual(h1._llmUsageReportedTurns, 0));

    // discarded by barge-in (generation moved on) after the first sentence
    const h2 = mk();
    async function* bargeIn() { yield { kind: 'sentence', text: 'जी बिल्कुल।' }; h2._generationId += 1; yield { kind: 'sentence', text: 'x' }; }
    const gen = h2._generationId;
    const r2 = await h2.speakStream(bargeIn(), gen);
    ok('discarded stream → the turn is counted',            () => { assert.strictEqual(r2.discarded, true); assert.strictEqual(h2._llmTurns, 1); });

    // the invariant reaches the row — through the file's own drive() so the
    // extraction is the one section [1] already proved
    const d7 = await drive({ _rosterBrainTurns: 3, _llmTurns: 2, _llmUsageReportedTurns: 2, _llmCachedReportedTurns: 0,
      _llmPromptTokens: 7000, _llmCompletionTokens: 40, _llmCachedTokens: 0, _speechChars: 10, _speechReplies: 1, _ttsSentences: 1, _ttsColdDials: 0 });
    ok('diagnostics carry brainTurns',                              () => assert.strictEqual(d7 && d7.llm.brainTurns, 3));
    ok('diagnostics carry unmeteredTurns = brainTurns - turns',     () => assert.strictEqual(d7 && d7.llm.unmeteredTurns, 1));
    ok('diagnostics carry meterVersion 2 (pre-fix rows: absent)',   () => assert.strictEqual(d7 && d7.llm.meterVersion, 2));
    require.cache[sarvamPath].exports = realSarvam;
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (fail) { console.log('✗ FAILURES'); process.exit(1); }
  console.log('✓ The counters reach the database, and absent is not zero.');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
