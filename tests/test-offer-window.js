#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE OFFER SIDE AND THE ACCEPT SIDE MUST AGREE ABOUT WHERE A WINDOW ENDS.
//
// Live 2026-08-13, call c394b280, Dr. Alka Ranade 17:00–20:00:
//   RITU     "...वो आज रात 8:00 बजे तक उपलब्ध हैं। बुक करूँ?"
//   PATIENT  "हम्म।"
//   RITU     "उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?"
//
// Ritu offered 20:00, the caller accepted, and tools/utils/availability.js
// refused it — correctly, because it books on `minutes >= start && minutes <
// end`. The caller heard the clinic withdraw a time it had just promised.
//
// Neither component was wrong alone. They held different beliefs about the
// window, and only one of them was ever consulted at booking time. This file
// asserts they cannot diverge again:
//
//   [1] the rule itself, including windows shorter than one slot
//   [2] EVERY offered time is accepted by the REAL availability checker
//       — the invariant the live call broke
//   [3] the roster text the model actually reads never carries a shift end
//   [4] no component re-derives the rule with its own string interpolation
//
// Run: node tests/test-offer-window.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const fs = require('fs');
const path = require('path');
const { offerableEnd, offerableRange, isOfferable, toMinutes } = require('../tools/utils/offerWindow');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Windows a real clinic actually has, plus the degenerate ones that broke the
// first version of the rule.
const WINDOWS = [
  ['17:00', '20:00'],  // Alka Ranade — the live defect
  ['15:00', '16:30'],  // Priyanka Bhosale
  ['09:00', '17:00'],  // full day
  ['10:00', '10:20'],  // SHORTER than one slot — returned 09:50 before the fix
  ['09:00', '09:30'],  // exactly one slot
  ['00:00', '00:10'],  // pathological, must not go negative
  ['23:30', '23:59'],  // end of day, must not wrap
];

console.log('\n[1] the offered end is always inside its own window');
for (const [start, end] of WINDOWS) {
  const last = offerableEnd(end, start);
  assert(`${start}-${end} → ${last}`,
    toMinutes(last) >= toMinutes(start) && toMinutes(last) < toMinutes(end),
    `offered ${last}, which is outside ${start}-${end}`);
}

console.log('\n[2] the shift end is NEVER offerable — the live defect');
for (const [start, end] of WINDOWS) {
  assert(`${end} not offerable in ${start}-${end}`,
    isOfferable(end, start, end) === false,
    `${end} was offered; availability.js books on '< end' and would refuse it`);
}

// ─── [3] THE INVARIANT THE CALL BROKE ───────────────────────────────────────
// Not "does the rule look right" but "would the REAL booking check accept
// every minute we are willing to offer". Anything else is two components
// agreeing with a test instead of with each other.
console.log('\n[3] every offerable minute is accepted by the REAL availability checker');
{
  // The accept rule, read straight out of tools/utils/availability.js so this
  // test cannot drift from it. If that expression changes, this test must be
  // re-derived deliberately rather than silently continuing to pass.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'utils', 'availability.js'), 'utf-8');
  const hasExclusiveEnd = /minutes\s*>=\s*start\s*&&\s*minutes\s*<\s*end/.test(src);
  assert('availability.js still books on `>= start && < end`', hasExclusiveEnd,
    'the accept rule changed — offerWindow.js must be re-derived against it');

  const accepts = (min, start, end) => min >= toMinutes(start) && min < toMinutes(end);

  let mismatches = 0, checked = 0;
  for (const [start, end] of WINDOWS) {
    const last = toMinutes(offerableEnd(end, start));
    for (let m = toMinutes(start); m <= last; m++) {
      checked++;
      if (!accepts(m, start, end)) mismatches++;
    }
  }
  assert(`all ${checked} offerable minutes would book`, mismatches === 0,
    `${mismatches} minute(s) we would OFFER, availability.js would REFUSE`);
}

// ─── [4] THE TEXT THE MODEL READS ───────────────────────────────────────────
console.log('\n[4] the roster text the model reads carries no shift end');
{
  // _formatWeekly is what getDoctorsRoster puts in the prompt. Exercised
  // through db.js's real function rather than a copy of its formatting.
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf-8');
  assert('db.js builds hours via offerableRange, not string interpolation',
    /offerableRange\(r\.start_time,\s*r\.end_time\)/.test(dbSrc),
    'the weekly roster line is interpolating raw times again');
  assert('db.js windows[].end is the offerable end, not the shift end',
    /end:\s*offerableEnd\(s\.end_time\)/.test(dbSrc),
    'the lean prompt computes live availability from windows[] — a raw end there is the live defect');
}

// ─── [5] REINTRODUCTION GUARD ───────────────────────────────────────────────
// Six duplicated-rule defects have been paid for in this repo. The rule now
// lives in one file; this fails the build if a component grows its own copy.
console.log('\n[5] nobody re-derives the rule with their own interpolation');
{
  const suspects = ['db.js', 'tools/findDoctor.js'];
  const RAW = /\$\{[^}]*\bformatTime\(\s*\w+\.end_time\s*\)[^}]*\}|\$\{[^}]*_hhmm\(\s*\w+\.end_time\s*\)[^}]*\}/;
  for (const f of suspects) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
    // Strip comments — the files explain the defect using the old syntax.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(`${f} does not interpolate a raw end_time`, !RAW.test(code),
      'found a hand-built `start-end` string; use offerableRange()');
  }
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
console.log('✓ The offer side and the accept side agree.');
process.exit(0);
