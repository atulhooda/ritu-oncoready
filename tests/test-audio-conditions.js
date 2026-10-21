#!/usr/bin/env node
// ─── HOW NOISY WAS THE LINE — the first acoustic signal we keep ─────────────
// LIVE CALL c394b280c4808227d8e28c957d231a8d, 2026-08-13. The caller reported
// Ritu misbehaving and asked whether background noise was the cause. The record
// could not answer:
//
//     dropped = 0              nothing was discarded
//     garbleReprompts = 0      nothing was flagged unclear
//     recording_url = NULL     Exotel recordings stopped on 2026-08-05
//     diagnostics = 18 keys    not one of them acoustic
//
// Two live hypotheses — the model invented a rejected time, or the caller's
// answer was lost to noise — and no data that separates them. RMS was already
// computed on every audio chunk and used for three in-call decisions (the
// silence-ghost drop, the short-burst hold, the debounce loudness gate); it was
// simply never written down.
//
// So: sample the background where it is the ONLY thing present — chunks with
// neither party speaking — and keep the per-turn speech peaks beside it.
// snrDb = 20·log10(speech ÷ floor). MEASURED against the fixtures below,
// a quiet room reads ~34 dB and a clinic waiting-room ~14 dB, which is the
// separation the metric has to provide to be worth keeping.
//
// NOTHING READS IT YET, ON PURPOSE. A threshold invented today would be the
// guessed-vendor-parameter mistake this repo runs a gate against — the same
// class as the Sarvam VAD setting that halved "Dolo 650". Twenty calls of this
// first, then decide with numbers.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';
process.env.CLINIC_ID_UUID = process.env.CLINIC_ID_UUID || '11111111-1111-1111-1111-111111111111';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nAUDIO CONDITIONS — the line, measured and persisted\n');

