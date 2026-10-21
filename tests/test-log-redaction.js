// ─── NO PATIENT SPEECH REACHES STDOUT ────────────────────────────────────────
// This is a compliance invariant, not a feature test. Twenty-four call sites
// were writing symptoms, medications and caller names into a third-party log
// stream. The fix is only worth anything if it STAYS fixed, and the way it
// regresses is somebody adding a 25th `console.log(..."${trimmed}"...)` in six
// months without thinking about it.
//
// So this file checks two different things:
//   1. speech() itself never returns content (behaviour)
//   2. NO SOURCE FILE still interpolates a speech-bearing variable into a
//      console call (static — catches the 25th site before it ships)
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// speech() reads DEBUG_SPEECH at module load, so the default path is what a
// fresh require gives us. Assert that default explicitly rather than assuming.
delete process.env.DEBUG_SPEECH;
const { speech, maskPhone } = require('../redact');

console.log('\nLOG REDACTION — patient speech must not reach stdout\n');

// ── 1. behaviour ────────────────────────────────────────────────────────────
const REAL = [
  'हाँ वो Metformin की दवाई चल रही है',   // medication, from a real call
  'यार मेरे को ना सर में दर्द हो रहा है',  // symptom, from a real call
  'स्पेशलिटी क्या है डॉक्टर की',
  'ਸਰ ਦੂਰ ਹੈ।',
  'नमस्कार सिद्धार्थ जी',                 // Ritu's reply — carries the caller NAME
];

ok('no word of any real utterance survives', () => {
  for (const s of REAL) {
    const out = speech(s);
    for (const w of s.split(/\s+/).filter((w) => w.length >= 3)) {
      assert(!out.includes(w), `"${w}" leaked through in ${out}`);
    }
  }
});

ok('output is a bounded descriptor, never proportional to input', () => {
  const long = 'दर्द '.repeat(400);
  assert(speech(long).length < 40, 'descriptor grew with the input');
});

ok('script is preserved — the signal worth keeping', () => {
  assert.match(speech('मुझे दर्द है'), /deva/);
  assert.match(speech('ਸਰ ਦੂਰ ਹੈ।'), /guru/);   // NOT deva: the danda is shared
  assert.match(speech('hello there'), /latn/);
  assert.match(speech('हाँ वो Metformin'), /deva\+latn/);
});

ok('GURMUKHI IS NOT DEVANAGARI — the danda U+0964 must not decide', () => {
  // A finding was once withdrawn because a Devanagari+Latin log search missed a
  // live Punjabi call. "ਸਰ ਦੂਰ ਹੈ।" ends in a danda, which is encoded in the
  // Devanagari block and shared across Indic scripts.
  const out = speech('ਸਰ ਦੂਰ ਹੈ।');
  assert(out.includes('guru'), `expected guru, got ${out}`);
  assert(!out.includes('deva'), `danda misclassified as Devanagari: ${out}`);
});

ok('degenerate inputs cannot throw — a logger must never drop a call', () => {
  for (const v of [null, undefined, '', '   ', 0, false, {}, [], 12345]) {
    assert.doesNotThrow(() => speech(v));
  }
});

ok('phones still masked', () => {
  assert.strictEqual(maskPhone('+918273500806'), '••••••0806');
});

// ── 2. static — the 25th call site ──────────────────────────────────────────
// Speech-bearing identifiers.
//
// THIS LIST WAS TOO NARROW AND PRODUCTION PROVED IT. Three hours after the
// redaction shipped, a live call put two things in the logs that this check had
// waved through, because it only knew the variable names I had happened to
// think of:
//     [SARVAM] STT first data msg structure: {…"transcript":"यार मेरे सर में…"}
//     Ritu (stream): सिद्धार्थ जी, अभी के लिए Dr. Manoj Deo…
// The first was JSON.stringify of a whole response object; the second was a
// different variable (`chunk.text`) on the streamed path. Neither matched.
//
// So the check now looks for SHAPES rather than a list of names: any dotted
// `.text`/`.transcript` property, and any JSON.stringify inside a console call.
// It will produce false positives; that is the correct direction for this one.
const SPEECH_VARS = new RegExp([
  '\\$\\{(trimmed|transcript|this\\._pendingTranscript|spec\\.transcript)\\}',
  '\\$\\{[A-Za-z_.]*\\.(text|transcript)\\}',   // chunk.text, msg.data.transcript
  'JSON\\.stringify\\(\\s*(msg|data|payload|res|response)\\b',
].join('|'));
const FILES = ['callHandler.js', 'sarvam.js', 'brain-lean.js', 'whatsappChannel.js', 'reportIntake.js'];

ok('no source file interpolates raw speech into a console call', () => {
  const offenders = [];
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (!/console\.(log|warn|error|info)/.test(line)) return;
      if (SPEECH_VARS.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.strictEqual(offenders.length, 0,
    `raw speech reaching stdout:\n      ${offenders.join('\n      ')}`);
});

ok('the Patient said / STT result lines route through speech()', () => {
  const ch = fs.readFileSync(path.join(ROOT, 'callHandler.js'), 'utf8');
  const sv = fs.readFileSync(path.join(ROOT, 'sarvam.js'), 'utf8');
  assert(/Patient said: \$\{speech\(/.test(ch), 'callHandler "Patient said" is not gated');
  assert(/Ritu: \$\{speech\(/.test(ch), 'callHandler "Ritu:" reply is not gated');
  assert(/STT result:', speech\(/.test(sv), 'sarvam "STT result" is not gated');
});

// ── 3. mutation: prove this file can actually fail ──────────────────────────
ok('MUTATION: the static check would catch a new leaking call site', () => {
  const fake = 'console.log(`[CALL ${this.callSid}] Patient said: "${trimmed}"`);';
  assert(SPEECH_VARS.test(fake), 'the detector does not match a real leaking line');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
