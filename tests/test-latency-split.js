// ─── THE LATENCY SPLIT ──────────────────────────────────────────────────────
// MEASURED 2026-08-06 from the first six real calls that ever carried probe
// data: dead-air p50 ~1.3s and p95 up to 2.0s, against a ~1.0-1.2s target. The
// telephony probe accounted for only 63ms of that, so ~1.28s was unattributed.
//
// The stage timings EXISTED — eos, dispatch, replyReady, firstAudio are all
// stamped per turn, and the split was computed and printed. It was then thrown
// away, and console.log lives on a Railway instance nobody reads after a call
// has ended. "We measure it" and "we can answer it later" are different claims.
//
// This file guards three things that would each silently produce a metric that
// looks fine and means nothing.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');

// ─── NO FIXED WINDOWS. THREE TIMES NOW. ────────────────────────────────────
// 1. test-speculative-translit.js grepped the first 1200 chars of the brand
//    block; documenting a rejected lever pushed the guard past the cutoff and
//    the test failed while the guard was intact.
// 2. this file asserted latencySplit inside 2500 chars; adding symptomDrift and
//    rosterSlice ahead of it broke it the same day.
// 3. and again, at 3000 chars, when speculation and garbleSpoke were added
//    ahead of rosterSlice.
// Every one of those was a NEIGHBOURING field growing — nothing to do with the
// thing being asserted. So the window is gone: presence is presence, wherever
// in the block it sits.
const DIAG = SRC.slice(SRC.indexOf('diagnostics: {'));
const inDiagnostics = (field) => new RegExp(`${field}:\\s*[\\{a-zA-Z_]`).test(DIAG);

console.log('\nLATENCY SPLIT — a stage timing you cannot query is not a measurement\n');

ok('the three stages are ACCUMULATED, not just printed', () => {
  for (const field of ['_sttMs', '_llmMs', '_ttsMs']) {
    assert(new RegExp(`this\\.${field}\\.push\\(`).test(SRC), `${field} is never pushed to`);
    assert(new RegExp(`this\\.${field} = \\[\\]`).test(SRC), `${field} is never initialised`);
  }
});

ok('the split reaches the DATABASE, not only the log', () => {
  // diagnostics is the only per-call structure that is persisted. A stage
  // timing that stops at console.log cannot answer a question tomorrow.
  // Locate by POSITION, not a fixed window. This assertion was written with
  // `.slice(0, 2500)` and broke the same day, when symptomDrift and rosterSlice
  // were added ahead of latencySplit and pushed it past the cutoff — the
  // identical failure test-speculative-translit.js had hours earlier with a
  // 1200-char window. A check that breaks when a NEIGHBOURING field grows is
  // measuring file layout, not behaviour.
  assert(inDiagnostics('latencySplit'), 'latencySplit is not in diagnostics');
  for (const k of ['sttDebounceP50', 'llmToolP50', 'ttsFirstByteP50', 'splitTurns', 'fillerMaskedTurns']) {
    assert(DIAG.includes(k), `diagnostics.latencySplit is missing ${k}`);
  }
});

// ── the trap this file mostly exists for ────────────────────────────────────
ok('MUTATION: LATENCY_TRACE must gate PRINTING, never MEASURING', () => {
  // _markFirstAudio used to `return` early when LATENCY_TRACE=false. That was
  // harmless while the split was only a console.log. The moment the split
  // became a persisted metric, that early return would have silently emptied
  // it for anyone who turned the trace off — a row that passes forever because
  // it measures nothing, which is the exact failure the codemix corpus was
  // built to catch on the capture side.
  const fn = SRC.slice(SRC.indexOf('_markFirstAudio()'), SRC.indexOf('_percentile(arr, p)'));
  assert(fn.length > 200, 'could not isolate _markFirstAudio');
  assert(!/LATENCY_TRACE === 'false'\)\s*return;/.test(fn),
    'an early return on LATENCY_TRACE is back — the split will silently be empty when tracing is off');
  // and the pushes must sit where the flag cannot reach them
  const pushAt = fn.indexOf('this._sttMs.push(');
  const guardAt = fn.indexOf("LATENCY_TRACE !== 'false'");
  assert(pushAt > 0, 'the stt push vanished from _markFirstAudio');
  assert(pushAt < fn.lastIndexOf("LATENCY_TRACE !== 'false'"),
    'accumulation must not sit inside a print guard');
  void guardAt;
});

