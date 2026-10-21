#!/usr/bin/env node
// ─── THE LATENCY SPLIT, ACCUMULATED RATHER THAN GREPPED ─────────────────────
// tests/test-latency-split.js proves these properties by reading callHandler.js
// as text: it greps for `this._sttMs.push(`, for the ABSENCE of a return inside
// the LATENCY_TRACE guard, and for the byte offset of one statement relative to
// another. An outside sweep flagged seventeen such assertions in that one file.
//
// Every one of them can be true while the numbers are wrong, which is the same
// shape as the WhatsApp signature test that proved by indexOf that the check
// ran before the database write, and passed for twenty hours while the handler
// threw on its first line.
//
// _markFirstAudio() is self-contained: set the turn stamps, call it, read the
// accumulators. So these run it.
//
// THE PROPERTY THAT MATTERS MOST is that LATENCY_TRACE gates PRINTING and never
// MEASURING. It used to `return` early, which was harmless while the split was
// only a console.log and silently empties a persisted metric now that it is
// not. A grep for the absence of `return` cannot tell you the arrays filled;
// setting the env var and reading them can.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const CallHandler = require('../callHandler.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

function handler() {
  const h = new CallHandler('lat_test', '+919876543210', { readyState: 1, send: () => {} }, 'test', false);
  h._sttMs = []; h._llmMs = []; h._ttsMs = []; h._turnLatencies = []; h._fillerTurns = 0;
  return h;
}

// One turn, with the four stamps the real pipeline sets.
function turn(h, { eos, dispatch, replyReady, firstAudio, filler = false }) {
  h._turnT = { eos, dispatch, replyReady, firstAudio: null };
  h._fillerPlayedThisTurn = filler;
  const realNow = Date.now;
  Date.now = () => firstAudio;              // _markFirstAudio stamps firstAudio itself
  try { h._markFirstAudio(); } finally { Date.now = realNow; }
}

const quiet = (fn) => {
  const real = console.log; console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

console.log('\nLATENCY SPLIT — accumulated, not grepped\n');

ok('a normal turn accumulates all three stages with the right values', () => {
  const h = handler();
  // eos=1000, dispatch=1300 (stt+debounce 300), replyReady=1800 (llm 500),
  // firstAudio=2050 (tts 250). Total dead air 1050.
  quiet(() => turn(h, { eos: 1000, dispatch: 1300, replyReady: 1800, firstAudio: 2050 }));
  assert.deepStrictEqual(h._sttMs, [300], 'stt+debounce not accumulated');
  assert.deepStrictEqual(h._llmMs, [500], 'llm+tool not accumulated');
  assert.deepStrictEqual(h._ttsMs, [250], 'tts-firstbyte not accumulated');
  assert.deepStrictEqual(h._turnLatencies, [1050], 'total dead air not accumulated');
});

ok('THE PROPERTY: LATENCY_TRACE=false silences the log and still MEASURES', () => {
  // The regression this guards: an early `return` inside the trace guard. That
  // would leave every array empty while the suite row still reported a number,
  // and the flag is off in production more often than on.
  const saved = process.env.LATENCY_TRACE;
  process.env.LATENCY_TRACE = 'false';
  try {
    const h = handler();
    let printed = 0;
    const real = console.log; console.log = () => { printed++; };
    try { turn(h, { eos: 0, dispatch: 200, replyReady: 700, firstAudio: 900 }); }
    finally { console.log = real; }
    assert.strictEqual(printed, 0, 'LATENCY_TRACE=false still printed');
    assert.deepStrictEqual(h._sttMs, [200], 'the trace flag silently disabled MEASUREMENT');
    assert.deepStrictEqual(h._llmMs, [500], 'the trace flag silently disabled MEASUREMENT');
    assert.deepStrictEqual(h._ttsMs, [200], 'the trace flag silently disabled MEASUREMENT');
  } finally {
    if (saved === undefined) delete process.env.LATENCY_TRACE; else process.env.LATENCY_TRACE = saved;
  }
});

ok('a FILLER turn is counted and kept OUT of the llm/tts split', () => {
  // First audio is the filler, which plays before the reply exists, so the
  // split does not describe that turn. Letting it in would make llm look fast.
  const h = handler();
  quiet(() => turn(h, { eos: 0, dispatch: 200, replyReady: 700, firstAudio: 900, filler: true }));
  assert.strictEqual(h._fillerTurns, 1, 'the filler turn was not counted');
  assert.deepStrictEqual(h._sttMs, [], 'a filler turn polluted the stt split');
  assert.deepStrictEqual(h._llmMs, [], 'a filler turn polluted the llm split');
  assert.deepStrictEqual(h._ttsMs, [], 'a filler turn polluted the tts split');
  assert.deepStrictEqual(h._turnLatencies, [900], 'the filler turn still owes a total');
});

ok('a turn with no replyReady records stt only — never a fabricated zero', () => {
  // llmTool and ttsFirstByte are null when replyReady never landed. Pushing 0
  // would report an instant LLM, which is worse than reporting nothing.
  const h = handler();
  quiet(() => turn(h, { eos: 0, dispatch: 250, replyReady: null, firstAudio: 800 }));
  assert.deepStrictEqual(h._sttMs, [250]);
  assert.deepStrictEqual(h._llmMs, [], 'a missing replyReady was recorded as 0ms of LLM');
  assert.deepStrictEqual(h._ttsMs, [], 'a missing replyReady was recorded as 0ms of TTS');
});

ok('disagreeing clocks are dropped, not recorded as negative time', () => {
  const h = handler();
  quiet(() => turn(h, { eos: 5000, dispatch: 4000, replyReady: 4500, firstAudio: 4800 }));
  assert.deepStrictEqual(h._sttMs, [], 'a negative stage entered the metric');
  assert(h._turnLatencies.every((v) => v >= 0), 'a negative total entered the metric');
});

ok('the same turn cannot be counted twice', () => {
  // _markFirstAudio is called from the audio path and can fire more than once.
  const h = handler();
  quiet(() => {
    turn(h, { eos: 0, dispatch: 200, replyReady: 700, firstAudio: 900 });
    h._markFirstAudio();                    // second call, firstAudio already set
    h._markFirstAudio();
  });
  assert.deepStrictEqual(h._sttMs, [200], 'a turn was double-counted');
  assert.strictEqual(h._turnLatencies.length, 1, 'a turn was double-counted');
});

ok('many turns accumulate independently', () => {
  const h = handler();
  quiet(() => {
    turn(h, { eos: 0, dispatch: 100, replyReady: 600, firstAudio: 800 });
    turn(h, { eos: 1000, dispatch: 1300, replyReady: 1900, firstAudio: 2200 });
    turn(h, { eos: 3000, dispatch: 3200, replyReady: 3900, firstAudio: 4100, filler: true });
  });
  assert.deepStrictEqual(h._sttMs, [100, 300], 'per-turn stt accumulation is wrong');
  assert.deepStrictEqual(h._llmMs, [500, 600], 'per-turn llm accumulation is wrong');
  assert.deepStrictEqual(h._ttsMs, [200, 300], 'per-turn tts accumulation is wrong');
  assert.strictEqual(h._fillerTurns, 1);
  assert.strictEqual(h._turnLatencies.length, 3, 'every turn owes a total, filler included');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
