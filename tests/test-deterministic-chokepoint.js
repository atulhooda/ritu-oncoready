#!/usr/bin/env node
'use strict';
// SOURCE-TEXT-OK: this is a structural claim with no runtime surface — that no
// call site outside the allowed set speaks directly. The BEHAVIOUR (a spoken
// deterministic line is in conversationHistory) is driven in
// tests/test-twin-parity.js [guards]; this file only keeps the next site from
// bypassing the chokepoint. Listed in tests/source-text-allowlist.txt.
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../callHandler.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const ALLOWED = [
  'greeting',            // await this.speak(greeting) / GREETING_TEXT — the first assistant turn, recorded by the greeting path
  'GREETING_TEXT',
  'spokenText',          // the model's own reply (processIntent records history itself)
  'emText',              // handleEmergency — the call ends
  'CRITICAL_ERROR_MESSAGE', // handleCriticalError — the call ends
  'text',                // inside _sayDeterministic itself
];
const sites = [...src.matchAll(/this\.speak\(([^)]*)\)/g)].map((m) => m[1].trim());
const strays = sites.filter((arg) => !ALLOWED.some((a) => arg.startsWith(a)));
ok(`every deterministic line goes through _sayDeterministic (stray speak() sites: ${strays.length})`, () => assert.deepStrictEqual(strays, [], `direct this.speak(...) with: ${strays.join(' | ')}`));
ok('the chokepoint pushes to history before speaking', () => assert.match(src, /_sayDeterministic\(text\) \{[\s\S]{0,300}conversationHistory\.push\(\{ role: 'assistant', content: text \}\);[\s\S]{0,80}return this\.speak\(text\);/));
console.log(`\n${pass}/${pass + fail} passing`); process.exit(fail ? 1 : 0);
