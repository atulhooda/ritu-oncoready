#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE PROMPT'S EXAMPLE DATE MUST BE TODAY.
//
// The two sentinel examples carried "2026-06-22T18:30:00+05:30" as a literal —
// correct on the day it was typed, two months stale by August. So the prompt
// showed the model an accurate CURRENT DATE line and then, a few lines later,
// an example dateTime from a different month with the SAME day-of-month.
//
// This is not claimed to have caused any specific misbooking. It is a defect
// that is wrong BY CONSTRUCTION and grows every day it ships, sitting next to
// the rule that tells the model to compute dates from the current line.
//
// The class: any date literal in a prompt is stale the moment it is written.
// This test fails the build if one reappears.
//
// Run: node tests/test-prompt-example-date.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const lean = require('../brain-lean');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };

lean._setRosterForTest({ text: '', doctors: [{
  id: 'd', name: 'Dr. A', specialty: 'GP', fee_inr: 300, is_on_call: false,
  schedule: 'Mon 10:00-13:00', windows: [{ dow: 1, start: '10:00', end: '12:30' }], taken: [],
}] });
const prompt = lean.buildSystemPrompt({ rosterSlice: lean.sliceRoster([], {}), hindiInCall: true });
const todayIST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

console.log('\n[1] every literal example date is today');
{
  const literals = [...prompt.matchAll(/"dateTime":"(\d{4}-\d{2}-\d{2}[^"]*)"/g)].map((m) => m[1]);
  ok('the sentinel spec has literal dateTime examples at all', () => assert(literals.length >= 1));
  ok('every one is today in IST', () => assert(
    literals.every((d) => d.startsWith(todayIST)),
    `found ${JSON.stringify(literals)}, today is ${todayIST}`));
}

console.log('\n[2] the CURRENT DATE line and the examples agree');
{
  // A model told "today is 22 August" and shown an example from June has been
  // given two different answers to the same question.
  const m = prompt.match(/CURRENT DATE\/TIME \(IST\): \w+, (\d{1,2}) (\w+) (\d{4})/);
  ok('the current-date line is present', () => assert(m, 'no CURRENT DATE line'));
  if (m) {
    const [, dd, monthName, yyyy] = m;
    const monthNum = String(new Date(`${monthName} 1, ${yyyy}`).getMonth() + 1).padStart(2, '0');
    const stated = `${yyyy}-${monthNum}-${String(dd).padStart(2, '0')}`;
    ok('it matches the example dates', () => assert.strictEqual(stated, todayIST));
  }
}

console.log('\n[3] no hardcoded date literal survives anywhere in the prompt');
{
  // The class, not the instance. Any YYYY-MM-DD that is not today is a date
  // someone typed and the clock has since left behind.
  const all = [...prompt.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((x) => x[1]);
  const stale = all.filter((d) => d !== todayIST);
  ok('no stale date literal anywhere', () => assert.strictEqual(stale.length, 0,
    `stale: ${JSON.stringify([...new Set(stale)])}`));
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
console.log('✓ The prompt cannot ship a date the clock has left behind.');
process.exit(0);
