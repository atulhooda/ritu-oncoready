#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE TTS TEMPERATURE KNOB, DRIVEN.
//
// bulbul:v3 has no pitch or loudness; pace and `temperature` (0.01–2.0,
// default 0.6, DOC in config.js) are the whole tuning surface for how natural
// Ritu sounds. Unset → the request carries no temperature (Sarvam's default,
// no behaviour change). TTS_TEMPERATURE sets it globally,
// TTS_TEMPERATURE_BY_LANG per language, resolved the same way pace is.
//
// MUT-TEMP-IGNORED drops the knob from the request — the per-language proof
// must go red.
//
// Run:            node tests/test-tts-temperature-driven.js
// Prove it fails: MUTANT=MUT-TEMP-IGNORED node tests/test-tts-temperature-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');
require('./_bootstrap').mutatesEnv('sets TTS_TEMPERATURE and TTS_TEMPERATURE_BY_LANG and re-requires config to read them');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nTTS TEMPERATURE — driven\n');

function fresh() {
  for (const m of ['../config.js', '../sarvam.js']) delete require.cache[require.resolve(m)];
  const config = require('../config.js');
  const sarvam = require('../sarvam.js');
  if (MUTANT === 'MUT-TEMP-IGNORED') config.temperatureForLang = () => undefined;
  return { config, sarvam };
}
const data = (sarvam, lang) => JSON.parse(sarvam._ttsConfigMessage(lang, 'ritu')).data;

delete process.env.TTS_TEMPERATURE;
delete process.env.TTS_TEMPERATURE_BY_LANG;
{
  const { config, sarvam } = fresh();
  ok('unset → no temperature in the request (Sarvam default applies; nothing changes for running clinics)', () => {
    assert.strictEqual(config.temperatureForLang('gu-IN'), undefined);
    assert.ok(!('temperature' in data(sarvam, 'gu-IN')));
  });
}
process.env.TTS_TEMPERATURE = '0.5';
{
  const { config, sarvam } = fresh();
  ok('TTS_TEMPERATURE=0.5 → every language sends 0.5', () => {
    assert.strictEqual(config.temperatureForLang('hi-IN'), 0.5);
    assert.strictEqual(data(sarvam, 'hi-IN').temperature, 0.5);
    assert.strictEqual(data(sarvam, 'gu-IN').temperature, 0.5);
  });
}
process.env.TTS_TEMPERATURE_BY_LANG = 'gu-IN:0.45, kn-IN:0.7';
{
  const { config, sarvam } = fresh();
  ok('TTS_TEMPERATURE_BY_LANG overrides per language and leaves the rest on the global value', () => {
    assert.strictEqual(data(sarvam, 'gu-IN').temperature, 0.45);
    assert.strictEqual(data(sarvam, 'kn-IN').temperature, 0.7);
    assert.strictEqual(data(sarvam, 'hi-IN').temperature, 0.5);
    assert.strictEqual(config.temperatureForLang('gu-IN'), 0.45);
  });
  ok('pace, speaker, 8 kHz and linear16 are untouched by the knob', () => {
    const d = data(sarvam, 'gu-IN');
    assert.strictEqual(d.speaker, 'ritu');
    assert.strictEqual(d.speech_sample_rate, 8000);
    assert.strictEqual(d.output_audio_codec, 'linear16');
    assert.strictEqual(typeof d.pace, 'number');
  });
}
process.env.TTS_TEMPERATURE = 'banana';
delete process.env.TTS_TEMPERATURE_BY_LANG;
{
  const { config } = fresh();
  ok('a non-number is ignored, never sent', () => assert.strictEqual(config.temperatureForLang('gu-IN'), undefined));
}
delete process.env.TTS_TEMPERATURE;

if (MUTANT && fail === 0) {
  console.log(`\n  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
