#!/usr/bin/env node
// Tests for tools/utils/phoneNormalizer.js
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { normalizePhone, toE164 } = require('../tools/utils/phoneNormalizer');

const cases = [
  // ─── Variations of the same number, all → 9876543210 ─────────────────
  ['9876543210',         '9876543210'],
  ['98765 43210',        '9876543210'],
  ['98765-43210',        '9876543210'],
  ['(987) 654-3210',     '9876543210'],
  ['09876543210',        '9876543210'],
  ['919876543210',       '9876543210'],
  ['+919876543210',      '9876543210'],
  ['+91 98765 43210',    '9876543210'],
  ['+91-98765-43210',    '9876543210'],
  ['  +91 98765 43210 ', '9876543210'],

  // ─── Different valid Indian mobile prefixes ──────────────────────────
  ['+916123456789',  '6123456789'],
  ['+917000000000',  '7000000000'],
  ['+918000000000',  '8000000000'],

  // ─── Invalid input → null ────────────────────────────────────────────
  ['',               null],
  [null,             null],
  [undefined,        null],
  ['abc',            null],
  ['123',            null],          // too short
  ['12345678901234', null],          // too long even after country-code strip
  ['+915432109876',  null],          // starts with 5 — not a valid Indian mobile prefix
  ['+1 555-1234',    null]           // US number; after digit-strip becomes 15551234 (8 digits)
];

let pass = 0, fail = 0;
console.log('─── normalizePhone ───');
for (const [input, expected] of cases) {
  const got = normalizePhone(input);
  const ok = got === expected;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${String(JSON.stringify(input)).padEnd(28)} → ${JSON.stringify(got)} ${ok ? '' : `(expected ${JSON.stringify(expected)})`}`);
}

console.log('\n─── toE164 ───');
const e164Cases = [
  ['9876543210', '+919876543210'],
  ['6123456789', '+916123456789'],
  ['', null],
  [null, null],
  ['12345', null],
  ['1876543210', null]    // doesn't start with 6-9
];
for (const [input, expected] of e164Cases) {
  const got = toE164(input);
  const ok = got === expected;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${String(JSON.stringify(input)).padEnd(28)} → ${JSON.stringify(got)} ${ok ? '' : `(expected ${JSON.stringify(expected)})`}`);
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail > 0) process.exit(1);
console.log('✓ All phoneNormalizer tests passing.');
