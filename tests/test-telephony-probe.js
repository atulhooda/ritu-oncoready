#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE PROBE MUST NOT LIE, AND MUST NOT COST ANYTHING.
//
// It runs on every inbound audio frame of every live call — 50 frames a second,
// per concurrent call. A probe that adds latency to a latency measurement is
// worse than no probe, and one that reports a plausible number from absent data
// is worse still: we would "know" the telephony leg and be wrong.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { TelephonyProbe } = require('../telephonyProbe');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n      ${e.message}`); fail++; } };

check('absent timestamp field → reports null, never a guess', () => {
  const p = new TelephonyProbe('c1');
  for (let i = 0; i < 200; i++) p.onFrame({ payload: 'x' });   // Exotel sends no timestamp
  const s = p.summary();
  assert.strictEqual(s.uplinkDriftMedianMs, null, 'invented a drift from nothing');
  assert.strictEqual(s.uplinkSamples, 0);
  assert.strictEqual(s.frames, 200, 'frames must still be counted');
});

check('a timestamp field IS used when present', () => {
  const p = new TelephonyProbe('c2');
  for (let i = 0; i < 200; i++) p.onFrame({ payload: 'x', timestamp: i * 20 });
  const s = p.summary();
  assert.ok(s.uplinkSamples > 0, 'timestamps present but nothing sampled');
  assert.ok(Number.isFinite(s.uplinkDriftMedianMs), 'no median produced');
});

check('mark residual subtracts the audio it had to play', () => {
  const p = new TelephonyProbe('c3');
  p.markSent('ritu_done', 1000);
  // Pretend the echo came back 1000ms of audio + ~80ms of network later.
  const rec = p._pendingMarks.get('ritu_done');
  rec.at = Date.now() - 1080;
  p.markEchoed('ritu_done');
  const s = p.summary();
  assert.ok(s.markResidualMedianMs >= 60 && s.markResidualMedianMs <= 120,
    `residual should be ~80ms of network, got ${s.markResidualMedianMs}`);
});

check('a NEGATIVE residual is discarded, not averaged in', () => {
  const p = new TelephonyProbe('c4');
  p.markSent('m', 5000);                       // we over-estimated the audio
  p.markEchoed('m');                            // echo arrives "before" it finished
  assert.strictEqual(p.summary().markSamples, 0,
    'a physically impossible residual was kept — it would flatter the number');
});

check('an echo with no matching send is ignored', () => {
  const p = new TelephonyProbe('c5');
  p.markEchoed('never_sent');
  assert.strictEqual(p.summary().markSamples, 0);
});

check('BOUNDED — a long call cannot grow memory without limit', () => {
  const p = new TelephonyProbe('c6');
  for (let i = 0; i < 100000; i++) p.onFrame({ payload: 'x', timestamp: i * 20 });
  assert.ok(p.uplinkDrift.length <= 400, `unbounded: ${p.uplinkDrift.length} samples retained`);
});

check('CHEAP — 100k frames well under a millisecond of overhead each', () => {
  const p = new TelephonyProbe('c7');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) p.onFrame({ payload: 'x', timestamp: i * 20 });
  const perFrameUs = Number(process.hrtime.bigint() - t0) / 1000 / 100000;
  assert.ok(perFrameUs < 5, `${perFrameUs.toFixed(2)}µs per frame is too much in the audio path`);
});

check('CANNOT THROW on malformed frames', () => {
  const p = new TelephonyProbe('c8');
  for (const junk of [null, undefined, 0, '', [], { timestamp: 'soon' }, { timestamp: NaN }]) {
    p.onFrame(junk);
  }
  assert.ok(p.summary());
});

check('MUTATION: the probe measures at all', () => {
  const p = new TelephonyProbe('c9');
  for (let i = 0; i < 100; i++) p.onFrame({ payload: 'x', timestamp: 0 });  // no advance → drift grows
  const s = p.summary();
  assert.ok(s.uplinkSamples > 0 && s.uplinkDriftSpreadMs !== null,
    'nothing recorded even with perfect input — every case above is vacuous');
});

// ─── REGRESSION: the first live call recorded ZERO mark samples ──────────────
// 2026-08-05. Eight marks were echoed and every one was discarded. markSent()
// was stamped when the MARK went out, but ~4s of audio is written to the socket
// in ~200ms and Exotel echoes only when PLAYBACK ends — so elapsed-since-mark
// was always SHORTER than the audio it represented, every residual was
// negative, and the negative guard threw them all away.
//
// The tell was indistinguishable from "no echo arrived", which is why it cost a
// real call to notice. Negatives are counted now.
{
  const { TelephonyProbe } = require('../telephonyProbe');
  const t0 = Date.now();
  const realDateNow = Date.now;

  const good = new TelephonyProbe('regression');
  good.markSent('m', 4000, t0);                    // stamp the FIRST BYTE
  Date.now = () => t0 + 4075;                      // playback ends +75ms network
  good.markEchoed('m');
  Date.now = realDateNow;
  assert.strictEqual(good.summary().markSamples, 1, 'the real-world shape must be captured');
  assert.strictEqual(good.summary().markResidualMedianMs, 75, 'residual must be the network, 75ms');
  assert.strictEqual(good.summary().markNegativeResiduals, 0);

  const bad = new TelephonyProbe('regression-old');
  bad.markSent('m', 4000, t0 + 200);               // the OLD stamp: mark-send time
  Date.now = () => t0 + 4075;
  bad.markEchoed('m');
  Date.now = realDateNow;
  assert.strictEqual(bad.summary().markSamples, 0, 'fixture no longer reproduces the bug');
  assert.strictEqual(bad.summary().markNegativeResiduals, 1,
    'a discarded negative must be COUNTED — n=0 and "nothing arrived" looked identical and cost a call');

  console.log('  ✓ REGRESSION: mark residual is measured from first-byte-out, and negatives are counted');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

