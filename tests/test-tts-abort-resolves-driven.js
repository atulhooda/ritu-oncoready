#!/usr/bin/env node
'use strict';
// A BARGE-IN WHILE THE TTS SOCKET IS STILL CONNECTING IS AN ABORT, NOT A FAILURE.
// ws emits 'error' before 'close' when close() lands on a CONNECTING socket; the
// error listener rejected the streamTTS promise, so speak()/_speakSentence()
// fell back to HTTP and played the interrupted sentence AFTER the clear. Driven
// with the real ws library: abort immediately after dialing → must resolve.
// Run:            node tests/test-tts-abort-resolves-driven.js
// Prove it fails: MUTANT=MUT-ABORT-REJECTS node tests/test-tts-abort-resolves-driven.js
require('./_bootstrap');
require('./_bootstrap').unpin('ENABLE_TTS_PREWARM', 'false', 'the cold-dial abort path itself is under test; a warm slot would mask it');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const Module = require('module');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);
const GUARD = "if (aborted) { if (!resolved) { resolved = true; resolve(); } return; }";
function loadSarvam() {
  const file = path.join(__dirname, '..', 'sarvam.js'); let src = fs.readFileSync(file, 'utf8');
  if (MUTANT === 'MUT-ABORT-REJECTS') { assert.ok(src.includes(GUARD), 'guard line not found — the mutant patches nothing'); src = src.replace(GUARD, ''); }
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); m._compile(src, file); return m.exports;
}
(async () => {
  console.log('\nTTS ABORT DURING CONNECT — driven\n');
  const sarvam = loadSarvam();
  const config = require('../config'); if (!config.sarvam.apiKey) config.sarvam.apiKey = 'test-key';
  const h = sarvam.streamTTS('Hello, one moment please.', () => {}, { languageCode: 'en-IN', speaker: 'anushka' });
  h.abort(); // the barge-in lands while the socket is CONNECTING
  let outcome; try { await h; outcome = 'resolved'; } catch (e) { outcome = 'rejected: ' + e.message; }
  ok('abort on a CONNECTING socket resolves (no HTTP fallback, nothing spoken over the patient)', () => assert.strictEqual(outcome, 'resolved'));
  ok('the handle still reports how the socket was acquired', () => assert.strictEqual(h.acquiredWarm, false));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
