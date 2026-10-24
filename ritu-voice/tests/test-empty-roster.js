#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A CLINIC WITH NO BOOKABLE DOCTOR IS THE STATE EVERY NEW CLINIC STARTS IN.
//
// The deploy goes live and the phone number is routed before anyone has entered
// a doctor. Tested against the real model on a virgin database, Ritu said:
//
//     "आज के लिए कोई डॉक्टर उपलब्ध नहीं हैं। क्या मैं आपके लिए कल का समय देखूँ?"
//
// She did not invent a doctor — the anti-fabrication rule held, and that is the
// part that would have been dangerous. But tomorrow is empty too, and the day
// after, so the caller is offered a date that can never exist and every future
// call repeats it. A dead end that sounds like progress is worse than an
// honest no, and it is what an onboarding clinic's first callers would hear.
//
// Cause: an empty roster changed the LIST while leaving the INSTRUCTIONS
// ("offer the soonest", "offer the next available day") intact. Same shape as
// the offer/accept split in ae16022 — one half of the system knew something the
// other half was never told.
//
// These assertions run on buildSystemPrompt directly. No network, no model:
// what is being tested is that the INSTRUCTIONS change, which is deterministic.
// Whether the model then obeys them was verified by hand against a live call
// (see the commit) and is not something a unit test can honestly claim.
//
// Run: node tests/test-empty-roster.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const lean = require('../brain-lean');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DOC = {
  id: 'd1', name: 'Dr. Test', specialty: 'General Physician', fee_inr: 300,
  is_on_call: false, schedule: 'Mon-Sat 10:00-13:00',
  windows: [{ dow: 1, start: '10:00', end: '12:30' }], taken: [],
};
const ONCALL = { ...DOC, id: 'd2', name: 'Dr. OnCall', is_on_call: true };

const promptFor = (doctors) => {
  lean._setRosterForTest({ text: '', doctors });
  return lean.buildSystemPrompt({ rosterSlice: lean.sliceRoster([], {}) });
};

console.log('\n[1] no doctors at all — the newly onboarded clinic');
{
  const p = promptFor([]);
  assert('says the configuration is incomplete, not that the list is empty',
    /koi bookable doctor set nahi hua/i.test(p), 'the no-roster block is missing');
  assert('FORBIDS offering an appointment', /Appointment offer KABHI mat kar/i.test(p));
  assert('specifically forbids "shall I check tomorrow?"',
    /kal ka time dekhun|kal dekh leti hoon/i.test(p),
    'the exact dead-end phrase the live call produced is not named');
  assert('routes to REQUEST_CALLBACK instead', /REQUEST_CALLBACK/.test(p));

  // The instructions that CAUSED the loop must be gone, not merely contradicted.
  // A prompt holding both "offer the soonest doctor" and "never offer an
  // appointment" is a coin flip, and the model would be right either way.
  assert('the "soonest available today" instruction is GONE',
    !/AAJ SABSE JALDI AVAILABLE/.test(p),
    'the contradicting instruction survived — the model is being told both things');
  assert('the "offer the next available day" line is GONE',
    !/AGLA available din offer kar/.test(p),
    'this is the exact instruction that produced the infinite tomorrow');
}

console.log('\n[2] on-call specialists only — still nothing bookable');
{
  // doctorLine already says "book mat kar, callback lagao" for on-call doctors,
  // so a roster of nothing but on-call staff has no bookable slot either. If
  // this counted as a roster, the caller would be offered an appointment with
  // someone the booking path refuses.
  const p = promptFor([ONCALL]);
  assert('an on-call-only roster is treated as no bookable doctor',
    /koi bookable doctor set nahi hua/i.test(p),
    'an on-call specialist was counted as bookable');
}

console.log('\n[3] a normal clinic is untouched');
{
  const p = promptFor([DOC]);
  assert('the real DOCTORS block is present', /yeh POORI list hai/.test(p));
  assert('the soonest-available instruction is present', /AAJ SABSE JALDI AVAILABLE/.test(p));
  assert('the no-roster block is absent', !/koi bookable doctor set nahi hua/i.test(p),
    'a clinic WITH a doctor was told it has none — this would stop every booking');
  assert('the doctor actually appears in the prompt', /Dr\. Test/.test(p));
}

console.log('\n[4] one real doctor beside on-call staff still books');
{
  const p = promptFor([ONCALL, DOC]);
  assert('a mixed roster is a normal roster', !/koi bookable doctor set nahi hua/i.test(p));
  assert('...and keeps the soonest instruction', /AAJ SABSE JALDI AVAILABLE/.test(p));
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
console.log('✓ An empty clinic takes a callback instead of promising tomorrow.');
process.exit(0);
