#!/usr/bin/env node
'use strict';
// One emergency probe, both channels, no seam.
//
// Five hand-written copies of "what the regex detector sees" existed: the voice
// transcript path, the WhatsApp inbound guard, two tests and the FP sweep. The
// WhatsApp copy had already diverged (no romanized copy → English words typed in
// Kannada script reached the brain), and the cardiac window widened on 2026-09-01
// took the copy separator ‖ as a token, so "दर्द बिल्कुल नहीं, बस खुजली है छाती में"
// (no pain at all, just itching on my chest) escalated as a heart emergency.
//
// This file drives the ONE definition (composeEmergencyProbe) through the real
// detector, the real WhatsApp guard, and the real voice _onTranscript (child
// process, as tests/test-emergency-v2-enforcement.js does), and asserts the two
// channels agree utterance by utterance.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-WINDOW-CROSSES-SEAM  — a cardiac pattern whose window takes ‖ as a token
//   MUTANT=MUT-WA-OWN-PROBE         — WhatsApp composes its own probe again (raw + ' ' + dev)
//   MUTANT=MUT-VOICE-OWN-PROBE      — voice composes its own probe (applied inside the child)
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('flips EMERGENCY_V2 / EMERGENCY_V2_ENFORCE in-process to prove the shared enforcement policy — the policy itself is under test');
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.SKIP_BOOT_AUDIO = '1';
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('async callback passed to ok() — use okAsync');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message.split('\n')[0]}`); }
};

// ── stubs BEFORE requires (patch-before-require) ─────────────────────────────
const detPath = require.resolve('../emergencyDetector.js');
const det = require(detPath);
if (MUTANT === 'MUT-WINDOW-CROSSES-SEAM') {
  // the detector iterates the COMPILED list, so mutate the live entry in place
  const e = det._FLAT_PATTERNS.find((x) => x.id === 'cardiac' && x.re.source.includes('छाती'));
  e.re = /छाती\s+में(?:\s+\S+){0,3}\s+दर्द/;
}
if (MUTANT === 'MUT-WA-OWN-PROBE') {
  const { toDevanagari } = require('../translit');
  det.composeEmergencyProbe = (t) => `${t} ${toDevanagari(t)}`;   // the copy WhatsApp used to carry
}
const { detectEmergency, composeEmergencyProbe } = det;
const { runInboundGuards } = require('../whatsappGuards.js');
const { v2Enforces } = require('../emergencyDetectorV2.js');

const SEAM      = 'दर्द बिल्कुल नहीं, बस खुजली है छाती में';     // no pain, itching on the chest → QUIET
const SEAM2     = 'सांस की कोई दिक्कत नहीं, बस पेट में';          // QUIET
const CARDIAC   = 'छाती में बहुत ज़्यादा दर्द है';                 // intensifier inside the window → HIT
const KN_HEART  = 'ಹಾರ್ಟ್ ಅಟ್ಯಾಕ್ ಆಗಿದೆ';                          // "heart attack" in Kannada script → HIT via romanize
const WARD_ADDR = 'emergency ward ka address bhejiye';             // QUIET

console.log('[1] the probe itself: copies are transforms, the separator is not a token');
ok('four copies joined by ‖',            () => assert.strictEqual(composeEmergencyProbe('हार्ट अटैक').split(' ‖ ').length, 4));
ok('no copy carries an internal seam',   () => { const p = composeEmergencyProbe(SEAM); for (const c of p.split(' ‖ ')) assert.ok(!/छाती में\s+दर्द/.test(c), `seam inside a copy: ${c}`); });
ok('the seam sentence is QUIET',         () => assert.strictEqual(detectEmergency(composeEmergencyProbe(SEAM)), null));
ok('...and its breathing twin',          () => assert.strictEqual(detectEmergency(composeEmergencyProbe(SEAM2)), null));
ok('a real cardiac line still fires through the window', () => assert.strictEqual((detectEmergency(composeEmergencyProbe(CARDIAC)) || {}).type, 'cardiac'));
ok('Kannada-script "heart attack" fires via the romanized copy', () => assert.ok(detectEmergency(composeEmergencyProbe(KN_HEART)), 'missed'));
ok('roman:false drops exactly the romanized copy', () => assert.strictEqual(composeEmergencyProbe(KN_HEART, { roman: false }).split(' ‖ ').length, 3));

console.log('\n[2] WhatsApp runs the same definition');
const wa = (t, lang = 'hi-IN') => { const r = runInboundGuards(t, lang); return r ? r.kind : null; };
ok('seam sentence QUIET on WhatsApp',                 () => assert.strictEqual(wa(SEAM), null));
ok('Kannada-script heart attack ESCALATES on WhatsApp', () => assert.strictEqual(wa(KN_HEART, 'kn-IN'), 'emergency'));
ok('real cardiac ESCALATES on WhatsApp',              () => assert.strictEqual(wa(CARDIAC), 'emergency'));
ok('emergency-ward address request QUIET on WhatsApp', () => assert.strictEqual(wa(WARD_ADDR), null));

console.log('\n[3] voice runs the same definition (real _onTranscript, child process)');
const DRIVE = `
process.env.SKIP_BOOT_AUDIO = '1';
if (process.env.MUTANT === 'MUT-VOICE-OWN-PROBE') {
  const det = require('./emergencyDetector.js'); const { toDevanagari } = require('./translit');
  det.composeEmergencyProbe = (t) => t + ' ' + toDevanagari(t);
}
const { CallHandler } = require('./callHandler.js');
const h = Object.create(CallHandler.prototype);
let escalated = null;
Object.assign(h, {
  callSid: 'sid-probe', callerPhone: '+918273500806', startTime: Date.now(),
  conversationHistory: [], transcript: [], _turnLatencies: [], _llmMs: [], _ttsMs: [], _sttMs: [],
  _lastRituText: '', _droppedUtterances: 0, _garbleReprompts: 0, _criticalErrors: 0,
  isSpeaking: false, _ended: false, shouldEndCall: false,
  handleEmergency: async (d) => { escalated = d; },
  speak: async () => {}, _clearSilenceTimers: () => {}, _startSilenceTimer: () => {},
  _cancelSpeculation: () => {}, _cancelCompletionSpec: () => {},
  processIntent: async () => null, _langCode: () => 'hi-IN',
  ws: { readyState: 1, send: () => {} }, stt: new Proxy({}, { get: () => () => {} }),
  _processingChain: Promise.resolve(), _turnRoutedToModel: false,
  _pendingTranscript: '', _debounceTimer: null, _speculation: null,
  _completionSpec: null, _historyStage: 0, _readbackPending: null,
  _medRepeatPending: null, appointmentBooked: false, conversationPhase: 'reason',
  _lastTurnPeakRms: 0, _fillerTurns: 0, _priorMeds: [],
});
(async () => {
  try { await h._onTranscript(process.env.__UTT, { languageCode: 'hi-IN' }); } catch (e) {}
  const t0 = Date.now();   // emergencies escalate before the debounce; poll briefly, capped
  while (Date.now() - t0 < 4000 && !escalated && (h._pendingTranscript || h._debounceTimer)) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 60));
  console.log('__RESULT__' + JSON.stringify({ escalated: escalated ? (escalated.type || true) : null }));
  process.exit(0);
})();
`;
function voice(utt) {
  const r = spawnSync(process.execPath, ['-e', DRIVE], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, __UTT: utt, EMERGENCY_V2_ENFORCE: '', EMERGENCY_V2: '' },
  });
  const m = String(r.stdout || '').match(/__RESULT__(\{.*\})/);
  if (!m) throw new Error(`child gave no result: ${String(r.stderr || '').slice(-300)}`);
  return JSON.parse(m[1]).escalated;
}
const V = { seam: voice(SEAM), cardiac: voice(CARDIAC), kn: voice(KN_HEART), ward: voice(WARD_ADDR) };
ok('seam sentence QUIET on voice',                   () => assert.strictEqual(V.seam, null));
ok('real cardiac ESCALATES on voice',               () => assert.ok(V.cardiac, 'not escalated'));
ok('Kannada-script heart attack ESCALATES on voice', () => assert.ok(V.kn, 'not escalated'));
ok('emergency-ward address QUIET on voice',         () => assert.strictEqual(V.ward, null));
ok('the two channels agree on all four',            () => assert.deepStrictEqual(
  [V.seam, !!V.cardiac, !!V.kn, V.ward], [wa(SEAM), wa(CARDIAC) === 'emergency', wa(KN_HEART, 'kn-IN') === 'emergency', wa(WARD_ADDR)]));

console.log('\n[4] v2 enforcement is ONE policy, read when asked');
ok('callHandler consumes the shared function', () => assert.strictEqual(require('../callHandler.js')._V2_ENFORCES, v2Enforces));
ok('the WhatsApp guard consults the shared policy and maps v2 self-harm by CATEGORY (driven)', () => {
  // whatsappGuards destructures both at require: stub the v2 module, re-require, drive.
  const v2Path = require.resolve('../emergencyDetectorV2.js');
  const realV2 = require.cache[v2Path].exports;
  const waPath = require.resolve('../whatsappGuards.js');
  const drive = (stub) => {
    require.cache[v2Path].exports = { ...realV2, ...stub };
    delete require.cache[waPath];
    try { const r = require(waPath).runInboundGuards('namaste ji', 'hi-IN'); return r ? r.kind : null; }
    finally { require.cache[v2Path].exports = realV2; delete require.cache[waPath]; }
  };
  assert.strictEqual(drive({ detectEmergencyV2: () => ({ tier: 'RED', category: 'zeta' }), v2Enforces: (c) => c === 'zeta' }), 'emergency', 'enforced category did not escalate');
  assert.strictEqual(drive({ detectEmergencyV2: () => ({ tier: 'RED', category: 'zeta' }), v2Enforces: () => false }), null, 'shadow category escalated');
  assert.strictEqual(drive({ detectEmergencyV2: () => ({ tier: 'RED', category: 'selfharm' }), v2Enforces: () => true }), 'self_harm', 'v2 self-harm was not routed as self_harm (WhatsApp read v2.type, which v2 never returns)');
});
ok('unset → nothing enforced',           () => { process.env.EMERGENCY_V2 = ''; process.env.EMERGENCY_V2_ENFORCE = ''; assert.strictEqual(v2Enforces('cardiac'), false); });
ok('per-category flag enforces that category only', () => { process.env.EMERGENCY_V2_ENFORCE = 'selfharm, breathing'; assert.strictEqual(v2Enforces('breathing'), true); assert.strictEqual(v2Enforces('cardiac'), false); });
ok('EMERGENCY_V2=on enforces everything',  () => { process.env.EMERGENCY_V2 = 'on'; assert.strictEqual(v2Enforces('cardiac'), true); process.env.EMERGENCY_V2 = ''; process.env.EMERGENCY_V2_ENFORCE = ''; });

console.log(`\n${pass}/${pass + fail} passing`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
console.log('✓ One probe definition; both channels agree; the separator is never a token.');
process.exit(0);
