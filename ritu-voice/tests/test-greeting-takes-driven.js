#!/usr/bin/env node
'use strict';
// THE GREETING IS THE BRISKEST OF N TAKES, NOT THE FIRST.
//
// MEASURED 2026-09-14: one Sarvam draw of the same greeting varies 8.8–12.3 s
// at a fixed pace/voice/temperature; the live boot had cached a 12.1 s draw and
// the founder heard "the intro is slow". greetingTakes.renderBriskest runs the
// synth N times and keeps the shortest buffer. Driven with a fake synth.
//
// Run:            node tests/test-greeting-takes-driven.js
// Prove it fails: MUTANT=MUT-GREETING-FIRST-TAKE node tests/test-greeting-takes-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const g = require('../greetingTakes');
if (MUTANT === 'MUT-GREETING-FIRST-TAKE') {
  g.renderBriskest = async ({ synth }) => { const audio = await synth(); return { audio, seconds: [audio.length / 16000], keptSeconds: audio.length / 16000, failed: 0 }; };
}
const buf = (seconds) => Buffer.alloc(Math.round(seconds * 16000), 1);
const fakeSynth = (lengths) => { let i = 0; return () => Promise.resolve(buf(lengths[i++ % lengths.length])); };

(async () => {
  console.log('\nGREETING TAKES — driven\n');

  const r = await g.renderBriskest({ synth: fakeSynth([12.1, 8.8, 9.7]), takes: 3 });
  ok('three draws of 12.1 / 8.8 / 9.7 s → the 8.8 s take is cached', () => {
    assert.strictEqual(r.keptSeconds.toFixed(1), '8.8');
    assert.strictEqual(r.audio.length, buf(8.8).length);
    assert.deepStrictEqual(r.seconds.map((s) => s.toFixed(1)), ['12.1', '8.8', '9.7']);
    assert.strictEqual(r.failed, 0);
  });

  let calls = 0;
  await g.renderBriskest({ synth: () => { calls++; return Promise.resolve(buf(9)); }, takes: 3 });
  ok('the synth is called once per take', () => assert.strictEqual(calls, 3));

  const one = await g.renderBriskest({ synth: fakeSynth([11.2]), takes: 1 });
  ok('GREETING_TAKES=1 is the old single draw', () => assert.strictEqual(one.seconds.length, 1));

  let k = 0;
  const partial = await g.renderBriskest({ synth: () => (k++ === 0 ? Promise.reject(new Error('sarvam 503')) : Promise.resolve(buf(9.5 + k))), takes: 3 });
  ok('one failed take does not cost the boot: the best of the remaining two is kept', () => {
    assert.strictEqual(partial.failed, 1);
    assert.strictEqual(partial.seconds.length, 2);
    assert.strictEqual(partial.keptSeconds.toFixed(1), '11.5');
  });

  let threw = null;
  try { await g.renderBriskest({ synth: () => Promise.reject(new Error('sarvam down')), takes: 2 }); } catch (e) { threw = e; }
  ok('every take failing surfaces the error (the caller logs and greets live)', () => assert.match(String(threw && threw.message), /sarvam down/));

  ok('takes are clamped to 1…6 and tolerate junk', () => {
    assert.strictEqual(g.clampTakes('0'), 1); assert.strictEqual(g.clampTakes('abc'), 1);
    assert.strictEqual(g.clampTakes('3'), 3); assert.strictEqual(g.clampTakes('50'), 6);
  });

  ok('the boot pre-cache in callHandler renders through renderBriskest with config.greetingTakes', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'callHandler.js'), 'utf8');
    assert.ok(/renderBriskest\(\{\s*takes: config\.greetingTakes/.test(src), 'preloadGreeting uses renderBriskest(takes: config.greetingTakes)');
    assert.strictEqual(require('../config').greetingTakes, 3, 'default three takes');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