(async () => {
  const { CallHandler } = require('../callHandler.js');
  const db = require('../db.js');
  const realQuery = db.pool.query.bind(db.pool);

  // Drive a real hang-up and return the audio block that reached the INSERT.
  // Captured at pool.query so db.js's own logCallToDb runs and the JSON that is
  // actually stored is what gets asserted.
  const persistedAudio = async ({ floor = [], speech = [] } = {}) => {
    let diag = null;
    db.pool.query = async (sql, params = []) => {
      if (/INSERT INTO calls/i.test(String(sql))) {
        // MATCH THE SHAPE, NOT A SUBSTRING. This first read
        //     params.find(p => /deadAir|audio/.test(p))
        // and the call sid was 'sid-audio', so it matched the SID, JSON.parse
        // threw "Unexpected token 's'", the catch swallowed it, and every
        // assertion below failed with "diagnostics.audio is absent" — a test
        // fixture colliding with the matcher that reads it, reported as a
        // missing feature. The feature was fine the whole time.
        const raw = params.find((p) => typeof p === 'string' && p.startsWith('{') && p.includes('deadAirP50'));
        if (raw) diag = JSON.parse(raw);
        return { rows: [{ id: 'c' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-acoustic-fixture', callerPhone: '+918273500806', startTime: Date.now() - 30000,
      conversationHistory: [], transcript: [], _llmMs: [], _ttsMs: [], _sttMs: [],
      _turnLatencies: [], _fillerTurns: 0, _droppedUtterances: 0, _garbleReprompts: 0,
      _criticalErrors: 0, _rosterBrainTurns: 0, _rosterSlicedTurns: 0, _langPinned: true,
      _rmsFloor: floor.slice(), _rmsSpeech: speech.slice(),
      _ended: false, isSpeaking: false, shouldEndCall: true,
      _clearSilenceTimers: () => {}, _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
      speak: async () => {}, ws: { readyState: 3, close: () => {} }, stt: null,
    });
    if (typeof h._langCode !== 'function') h._langCode = () => 'hi-IN';
    try { await h.endCall(); } catch (_) { /* teardown is not under test */ }
    // crm.logCall is fire-and-forget; endCall resolves before the row lands.
    for (let i = 0; i < 60 && !diag; i++) await new Promise((r) => setTimeout(r, 10));
    return diag && diag.audio;
  };

  // ── 1. it reaches the database at all ────────────────────────────────────
  await ok('THE GAP: an acoustic block is persisted with the call', async () => {
    const a = await persistedAudio({ floor: [38, 42, 40, 45], speech: [1900, 2100, 2000] });
    assert(a, 'diagnostics.audio is absent — the call record is acoustically blind again');
    for (const k of ['floorP50', 'speechP50', 'snrDb', 'floorSamples', 'speechTurns']) {
      assert(k in a, `diagnostics.audio is missing ${k}: ${JSON.stringify(Object.keys(a))}`);
    }
  });

  // ── 2. it SEPARATES a quiet room from a noisy one, which is the whole job ─
  await ok('a quiet room and a clinic waiting-room are far apart in dB', async () => {
    const quiet = await persistedAudio({ floor: [38, 42, 40, 45], speech: [1900, 2100, 2000] });
    const noisy = await persistedAudio({ floor: [380, 420, 400, 410], speech: [1900, 2100, 2000] });
    assert(quiet.snrDb > 28, `a quiet line should read high, got ${quiet.snrDb} dB`);
    assert(noisy.snrDb < 20, `a noisy line should read low, got ${noisy.snrDb} dB`);
    assert(quiet.snrDb - noisy.snrDb > 12,
      `only ${(quiet.snrDb - noisy.snrDb).toFixed(1)} dB between a quiet room and a waiting room — the metric cannot discriminate and is not worth keeping`);
    console.log(`      quiet ${quiet.snrDb} dB   noisy ${noisy.snrDb} dB`);
  });

  // ── 3. nulls, never a fabricated ratio ──────────────────────────────────
  await ok('a SILENT line reports null, never Infinity', async () => {
    const a = await persistedAudio({ floor: [0, 0, 0], speech: [1900, 2000] });
    assert.strictEqual(a.snrDb, null,
      `dividing by a zero floor printed ${a.snrDb} as though it were a measurement`);
    assert.strictEqual(a.floorP50, 0, 'the floor itself should still be reported honestly');
  });

  await ok('a call with no audio at all is all nulls, never zeros', async () => {
    const a = await persistedAudio({ floor: [], speech: [] });
    for (const k of ['floorP50', 'floorP90', 'speechP50', 'speechP10', 'snrDb']) {
      assert.strictEqual(a[k], null, `${k} is ${JSON.stringify(a[k])} — 0 dB is a claim, absence is not`);
    }
    assert.strictEqual(a.floorSamples, 0);
    assert.strictEqual(a.speechTurns, 0);
  });

  await ok('background with no speech cannot invent an SNR', async () => {
    const a = await persistedAudio({ floor: [40, 42], speech: [] });
    assert.strictEqual(a.snrDb, null, `computed an SNR from silence: ${a.snrDb}`);
    assert.strictEqual(a.floorP50, 42, 'the floor should still be recorded — it is the useful half here');
  });

  // ── 3b. THE COMPUTATION ITSELF, BEFORE JSON CAN HIDE IT ─────────────────
  // JSON.stringify(Infinity) is null. So a test that only reads the persisted
  // row cannot distinguish "guarded, so we wrote null" from "divided by zero,
  // got Infinity, and serialisation quietly tidied it away" — MEASURED: relaxing
  // the zero-floor guard to `floorP50 >= 0` left every persistence assertion
  // above green. The guard is only observable in the object, which is why
  // _audioSummary() is a named method instead of an inline IIFE.
  await ok('the SUMMARY object itself never yields Infinity or NaN', () => {
    const mk = (floor, speech) => {
      const h = Object.create(CallHandler.prototype);
      h._rmsFloor = floor; h._rmsSpeech = speech;
      return h._audioSummary();
    };
    for (const [floor, speech, label] of [
      [[0, 0, 0], [1900, 2000], 'zero floor'],
      [[], [1900], 'no floor samples'],
      [[40, 42], [], 'no speech turns'],
      [[], [], 'nothing at all'],
    ]) {
      const a = mk(floor, speech);
      assert.strictEqual(a.snrDb, null, `${label}: snrDb is ${a.snrDb}, must be null`);
      assert(Number.isFinite(a.snrDb) === false, `${label}: snrDb should not be a finite number`);
    }
    const good = mk([40, 40, 40], [2000, 2000]);
    assert(Number.isFinite(good.snrDb) && good.snrDb > 0,
      `a measurable call must still produce a real number, got ${good.snrDb}`);
  });

  // ── 4. the sampler itself: background only, and bounded ─────────────────
  await ok('the floor samples ONLY when nobody is speaking', async () => {
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, { callSid: 's', _rmsFloor: [], _rmsSpeech: [], _turnPeakRms: 0, _rmsCounter: 0, stt: {} });
    const chunk = Buffer.alloc(320).toString('base64');

    h._patientTalking = true; h.isSpeaking = false;
    for (let i = 0; i < 50; i++) h.handleAudio(chunk);
    assert.strictEqual(h._rmsFloor.length, 0, 'sampled the caller speaking as background');

    h._patientTalking = false; h.isSpeaking = true;
    for (let i = 0; i < 50; i++) h.handleAudio(chunk);
    assert.strictEqual(h._rmsFloor.length, 0, 'sampled Ritu speaking as background');

    h._patientTalking = false; h.isSpeaking = false;
    for (let i = 0; i < 50; i++) h.handleAudio(chunk);
    assert(h._rmsFloor.length > 0, 'never sampled the background at all');
  });

  await ok('a long call cannot grow the sampler without bound', async () => {
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, { callSid: 's', _rmsFloor: [], _rmsSpeech: [], _turnPeakRms: 0, _rmsCounter: 0,
      _patientTalking: false, isSpeaking: false, stt: {} });
    const chunk = Buffer.alloc(320).toString('base64');
    // ~20 minutes of audio at 20ms chunks.
    for (let i = 0; i < 60000; i++) h.handleAudio(chunk);
    assert(h._rmsFloor.length <= 400,
      `the floor sampler grew to ${h._rmsFloor.length} on a long call — this runs per audio chunk on a live line`);
  });

  // ── 5. THE FILTER THAT LEAVES NO TRACE ──────────────────────────────────
  // The silence-ghost drop discards a whole turn for being too quiet and, until
  // 2026-08-13, returned WITHOUT incrementing any counter. So a call that had
  // swallowed a soft "हाँ" reported dropped=0, and I read that as "nothing was
  // discarded" while reasoning about a caller's complaint. It only ever meant
  // "nothing was discarded by the four branches that bother to count".
  //
  // Its own counter, not the shared one: this is an AMPLITUDE decision and the
  // others are content decisions (echo, backchannel, blank). Rolled together
  // they cannot answer "did we throw away a quiet answer?", which is the only
  // question a noisy call asks.
  await ok('a ghost drop is COUNTED, with the loudness that caused it', async () => {
    let diag = null;
    db.pool.query = async (sql, params = []) => {
      if (/INSERT INTO calls/i.test(String(sql))) {
        const raw = params.find((p) => typeof p === 'string' && p.startsWith('{') && p.includes('deadAirP50'));
        if (raw) diag = JSON.parse(raw);
        return { rows: [{ id: 'c' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-ghost-fixture', callerPhone: '+918273500806', startTime: Date.now() - 20000,
      conversationHistory: [], transcript: [], _llmMs: [], _ttsMs: [], _sttMs: [],
      _turnLatencies: [], _fillerTurns: 0, _droppedUtterances: 0, _garbleReprompts: 0,
      _criticalErrors: 0, _rosterBrainTurns: 0, _rosterSlicedTurns: 0, _langPinned: true,
      _rmsFloor: [40, 42], _rmsSpeech: [2000], _ghostDrops: 2, _ghostDropRms: [88, 104],
      _ended: false, isSpeaking: false, shouldEndCall: true,
      _clearSilenceTimers: () => {}, _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
      speak: async () => {}, ws: { readyState: 3, close: () => {} }, stt: null,
    });
    try { await h.endCall(); } catch (_) { /* teardown */ }
    for (let i = 0; i < 60 && !diag; i++) await new Promise((r) => setTimeout(r, 10));
    assert(diag, 'no diagnostics written');
    assert.strictEqual(diag.ghostDrops, 2,
      `two turns were discarded for being quiet and the record says ${diag.ghostDrops}`);
    assert.deepStrictEqual(diag.ghostDropRms, [88, 104],
      'the loudness of each drop must travel with it — otherwise GHOST_RMS_FLOOR can only be argued from intuition');
    // The point of keeping them apart.
    assert.strictEqual(diag.dropped, 0,
      'a loudness drop was folded into the content-drop counter; the two answer different questions');
    // And the floor beside it is what makes a drop interpretable: 88 on a line
    // whose background is 42 is twice the noise — very likely real speech.
    assert(diag.audio.floorP50 < diag.ghostDropRms[0],
      'a drop below the measured noise floor would be a different story entirely');
  });

  // ── 5b. AND THE COUNTER IS DRIVEN, NOT HANDED IN ────────────────────────
  // The test above sets _ghostDrops on the fixture and asserts it is persisted.
  // MEASURED: deleting the increment from callHandler leaves it GREEN — it
  // proves the plumbing and nothing about the counting. That is the exact flaw
  // this file exists to catch, committed inside the file that catches it.
  // So: push a real quiet short utterance through _onTranscript and watch.
  await ok('THE COUNTING: a quiet short turn increments it for real', async () => {
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-ghost-drive', callerPhone: '+918273500806', startTime: Date.now(),
      conversationHistory: [], transcript: [], _turnLatencies: [], _llmMs: [], _ttsMs: [], _sttMs: [],
      _rmsFloor: [], _rmsSpeech: [], _ghostDrops: 0, _ghostDropRms: [],
      _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
      _lastRituText: '', _lastTurnPeakRms: 95,   // quiet: under the 120 floor
      isSpeaking: false, _ended: false, shouldEndCall: false,
      _processingChain: Promise.resolve(), _turnRoutedToModel: false,
      _pendingTranscript: '', _debounceTimer: null, _speculation: null, _completionSpec: null,
      _historyStage: 0, _readbackPending: null, _medRepeatPending: null,
      appointmentBooked: false, conversationPhase: 'reason', _fillerTurns: 0, _priorMeds: [],
      handleEmergency: async () => {}, speak: async () => {}, processIntent: async () => null,
      _clearSilenceTimers: () => {}, _startSilenceTimer: () => {}, _resetSilenceTimer: () => {},
      _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {}, _langCode: () => 'hi-IN',
      ws: { readyState: 1, send: () => {} }, stt: null,
    });
    try { await h._onTranscript('हाँ', { languageCode: 'hi-IN' }); } catch (_) { /* downstream is not under test */ }
    assert.strictEqual(h._ghostDrops, 1,
      `a short utterance at peak RMS 95 (floor 120) should have been dropped AND counted, got ${h._ghostDrops}`);
    assert.deepStrictEqual(h._ghostDropRms, [95],
      `the loudness must be recorded with the drop, got ${JSON.stringify(h._ghostDropRms)}`);
  });

  await ok('a LOUD short turn is not dropped and not counted', async () => {
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-loud', callerPhone: '+918273500806', startTime: Date.now(),
      conversationHistory: [], transcript: [], _turnLatencies: [], _llmMs: [], _ttsMs: [], _sttMs: [],
      _rmsFloor: [], _rmsSpeech: [], _ghostDrops: 0, _ghostDropRms: [],
      _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
      _lastRituText: '', _lastTurnPeakRms: 3000,  // clearly speech
      isSpeaking: false, _ended: false, shouldEndCall: false,
      _processingChain: Promise.resolve(), _turnRoutedToModel: false,
      _pendingTranscript: '', _debounceTimer: null, _speculation: null, _completionSpec: null,
      _historyStage: 0, _readbackPending: null, _medRepeatPending: null,
      appointmentBooked: false, conversationPhase: 'reason', _fillerTurns: 0, _priorMeds: [],
      handleEmergency: async () => {}, speak: async () => {}, processIntent: async () => null,
      _clearSilenceTimers: () => {}, _startSilenceTimer: () => {}, _resetSilenceTimer: () => {},
      _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {}, _langCode: () => 'hi-IN',
      ws: { readyState: 1, send: () => {} }, stt: null,
    });
    try { await h._onTranscript('हाँ', { languageCode: 'hi-IN' }); } catch (_) { /* downstream */ }
    assert.strictEqual(h._ghostDrops, 0,
      'a clearly-audible answer was discarded as a silence ghost');
  });

  db.pool.query = realQuery;
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
