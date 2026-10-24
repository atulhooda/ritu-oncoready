#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// "SHALL I CONFIRM YOUR APPOINTMENT?" IS A QUESTION, NOT A CONFIRMATION.
//
// confirmGuards spots Ritu CLAIMING a booking that never committed. The Hindi
// branches carry a future-tense lookahead so an OFFER is not read as a claim:
//
//     (?:बुक|पक्का|कन्फर्म) कर द(?!ू|ें)        ← "बुक कर दूँ?" correctly ignored
//
// But the sibling branch has no such guard:
//
//     अपॉइंटमेंट.{0,28}(हो गई|कर दी|पक्की|फिक्स)
//
// so "क्या मैं आपकी अपॉइंटमेंट पक्की कर दूँ जी?" matches on
// अपॉइंटमेंट … पक्की, in BOTH claimsBooked and STREAMED_FALSE_CONFIRM.
//
// That is not academic. It is the wording of brain-lean's own `confirmBooking`
// canned line — the audited, server-side sentence it substitutes precisely WHEN
// it has suppressed a false confirmation. So the safe replacement trips the
// guard that produced it, and on the streaming voice path a legitimate offer is
// treated as a false claim.
//
// BOTH ARMS, always: a lookahead that silences offers must not silence real
// claims. Every fixture below is asserted in the direction it belongs to, and
// the file is worthless without the CLAIM arm — narrowing a guard is exactly
// the change that quietly destroys recall.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { claimsBooked, STREAMED_FALSE_CONFIRM } = require('../confirmGuards');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// ── OFFERS: Ritu asking permission. Must NEVER be read as a claim. ──────────
const OFFERS = [
  'क्या मैं आपकी अपॉइंटमेंट पक्की कर दूँ जी?',   // brain-lean's own confirmBooking line
  'क्या मैं अपॉइंटमेंट पक्की कर दूँ?',
  'अपॉइंटमेंट पक्की कर दें जी?',
  'क्या मैं अपॉइंटमेंट बुक कर दूँ?',              // already correct — regression canary
  'डॉ. मेहता के साथ अपॉइंटमेंट पक्की करूँ?',
];

// ── CLAIMS: Ritu asserting it is done. Must ALWAYS be caught. ───────────────
const CLAIMS = [
  'आपकी अपॉइंटमेंट पक्की कर दी है।',
  'अपॉइंटमेंट बुक कर दी है।',
  'हो गया जी! अपॉइंटमेंट पक्की।',
  'जी, अपॉइंटमेंट पक्की कर दी।',
  'डॉ. मेहता के साथ आज शाम 5 बजे की अपॉइंटमेंट पक्की कर दी है।',
];

for (const t of OFFERS) {
  check(`OFFER not read as a claim — "${t.slice(0, 42)}…"`, () => {
    if (claimsBooked.test(t)) throw new Error('claimsBooked matched an offer');
    if (STREAMED_FALSE_CONFIRM.test(t)) throw new Error('STREAMED_FALSE_CONFIRM matched an offer');
  });
}

for (const t of CLAIMS) {
  check(`CLAIM still caught — "${t.slice(0, 42)}…"`, () => {
    if (!claimsBooked.test(t)) throw new Error('claimsBooked MISSED a real claim');
    if (!STREAMED_FALSE_CONFIRM.test(t)) throw new Error('STREAMED_FALSE_CONFIRM MISSED a real claim');
  });
}

// ── the checks must be able to fail ────────────────────────────────────────
check('MUTATION: the guards fire at all', () => {
  if (!claimsBooked.test('हो गया')) throw new Error('claimsBooked never fires — the CLAIM arm is vacuous');
  if (!STREAMED_FALSE_CONFIRM.test('अपॉइंटमेंट बुक कर दी')) throw new Error('STREAMED_FALSE_CONFIRM never fires');
});
check('MUTATION: the guards are not universal', () => {
  if (claimsBooked.test('आपको कौन सी तकलीफ़ है जी?')) throw new Error('claimsBooked matches anything — the OFFER arm is vacuous');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
