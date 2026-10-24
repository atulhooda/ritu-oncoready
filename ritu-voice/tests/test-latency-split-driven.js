#!/usr/bin/env node
// ─── THE LATENCY NUMBERS, MEASURED BY RUNNING THE CODE ──────────────────────
// tests/test-latency-split.js asserts all of this by reading callHandler.js as
// a STRING and matching regexes against it:
//
//     const SRC = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'));
//     assert(DIAG.includes('deadAirP50'), 'diagnostics.latencySplit is missing…');
//
// An adversarial audit confirmed by execution that it stays fully green with the
// persistence write destroyed — the source still SAYS the right thing while
// nothing reaches the database. That is the same shape as the WhatsApp 500 that
// ran for 20 hours: a test asserted config.whatsapp.appSecret appeared in
// whatsapp.js, the code wrote config.meta.appSecret, and the grep passed.
//
// These numbers are not decoration. p50 dead air is a claim made to investors,
// and the split is what says WHICH stage to fix. A metric that is only ever
// asserted as source text can be silently disconnected from its own database.
//
// So this file DRIVES CallHandler to hang-up and reads the row that would be
// written. It complements the source-text file rather than replacing it: that
// one catches a rule deleted from the source, this one catches a rule that is
// present and unreachable.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';
// clinic() reads CLINIC_ID_UUID (config.js:242) and returns null without it, so
// the row would be rejected for a null clinic_id before the assertion is reached.
process.env.CLINIC_ID_UUID = process.env.CLINIC_ID_UUID || '11111111-1111-1111-1111-111111111111';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nLATENCY SPLIT — driven to the database, not read from the source\n');

