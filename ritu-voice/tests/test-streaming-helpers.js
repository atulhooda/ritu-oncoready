#!/usr/bin/env node
// Offline unit tests for brain-streaming.js helpers (no LLM calls).
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { scanForBookingIntent, spokenRegion, nextSentence } = require('../brain-streaming');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n[scanForBookingIntent]');
assert('detects BOOK_APPOINTMENT', scanForBookingIntent('Ji.\nBOOK_APPOINTMENT:{"x":1}'));
assert('detects UPDATE_APPOINTMENT', scanForBookingIntent('Ji.\nUPDATE_APPOINTMENT:{"x":1}'));
assert('no false positive on plain text', !scanForBookingIntent('Aapko kya takleef hai?'));
assert('no false positive on PATIENT_NAME', !scanForBookingIntent('Ji.\nPATIENT_NAME:Rahul'));

console.log('\n[spokenRegion]');
assert('strips sentinel lines',
  spokenRegion('Ji bilkul, aapka naam?\nPATIENT_NAME:Rahul\nBOOK_APPOINTMENT:{}') === 'Ji bilkul, aapka naam?',
  JSON.stringify(spokenRegion('Ji bilkul, aapka naam?\nPATIENT_NAME:Rahul')));
assert('keeps multi-line spoken text',
  spokenRegion('Namaste.\nAapka naam kya hai?\nPATIENT_NAME:') === 'Namaste.\nAapka naam kya hai?');
assert('all-spoken returns whole text',
  spokenRegion('Aapko kya takleef hai?') === 'Aapko kya takleef hai?');

console.log('\n[nextSentence]');
{
  // Devanagari danda + Latin ? boundaries
  const s1 = 'जी बिल्कुल। आपका नाम क्या है?';
  const r1 = nextSentence(s1, 0);
  assert('emits up to last boundary', r1 && r1.cleaned === 'जी बिल्कुल। आपका नाम क्या है?', JSON.stringify(r1));
}
{
  // Incomplete trailing clause buffers
  const s2 = 'जी बिल्कुल। आपका नाम';
  const r2 = nextSentence(s2, 0);
  assert('emits complete sentence, buffers trailing clause', r2 && r2.cleaned === 'जी बिल्कुल।', JSON.stringify(r2));
  // After emitting, the remainder "आपका नाम" has no boundary → null
  const r2b = nextSentence(s2, r2.rawLen);
  assert('no further sentence until boundary', r2b === null);
}
{
  // No boundary yet
  assert('null when no boundary', nextSentence('Aapko kya', 0) === null);
}
{
  // Latin sentences
  const s3 = 'Ji bilkul. Aapka naam kya hai?';
  const r3 = nextSentence(s3, 0);
  assert('latin sentences emit to last boundary', r3 && r3.cleaned === 'Ji bilkul. Aapka naam kya hai?', JSON.stringify(r3));
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail > 0) process.exit(1);
console.log('✓ All streaming-helper tests passing.');
