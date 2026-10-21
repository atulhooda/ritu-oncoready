#!/usr/bin/env node
// ─── A SPECULATION THE TURN ORPHANED ────────────────────────────────────────
// MEASURED, call 3312d865, 2026-08-07:
//
//   spec=3/1claimed/2cancelled(33%) specwhy={"superseded by new transcript":2}
//
// That reason blamed the patient for speaking again. The timings said
// otherwise: the two cancellations landed 7363ms and 8520ms after their
// speculations started, while the deterministic pre-visit-history branch had
// answered those turns roughly 130ms in. The speculation was pointless within
// a seventh of a second and nothing said so — only processIntent claims or
// cancels, and a deterministic turn returns before reaching it. A full Gemini
// call (~3900 input tokens) ran to completion, was discarded, and lingered in
// _speculation until the next turn swept it up.
//
// fireTurn has THREE deterministic exits — sensitive-data guard, medical-advice
// guard, pre-visit history — and every one leaked, so the reap lives at the one
// point they all pass through rather than being bolted onto each.
//
// This file DRIVES _onTranscript. The last two defects I shipped — a
// ReferenceError in call teardown and a TypeError on every inbound webhook —
// were both invisible to tests that read source text and compared positions.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const CallHandler = require('../callHandler');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// Stand-in with the surface the reaper and both claim paths actually use.
const fakeSpec = (transcript) => ({
  transcript, cancelled: false, startedAt: Date.now(),
  genId: 0, expectedHistoryLen: 0, lastEntryRef: null,
  cancel() { this.cancelled = true; },
});

function makeHandler() {
  const ws = { readyState: 1, send: () => {} };
  const h = new CallHandler('reap_test', '+919876543210', ws, 'test', false);
  h.speak = async () => {};
  h._speakSentence = async () => {};
  h._sendMark = () => {};
  h._sendSilence = () => {};
  h._maybeStartSpeculation = () => {};      // we install the speculation by hand
  h.processIntent = async () => { h._reachedModel = true; };
  h._echoBlankingUntil = 0;
  h._patientTalking = false;
  h._reachedModel = false;
  return h;
}

// Run one transcript through the REAL debounce path, capturing the timer so the
// turn fires synchronously instead of after 150–900ms of wall clock.
async function turn(h, text) {
  const captured = [];
  const real = global.setTimeout;
  global.setTimeout = (fn, ms) => { captured.push(fn); return { __fake: true, ms }; };
  try {
    await h._onTranscript(text, {});
  } finally { global.setTimeout = real; }
  // Fire whatever the debounce scheduled (hold-extend may schedule again).
  let guard = 0;
  while (captured.length && guard++ < 10) {
    const fn = captured.shift();
    const real2 = global.setTimeout;
    global.setTimeout = (f) => { captured.push(f); return { __fake: true }; };
    try { fn(); } finally { global.setTimeout = real2; }
  }
  await h._processingChain;
}

console.log('\nSPECULATION REAPING — a real handler, a real turn\n');

(async () => {

  // ── the leak ─────────────────────────────────────────────────────────────
  {
    const h = makeHandler();
    h._maybeHistoryQuestion = () => 'आपको यह कब से हो रहा है?';   // deterministic exit
    const spec = fakeSpec('मुझे सिर दर्द है');
    h._speculation = spec;
    await turn(h, 'मुझे सिर दर्द है');
    ok('THE LEAK: a deterministically-answered turn cancels the speculation it orphaned', () => {
      assert.strictEqual(h._reachedModel, false, 'the turn was supposed to answer without the model');
      assert.strictEqual(spec.cancelled, true,
        'the speculation is still in flight — a full LLM call burns and is discarded');
      assert.strictEqual(h._speculation, null, 'the orphan is still parked in _speculation');
      assert.strictEqual(h._specCancelled, 1, 'the waste was not counted');
      assert.deepStrictEqual(Object.keys(h._specCancelReasons), ['turn answered deterministically'],
        `the reason still misattributes the cancel: ${JSON.stringify(h._specCancelReasons)}`);
    });
  }

  // ── the completion twin, which had no counters at all ─────────────────────
  {
    const h = makeHandler();
    h._maybeHistoryQuestion = () => 'कोई दवाई चल रही है?';
    const cspec = fakeSpec('हाँ बुखार है');
    h._completionSpec = cspec;
    await turn(h, 'हाँ बुखार है');
    ok('the COMPLETION speculation is reaped too, and counted', () => {
      assert.strictEqual(cspec.cancelled, true, 'the completion speculation leaked');
      assert.strictEqual(h._completionSpec, null);
      assert.strictEqual(h._specCancelled, 1,
        'completion cancels still touch no counter — spec= under-reports the whole kind');
    });
  }

  // ── it must NOT eat a speculation the turn is about to use ────────────────
  {
    const h = makeHandler();
    h._maybeHistoryQuestion = () => null;      // routes to the model
    const spec = fakeSpec('मुझे appointment चाहिए');
    h._speculation = spec;
    await turn(h, 'मुझे appointment चाहिए');
    ok('a turn that DOES route to the model keeps its speculation', () => {
      assert.strictEqual(h._reachedModel, true, 'this turn should have reached processIntent');
      assert.strictEqual(spec.cancelled, false,
        'the reaper cancelled a speculation the turn was about to claim — the feature is dead');
      assert.strictEqual(h._specCancelled, 0);
    });
  }

  // ── it must not eat a NEWER turn's speculation ────────────────────────────
  {
    const h = makeHandler();
    h._maybeHistoryQuestion = () => 'कब से?';
    const newer = fakeSpec('a different, newer transcript');
    h._speculation = newer;
    await turn(h, 'मुझे सिर दर्द है');
    ok('a speculation belonging to a DIFFERENT transcript is left alone', () => {
      assert.strictEqual(newer.cancelled, false,
        "the reaper killed a newer turn's speculation — same rule _takeSpeculation follows");
      assert.strictEqual(h._speculation, newer);
    });
  }

  // ── hold-extend must not reap: the same transcript may still dispatch ─────
  {
    const h = makeHandler();
    h._patientTalking = true;                  // caller still mid-utterance
    h._maybeHistoryQuestion = () => null;
    const spec = fakeSpec('मुझे सिर');
    h._speculation = spec;
    const real = global.setTimeout;
    const captured = [];
    global.setTimeout = (fn) => { captured.push(fn); return { __fake: true }; };
    try { await h._onTranscript('मुझे सिर', {}); captured.shift()(); }
    finally { global.setTimeout = real; }
    ok('HOLD-EXTEND does not reap — the caller is still speaking', () => {
      assert.strictEqual(spec.cancelled, false,
        'extending the hold cancelled a speculation that is still perfectly valid');
    });
  }

  // ── a turn with no speculation must not inflate the counter ───────────────
  {
    const h = makeHandler();
    h._maybeHistoryQuestion = () => 'कब से?';
    await turn(h, 'मुझे सिर दर्द है');
    ok('a deterministic turn with NO speculation counts no cancel', () => {
      assert.strictEqual(h._specCancelled, 0,
        'the reaper is counting cancels for speculations that never existed');
    });
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