(async () => {
  const { CallHandler } = require('../callHandler.js');
  const db = require('../db.js');

  // Capture the row the call would persist. logCall (crm.js) fans out to
  // db.logCallToDb; intercepting at pool.query means the real logCallToDb runs,
  // so the column mapping is under test rather than mocked away.
  const realQuery = db.pool.query.bind(db.pool);
  let written = [];
  const install = () => {
    written = [];
    db.pool.query = async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO calls/i.test(s)) {
        written.push({ sql: s, params });
        return { rows: [{ id: 'call-1' }], rowCount: 1 };
      }
      if (/FROM clinics/i.test(s)) return { rows: [{ id: 'clinic-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
  };

  // A handler that has already taken a few turns, then hangs up.
  const drive = async ({ llm = [400, 500, 600], tts = [200, 250], stt = [100, 120], turns = [900, 1300, 1800] } = {}) => {
    install();
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-latency', callerPhone: '+918273500806', callSource: 'exotel',
      startTime: Date.now() - 60000, conversationHistory: [], transcript: [
        { role: 'patient', text: 'सर दर्द' }, { role: 'ritu', text: 'कब से?' },
      ],
      _llmMs: llm.slice(), _ttsMs: tts.slice(), _sttMs: stt.slice(),
      _turnLatencies: turns.slice(), _fillerTurns: 0, _droppedUtterances: 0,
      _garbleReprompts: 0, _criticalErrors: 0, _rosterBrainTurns: 0, _rosterSlicedTurns: 0,
      _langPinned: true, callLanguage: 'hi-IN', languageDetected: 'hi-IN',
      _ended: false, isSpeaking: false, shouldEndCall: true,
      _clearSilenceTimers: () => {}, _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
      speak: async () => {}, ws: { readyState: 3, close: () => {} }, stt: null,
    });
    if (typeof h._langCode !== 'function') h._langCode = () => 'hi-IN';
    try { await h.endCall(); } catch (_) { /* the ws/teardown is not what is under test */ }
    // logCall is FIRE-AND-FORGET: endCall resolves before crm.logCall ->
    // db.logCallToDb has written anything. The first version of this file
    // asserted immediately and reported "nothing reached the calls table" for a
    // write that was merely still in flight — a harness bug that looks exactly
    // like the defect it was hunting. Wait for the row, briefly and explicitly.
    await settle();
    return h;
  };

  // Poll rather than sleep a fixed time: fast when it lands, still bounded.
  const settle = async (ms = 500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (written.some((w) => /INSERT INTO calls/i.test(w.sql))) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const diagnosticsWritten = () => {
    const row = written.find((w) => /INSERT INTO calls/i.test(w.sql));
    if (!row) return null;
    const raw = row.params.find((p) => typeof p === 'string' && /"diagnostics"|deadAir|latencySplit|endTrigger/.test(p));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };

  // ── 1. THE CLAIM THE SOURCE-TEXT FILE CANNOT CHECK ───────────────────────
  await ok('a finished call actually WRITES a row', async () => {
    await drive();
    assert(written.some((w) => /INSERT INTO calls/i.test(w.sql)),
      'the call ended and nothing reached the calls table');
  });

  await ok('THE GAP: the latency split reaches the DATABASE, not only the log', async () => {
    await drive();
    const d = diagnosticsWritten();
    assert(d, `no diagnostics JSON was passed to the INSERT: ${JSON.stringify(written.map((w) => w.params.length))}`);
    assert(d.deadAirP50 != null, `deadAirP50 is absent from the persisted row: ${JSON.stringify(Object.keys(d))}`);
    assert(d.deadAirP95 != null, 'deadAirP95 is absent from the persisted row');
  });

  await ok('the p50 is the real percentile of the turns, not a placeholder', async () => {
    await drive({ turns: [1000, 2000, 3000] });
    const d = diagnosticsWritten();
    assert(d && d.deadAirP50 >= 1000 && d.deadAirP50 <= 3000,
      `p50 of [1000,2000,3000] should sit inside the range, got ${d && d.deadAirP50}`);
    assert(d.deadAirP95 >= d.deadAirP50, `p95 (${d.deadAirP95}) below p50 (${d.deadAirP50})`);
  });

  // ── 2. nulls, never zeros — a zero is a claim, an absence is not ─────────
  await ok('a call with NO measurable turn writes null, never 0', async () => {
    await drive({ turns: [], llm: [], tts: [], stt: [] });
    const d = diagnosticsWritten();
    assert(d, 'no diagnostics written for a call with no turns');
    assert.strictEqual(d.deadAirP50, null, `expected null, got ${JSON.stringify(d.deadAirP50)} — 0 would read as "instant"`);
    assert.strictEqual(d.deadAirP95, null, `expected null, got ${JSON.stringify(d.deadAirP95)}`);
  });

  // ── 3. the language pin, which was wrong on the first six real calls ─────
  await ok('languagePinned distinguishes a PIN from a default', async () => {
    const h = await drive();
    const d = diagnosticsWritten();
    assert(d, 'no diagnostics');
    assert.strictEqual(d.languagePinned, 'hi-IN', `a pinned call reported ${JSON.stringify(d.languagePinned)}`);
    assert(d.languageEffective, 'languageEffective is absent — the pair is what makes the pin readable');
    void h;
  });

  await ok('an UNPINNED call reports null, not the default it fell back to', async () => {
    install();
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, {
      callSid: 'sid-unpinned', callerPhone: '+918273500806', startTime: Date.now() - 1000,
      conversationHistory: [], transcript: [], _llmMs: [], _ttsMs: [], _sttMs: [],
      _turnLatencies: [], _fillerTurns: 0, _droppedUtterances: 0, _garbleReprompts: 0,
      _criticalErrors: 0, _rosterBrainTurns: 0, _rosterSlicedTurns: 0,
      _langPinned: false, _ended: false, isSpeaking: false, shouldEndCall: true,
      _clearSilenceTimers: () => {}, _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
      speak: async () => {}, ws: { readyState: 3, close: () => {} }, stt: null,
    });
    if (typeof h._langCode !== 'function') h._langCode = () => 'hi-IN';
    try { await h.endCall(); } catch (_) { /* teardown */ }
    await settle();
    const d = diagnosticsWritten();
    assert(d, 'no diagnostics');
    assert.strictEqual(d.languagePinned, null,
      `an unpinned call must not claim a pin — reporting ${JSON.stringify(d.languagePinned)} is how six real calls said "unpinned" wrongly, in reverse`);
  });

  // ── 4. observation must never break a call ───────────────────────────────
  await ok('a THROWING percentile cannot stop the call ending', async () => {
    install();
    const proto = Object.getPrototypeOf(Object.create(CallHandler.prototype));
    const realPct = proto._percentile;
    proto._percentile = () => { throw new Error('boom'); };
    try {
      const h = await drive();
      assert(h._ended, 'the call did not finish when a diagnostic threw — observation broke the call');
    } finally {
      if (realPct) proto._percentile = realPct;
    }
  });

  db.pool.query = realQuery;
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
