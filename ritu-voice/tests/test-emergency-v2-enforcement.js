#!/usr/bin/env node
// ─── THE SAFETY SWITCH, DRIVEN INSTEAD OF RESTATED ──────────────────────────
// tests/test-emergency-v2-scope.js checks the scoping ARITHMETIC — which
// categories are worth enforcing, given the recovered emergencies and the false
// positives they cost. That analysis is good and stays.
//
// Three of its assertions did not check production at all:
//
//   ok('default configuration changes NOTHING', () => {
//     delete process.env.EMERGENCY_V2_ENFORCE;
//     const set = new Set(String(process.env.EMERGENCY_V2_ENFORCE || '').split(','
//               ).map(s => s.trim()).filter(Boolean));
//     assert.strictEqual(set.size, 0, 'enforcement is on by default');
//   });
//
//   ok('MUTATION: an empty enforce-set escalates nothing', () => {
//     const set = new Set([]);
//     const enforces = (c) => set.has(c);
//     assert(!enforces('selfharm'), 'empty set escalated');
//   });
//
// Both rebuild the rule inside the test and then assert on the rebuild. The
// second is labelled MUTATION and mutates nothing — it constructs a two-line
// closure and confirms JavaScript works. callHandler's V2_ENFORCES could be
// deleted outright and both stay green. The third reads callHandler.js as a
// string and greps for /V2_ENFORCES\(v2\.category\)/.
//
// WHY IT MATTERS HERE MORE THAN ANYWHERE. This switch decides whether a caller
// who says something in the self-harm class is routed to a helpline. Wrong in
// one direction, a patient in crisis is asked about their appointment. Wrong in
// the other, an ordinary caller is told to ring 108. There is no version of this
// that is safe to assert by grep.
//
// V2_ENFORCES is a module-level const frozen at require time, so ONE process
// cannot hold two configurations. Each case below runs in its OWN process with
// the env set, which is also exactly how production gets its value.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// Run a snippet in a fresh node process with a specific environment, and get
// its JSON back. A fresh process is not ceremony: it is the only way to observe
// a require-time const under more than one configuration.
function inProcess(env, snippet) {
  const out = execFileSync(process.execPath, ['-e', snippet], {
    cwd: REPO,
    env: { ...process.env, ...env, CLINIC_MODE: 'lean' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('__RESULT__')).pop();
  assert(line, `the child produced no result line. output:\n${out.slice(-600)}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

const ASK = `
const ch = require('./callHandler.js');
const E = ch._V2_ENFORCES;
const cats = ['selfharm','stroke','poisoning','bleeding','cardiac','choking'];
const r = {};
for (const c of cats) r[c] = !!E(c);
console.log('__RESULT__' + JSON.stringify(r));
// EXIT, do not wait for the event loop. Requiring callHandler leaves the db
// pool and the TTS prewarm sockets open; node then sits for ~12s per child
// before giving up. MEASURED 2026-08-14: this file was 139s of a 158s suite,
// almost none of it work — eleven children x twelve seconds of waiting.
process.exit(0);
`;

console.log('\nEMERGENCY V2 ENFORCEMENT — the real predicate, in a real process\n');

// ── 1. the default, which is the whole safety argument ────────────────────
ok('UNSET: enforcement escalates NOTHING — a safety switch must be opt-in', () => {
  const r = inProcess({ EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: '' }, ASK);
  const on = Object.entries(r).filter(([, v]) => v).map(([k]) => k);
  assert.deepStrictEqual(on, [],
    `with no env set, these categories escalate: ${on.join(', ')} — a switch that turns itself on is a different kind of hazard`);
});

// ── 2. it enforces exactly what it was told, and nothing adjacent ─────────
ok('a scoped set enforces ONLY its members', () => {
  const r = inProcess({ EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: 'selfharm,stroke,poisoning' }, ASK);
  assert(r.selfharm && r.stroke && r.poisoning, `the named categories are not enforced: ${JSON.stringify(r)}`);
  assert(!r.bleeding && !r.cardiac,
    `bleeding/cardiac escalated without being named — they are deliberately excluded (11 and 6 FPs against v1 gaps of 1 and 6): ${JSON.stringify(r)}`);
});

ok('an unknown category is not enforced by accident', () => {
  const r = inProcess({ EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: 'selfharm' }, ASK);
  assert(!r.choking, 'a category nobody listed is escalating');
});

// ── 3. the shapes a human actually types into a dashboard ────────────────
ok('whitespace and case in the env var do not silently disable a category', () => {
  const r = inProcess({ EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: ' SelfHarm , STROKE ' }, ASK);
  assert(r.selfharm, 'a padded, capitalised entry was dropped — someone types this into Railway by hand');
  assert(r.stroke, 'an uppercase entry was dropped');
});

ok('an empty or comma-only value enforces nothing rather than everything', () => {
  for (const v of [',', ' , , ', '']) {
    const r = inProcess({ EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: v }, ASK);
    const on = Object.entries(r).filter(([, x]) => x).map(([k]) => k);
    assert.deepStrictEqual(on, [], `EMERGENCY_V2_ENFORCE=${JSON.stringify(v)} escalated ${on.join(', ')}`);
  }
});

// ── 4. the legacy global switch still means "all" ────────────────────────
ok('EMERGENCY_V2=on still enforces every category', () => {
  const r = inProcess({ EMERGENCY_V2: 'on', EMERGENCY_V2_ENFORCE: '' }, ASK);
  const off = Object.entries(r).filter(([, v]) => !v).map(([k]) => k);
  assert.deepStrictEqual(off, [], `the old global switch no longer covers: ${off.join(', ')}`);
});

// ── 5. THE ONE THAT MATTERS: does a real utterance reach the helpline? ────
// Everything above tests the predicate. This tests the CALL: a RED self-harm
// utterance through _onTranscript, and whether handleEmergency actually fires.
const DRIVE = `
const ch = require('./callHandler.js');
const { CallHandler } = ch;
const h = Object.create(CallHandler.prototype);
let escalated = null;
Object.assign(h, {
  callSid: 'sid-emg', callerPhone: '+918273500806', startTime: Date.now(),
  conversationHistory: [], transcript: [], _turnLatencies: [], _llmMs: [], _ttsMs: [], _sttMs: [],
  _lastRituText: '', _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
  isSpeaking: false, _ended: false, shouldEndCall: false,
  handleEmergency: async (d) => { escalated = d; },
  speak: async () => {}, _clearSilenceTimers: () => {}, _startSilenceTimer: () => {},
  _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
  processIntent: async () => null, _langCode: () => 'hi-IN',
  ws: { readyState: 1, send: () => {} }, stt: null,
  // When the gate does NOT escalate, the turn carries on down the ordinary
  // path — callHandler.js:1731 chains onto _processingChain. Without it the
  // child dies with a TypeError and the case reads as "escalation failed"
  // rather than "escalation correctly did not happen". A stub that only
  // survives the branch you expect can only ever confirm what you expect.
  _processingChain: Promise.resolve(), _turnRoutedToModel: false,
  _pendingTranscript: '', _debounceTimer: null, _speculation: null,
  _completionSpec: null, _historyStage: 0, _readbackPending: null,
  _medRepeatPending: null, appointmentBooked: false, conversationPhase: 'reason',
  _lastTurnPeakRms: 0, _fillerTurns: 0, _priorMeds: [],
});
(async () => {
  try { await h._onTranscript(process.env.__UTT, { languageCode: 'hi-IN' }); } catch (e) {}
  await new Promise(r => setTimeout(r, 60));
  console.log('__RESULT__' + JSON.stringify({ escalated: escalated ? { type: escalated.type, label: escalated.label } : null }));
  process.exit(0);   // see the note on the ASK snippet
})();
`;

// ─── THE UTTERANCE HAS TO BE ONE v1 MISSES ────────────────────────────────
// The first version used "मुझे आत्महत्या करनी है" and the last two cases failed,
// which read as a production bug: self-harm escalating with an EMPTY enforce
// set. It was not. The escalation carried label "Suicidal ideation / self-harm"
// — v1's label. The v2 path sets `v2:${category}`. v1 catches that phrase on its
// own, so it escalates whatever v2 is configured to do, and the test was
// measuring v1 while claiming to measure the v2 gate.
//
// The v2 scope exists ONLY for the 34 RED items v1 misses. To see the gate
// decide anything, the utterance must be one of them: v1 silent, v2 RED and
// selfharm. Then enforcement is the only thing standing between the caller and
// the helpline, which is precisely the property worth a test.
const SELF_HARM_UTTERANCE = process.env.__SELF_HARM_UTTERANCE || 'मैं अपनी जान देना चाहता हूँ';

ok('the utterance is one v1 MISSES — otherwise the gate decides nothing', () => {
  const { detectEmergency } = require('../emergencyDetector.js');
  assert(!detectEmergency(SELF_HARM_UTTERANCE),
    `v1 already catches ${JSON.stringify(SELF_HARM_UTTERANCE)}, so it escalates regardless of the v2 scope and every case below would pass for the wrong reason`);
});

ok('and v2 classifies it RED/selfharm', () => {
  const { detectEmergencyV2 } = require('../emergencyDetectorV2.js');
  const v2 = detectEmergencyV2(SELF_HARM_UTTERANCE, { lastRituText: '' });
  assert(v2, `the detector does not fire on ${JSON.stringify(SELF_HARM_UTTERANCE)} — every case below would then pass vacuously`);
  assert.strictEqual(v2.category, 'selfharm', `category is ${v2.category}`);
  assert.strictEqual(v2.tier, 'RED', `tier is ${v2.tier} — only RED escalates`);
});

ok('ENFORCED: a RED self-harm turn routes to the helpline, not 108', () => {
  const r = inProcess(
    { EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: 'selfharm', __UTT: SELF_HARM_UTTERANCE },
    DRIVE
  );
  assert(r.escalated, 'self-harm was enforced and the call did NOT escalate');
  assert.strictEqual(r.escalated.type, 'self_harm',
    `escalated as ${r.escalated.type} — it must map to v1's 'self_harm' so handleEmergency reads the helpline text, not the 108 line`);
  assert.strictEqual(r.escalated.label, 'v2:selfharm',
    `label is ${r.escalated.label} — anything else means v1 caught it and the v2 gate was never the deciding factor`);
});

ok('UNENFORCED: the same turn does NOT escalate — the scope is real', () => {
  const r = inProcess(
    { EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: '', __UTT: SELF_HARM_UTTERANCE },
    DRIVE
  );
  assert.strictEqual(r.escalated, null,
    `escalated with an empty enforce-set: ${JSON.stringify(r.escalated)} — the default must change nothing`);
});

ok('a category NOT in the set does not escalate on the same code path', () => {
  const r = inProcess(
    { EMERGENCY_V2: '', EMERGENCY_V2_ENFORCE: 'stroke', __UTT: SELF_HARM_UTTERANCE },
    DRIVE
  );
  assert.strictEqual(r.escalated, null,
    'enforcing stroke escalated a selfharm utterance — the gate is not reading the category');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
