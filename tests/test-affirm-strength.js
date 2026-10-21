// ─── HOW MUCH IS A "हाँ" WORTH WHEN YOU CANNOT TELL WHO SAID IT ──────────────
// Sarvam documents speaker diarization as unavailable on the streaming socket —
// DOC: "Always null over the WebSocket API — diarization is not supported for
// streaming; use the Batch API for diarized transcripts." That is a property of
// the ENDPOINT, not the model, so saaras:v4 does not change it.
//
// On an Indian clinic call a relative is frequently on the line. Before this,
// any affirm token anywhere in a reply marked the drug VERIFIED and emitted it
// as [READBACK-GOLD] — a training label. One agreeable syllable from an
// unidentified voice became both a clinical fact and gold data.
//
// The discriminator here is CONTENT, not voice, because content is what we
// actually have. A caller who repeats the molecule agreed to something
// specific; a bare "हाँ" agreed to whatever was just said, by whoever said it.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { classifyReply, stepReadback } = require('../readback');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const strength = (t) => classifyReply(t, 'Metformin', { brands: true }).affirmStrength;

console.log('\nAFFIRM STRENGTH — content stands in for the speaker identity we do not have\n');

ok('a bare yes is BARE, in every language Ritu takes', () => {
  for (const t of ['हाँ', 'हां', 'ji', 'haan', 'yes', 'हां जी', 'haan ji', 'ಸರಿ', 'होय']) {
    assert.strictEqual(strength(t), 'bare', `"${t}" graded ${strength(t)}`);
  }
});

ok('stacked agreement words are still BARE — four yeses are not content', () => {
  // "हाँ सही है जी बिल्कुल" is agreement four times over and says nothing of
  // its own. Counting tokens rather than affirm-words would have called this
  // substantive, which is precisely backwards.
  assert.strictEqual(strength('हाँ सही है जी बिल्कुल'), 'bare');
  assert.strictEqual(strength('yes right correct'), 'bare');
});

ok('repeating the molecule is SUBSTANTIVE', () => {
  for (const t of ['हाँ वो मेटफॉर्मिन वाली दवाई', 'haan Metformin hi hai', 'yes that is correct one']) {
    assert.strictEqual(strength(t), 'substantive', `"${t}" graded ${strength(t)}`);
  }
});

ok('a denial has no affirm strength at all', () => {
  assert.strictEqual(strength('नहीं'), null);
  assert.strictEqual(strength('nahi wo dawai nahi hai'), null);
});

// ── what it changes, and what it deliberately does not ──────────────────────
const pending = { canonical: 'Metformin', surface: 'metformin', weak: false, second: null };

ok('a bare affirm STILL RECORDS the medication', () => {
  // Refusing bare affirms would gut capture — most callers just say "हाँ" —
  // to chase a rarer harm. The drug was named by someone on a medical call.
  const r = stepReadback(pending, 'हाँ');
  assert.strictEqual(r.verified, true, 'a bare affirm must still verify');
  assert.strictEqual(r.med, 'Metformin');
  assert.strictEqual(r.affirmStrength, 'bare');
});

ok('and a substantive one is indistinguishable in the record', () => {
  const r = stepReadback(pending, 'हाँ वो मेटफॉर्मिन वाली');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.affirmStrength, 'substantive');
});

ok('the keypad path is unchanged — "1" is unambiguous', () => {
  const r = stepReadback(pending, '1');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.med, 'Metformin');
});

ok('callHandler gates the GOLD HARVEST on it, not the record', () => {
  const fs = require('fs');
  const path = require('path');
  const ch = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(/r\.affirmStrength === 'bare'/.test(ch), 'callHandler does not read affirmStrength');
  assert(/NOT harvested as gold/.test(ch), 'the bare-affirm branch does not exist');
  // The medication must still be persisted — the whole point is that only the
  // training label is withheld.
  assert(/saveConfirmedMedication/.test(ch), 'medication persistence disappeared');
});

ok('RMS is logged but NOT gated on — an unmeasured threshold is a guess', () => {
  const fs = require('fs');
  const path = require('path');
  const ch = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(/rms=\$\{rms\}/.test(ch), 'turn-peak RMS is not being recorded for later analysis');
  // If a future change starts BRANCHING on rms without a measurement behind it,
  // that is the guessed-vendor-parameter mistake this repo has a gate against.
  assert(!/if \(rms [<>]/.test(ch), 'code is branching on an unmeasured RMS threshold');
});

ok('MUTATION: grading everything substantive would fail this file', () => {
  assert.notStrictEqual(strength('हाँ'), 'substantive');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