ok('filler turns are COUNTED, not folded into the split', () => {
  // When a filler plays, first-audio is the filler, so the llm/tts split is
  // meaningless for that turn — and dead-air reads BETTER than the real wait,
  // because the caller heard something, just not the answer. Counting them is
  // what stops p50 flattering the system.
  const fn = SRC.slice(SRC.indexOf('_markFirstAudio()'), SRC.indexOf('_percentile(arr, p)'));
  const fillerBranch = fn.slice(fn.indexOf('if (this._fillerPlayedThisTurn)'), fn.indexOf('} else {'));
  assert(/this\._fillerTurns\+\+/.test(fillerBranch), 'filler turns are not counted');
  assert(!/this\._llmMs\.push/.test(fillerBranch), 'a filler turn is polluting the llm split');
  assert(!/this\._ttsMs\.push/.test(fillerBranch), 'a filler turn is polluting the tts split');
});

// ── the bug the first six real calls exposed ────────────────────────────────
ok('languagePinned reads _langCode(), never the raw field', () => {
  // MEASURED: languagePinned was null on all six calls while calls.language
  // said "Hindi", because it read this.callLanguage directly — and the field's
  // own comment says the single source is _langCode(), never the raw field. It
  // reported "unpinned" for pinned calls and, worse, could not distinguish a
  // real PIN from _langCode()'s DEFAULT.
  const diag = SRC.slice(SRC.indexOf('diagnostics: {'));
  const line = diag.slice(diag.indexOf('languagePinned:'), diag.indexOf('languagePinned:') + 120);
  assert(!/languagePinned:\s*this\.callLanguage/.test(line),
    'languagePinned is reading the raw field again — it will report null on pinned calls');
  assert(/_langPinned/.test(line), 'languagePinned no longer distinguishes a pin from a default');
  assert(diag.includes('languageEffective'), 'the effective language is no longer reported alongside');
});

ok('nulls, never zeros, when a call had no measurable turn', () => {
  // 0ms is a claim that a stage was instant. null is the truth: nothing was
  // observed. A short call that hung up before a reply must not report 0.
  const diag = SRC.slice(SRC.indexOf('latencySplit: {'), SRC.indexOf('latencySplit: {') + 1200);
  for (const k of ['sttDebounceP50', 'llmToolP50', 'ttsFirstByteP50']) {
    // Match to end of LINE, not to the first comma: the expression itself
    // contains one, inside _percentile(this._sttMs, 50). The first version of
    // this assertion truncated there and failed on correct code.
    const m = diag.match(new RegExp('^\\s*' + k + ':(.*)$', 'm'));
    assert(m, `${k} missing`);
    assert(/\.length \?/.test(m[1]) && /:\s*null/.test(m[1]),
      `${k} must be null when unmeasured, not 0 — got ${m[1].trim()}`);
  }
});

// ── the roster slice: a flag is a claim, a diagnostic is a record ───────────
ok('the roster slice is RECORDED per call, not assumed from the flag', () => {
  // ENABLE_ROSTER_SLICE was measured at 11/12 vs 9/12 and switched on in
  // Railway. But sliceRoster falls back to the FULL roster on several branches
  // — roster <= 3, no patient turn yet, no specialty match — so the flag being
  // true does not mean the slice fired on the call in front of you. That gap is
  // exactly how languagePinned read null for six calls while calls.language
  // said Hindi.
  assert(inDiagnostics('rosterSlice'), 'rosterSlice is not in diagnostics');
  for (const k of ['slicedTurns', 'brainTurns']) {
    assert(DIAG.includes(k), `diagnostics.rosterSlice is missing ${k}`);
  }
  // brainTurns is the denominator — without it, slicedTurns=0 cannot be told
  // apart from "the brain was never consulted".
  assert(/this\._rosterBrainTurns\+\+/.test(SRC), 'brainTurns is never incremented');
  assert(/this\._rosterSliceTurns\+\+/.test(SRC), 'slicedTurns is never incremented');
});

ok('EVERY brain context carries the slice callback', () => {
  // Three call sites reach the brain. A context that omits the callback would
  // silently under-count, and the metric would read "the slice rarely fires"
  // when the truth is "we only watched two thirds of the turns".
  const brainCalls = (SRC.match(/getLeanResponseStream\(|generateLeanRaw\(/g) || []).length;
  const callbacks = (SRC.match(/onRosterSlice:/g) || []).length;
  assert(callbacks >= 3, `only ${callbacks} contexts carry onRosterSlice`);
  assert(callbacks >= brainCalls - 2,
    `${brainCalls} brain call sites but only ${callbacks} report the slice`);
});

ok('observation can never break a call', () => {
  // The callback runs inside the brain. If it throws, a patient loses their
  // turn — for a metric. brain-lean must swallow it.
  const bl = fs.readFileSync(path.join(__dirname, '..', 'brain-lean.js'), 'utf8');
  const site = bl.slice(bl.indexOf('onRosterSlice'), bl.indexOf('onRosterSlice') + 300);
  assert(/try \{[^}]*context\.onRosterSlice\(rosterSlice\);[^}]*\} catch/.test(site),
    'the roster-slice callback is not wrapped — a throwing metric would kill the turn');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
