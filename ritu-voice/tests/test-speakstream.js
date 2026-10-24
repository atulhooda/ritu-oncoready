#!/usr/bin/env node
// Deterministic orchestration tests for CallHandler.speakStream().
// Stubs TTS + mark/audio sends on the instance so we test the control flow
// (sentence ordering, single closing mark, gen-ID + emergency interrupts,
// fallback signalling) without real Sarvam TTS or a live LLM.

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const CallHandler = require('../callHandler');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeHandler() {
  const ws = { readyState: 1, send: () => {} };
  const h = new CallHandler('test_call', '+919876543210', ws, 'test', false);
  // Stub audio/mark plumbing — record instead of doing real I/O.
  h._spoken = [];
  h._marks = [];
  h._speakSentence = async (t) => { h._spoken.push(t); };
  h._sendMark = (name = 'ritu_done') => { h._marks.push(name); };
  h._sendSilence = () => {};
  h._flushStreamingTail = () => {};
  h._sendStreamingAudio = () => {};
  h._clearAudio = () => {};
  return h;
}

async function* genNormal() {
  yield { kind: 'sentence', text: 'Ji bilkul.', ttftMs: 700 };
  yield { kind: 'sentence', text: 'Aapko kya takleef hai?' };
  yield { kind: 'done', result: { text: 'Ji bilkul. Aapko kya takleef hai?', endCall: false, patientName: null, reason: null, emergency: false } };
}
async function* genEndCall() {
  yield { kind: 'sentence', text: 'Theek hai, dhanyawad!' };
  yield { kind: 'done', result: { text: 'Theek hai, dhanyawad!', endCall: true } };
}
async function* genFallbackPreSpeech() {
  yield { kind: 'fallback-required', reason: 'booking_intent_detected_pre_speech' };
}
async function* genBargeIn(h) {
  yield { kind: 'sentence', text: 'Ji bilkul.' };
  // Simulate barge-in: bump generation id mid-stream.
  h._generationId++;
  yield { kind: 'sentence', text: 'Yeh nahi bolna chahiye.' };
  yield { kind: 'done', result: { text: 'x' } };
}
async function* genEmergencyMid(h) {
  yield { kind: 'sentence', text: 'Ji bilkul.' };
  h._emergencyTriggered = true;
  yield { kind: 'sentence', text: 'Yeh bhi nahi bolna chahiye.' };
  yield { kind: 'done', result: { text: 'x' } };
}

async function main() {
  // ─── 1. Normal: both sentences spoken, single ritu_done mark ──────────
  console.log('\n[1] Normal two-sentence turn');
  {
    const h = makeHandler();
    const myGen = h._generationId;
    const out = await h.speakStream(genNormal(), myGen);
    assert('spoke both sentences in order',
      JSON.stringify(h._spoken) === JSON.stringify(['Ji bilkul.', 'Aapko kya takleef hai?']), JSON.stringify(h._spoken));
    assert('exactly one closing mark', h._marks.length === 1, JSON.stringify(h._marks));
    assert('mark is ritu_done', h._marks[0] === 'ritu_done');
    assert('returned result', out.result && out.result.text.includes('takleef'));
    assert('fullSpokenText assembled', out.fullSpokenText === 'Ji bilkul. Aapko kya takleef hai?');
    assert('_lastRituText is cumulative', h._lastRituText === 'Ji bilkul. Aapko kya takleef hai?');
  }

  // ─── 2. endCall → ritu_end_call mark ──────────────────────────────────
  console.log('\n[2] endCall turn → ritu_end_call');
  {
    const h = makeHandler();
    const out = await h.speakStream(genEndCall(), h._generationId);
    assert('mark is ritu_end_call', h._marks[0] === 'ritu_end_call', JSON.stringify(h._marks));
    assert('result.endCall true', out.result.endCall === true);
  }

  // ─── 3. fallback pre-speech: no audio, no mark ────────────────────────
  console.log('\n[3] Booking-leak pre-speech → fallback, no mark');
  {
    const h = makeHandler();
    const out = await h.speakStream(genFallbackPreSpeech(), h._generationId);
    assert('fallback signalled', out.fallback === true);
    assert('reason propagated', /booking_intent/.test(out.reason));
    assert('nothing spoken', h._spoken.length === 0);
    assert('no mark emitted', h._marks.length === 0);
  }

  // ─── 4. barge-in mid-stream → discarded, no closing mark ──────────────
  console.log('\n[4] Barge-in mid-stream → discarded');
  {
    const h = makeHandler();
    const myGen = h._generationId;
    const out = await h.speakStream(genBargeIn(h), myGen);
    assert('discarded', out.discarded === true);
    assert('only first sentence spoke before barge-in', JSON.stringify(h._spoken) === JSON.stringify(['Ji bilkul.']), JSON.stringify(h._spoken));
    assert('no closing mark after barge-in', h._marks.length === 0, JSON.stringify(h._marks));
  }

  // ─── 5. emergency latch mid-stream → discarded ────────────────────────
  console.log('\n[5] Emergency latch mid-stream → discarded');
  {
    const h = makeHandler();
    const out = await h.speakStream(genEmergencyMid(h), h._generationId);
    assert('discarded', out.discarded === true);
    assert('only first sentence spoke before latch', JSON.stringify(h._spoken) === JSON.stringify(['Ji bilkul.']), JSON.stringify(h._spoken));
    assert('no closing mark after latch', h._marks.length === 0);
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (fail > 0) process.exit(1);
  console.log('✓ All speakStream orchestration tests passing.');
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
