'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// greetingTakes.js — the fixed greeting is rendered N times; the briskest wins
//
// MEASURED 2026-09-14 (Sarvam bulbul:v3, pooja, pace 1.05, temperature 0.8,
// 8 kHz): the SAME 84-character Gujarati greeting rendered 8.8 s, 9.7 s and
// 9.3 s in three consecutive draws, and the live boot cache had drawn 12.1 s
// of the previous wording (10.8–12.3 s across draws). Run-to-run variance is
// larger than what the pace knob moves, and lowering temperature did NOT
// tighten it (0.3 → 9.4–10.4 s, 0.5 → 9.3–10.6 s). So the intro's tempo was
// a lottery drawn once per boot. Keeping the briskest of three draws removes
// the slow tail at the founder's chosen pace, voice and temperature.
//
// This is the whole mechanism: run the synth `takes` times in parallel, drop
// failures, keep the shortest buffer. A single failure never costs the boot;
// only every take failing does. PCM16 at 8 kHz is 16000 bytes per second.
// ═══════════════════════════════════════════════════════════════════════════

const BYTES_PER_SECOND = 16000;
const MAX_TAKES = 6;

function clampTakes(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(MAX_TAKES, v);
}

async function renderBriskest({ synth, takes = 3 }) {
  const n = clampTakes(takes);
  const results = await Promise.allSettled(Array.from({ length: n }, () => synth()));
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.length > 0).map((r) => r.value);
  if (!ok.length) {
    const failed = results.find((r) => r.status === 'rejected');
    throw (failed && failed.reason) || new Error('greeting: no take rendered');
  }
  const best = ok.reduce((a, b) => (b.length < a.length ? b : a));
  return {
    audio: best,
    seconds: ok.map((b) => b.length / BYTES_PER_SECOND),
    keptSeconds: best.length / BYTES_PER_SECOND,
    failed: results.length - ok.length,
  };
}

module.exports = { renderBriskest, clampTakes, BYTES_PER_SECOND, MAX_TAKES };
