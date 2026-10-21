#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ON A TEXT CHANNEL, ANSWER IN THE ALPHABET THE PATIENT USED.
//
// Reported live: typing "hi" on WhatsApp got a reply in Devanagari. The chain:
//   whatsapp.js resolveInboundLanguage("hi", null) — no Indic script, so
//     detectLanguageCode returns en-IN, which is treated as "no strong signal"
//     (deliberately: a Kannada caller typing "haan theek hai" must stay Kannada)
//   → returns null → languageFields(null) sets hindiInCall
//   → the prompt says "reply in HINDI (Devanagari)"
// Two Latin letters in, Devanagari out, to someone who can SEE the reply.
//
// The fix is a SCRIPT signal, separate from language — and, critically, the
// removal of the rule that contradicted it. The prompt already said
// "Romanized Hindi KABHI nahi" (never). Adding a Hinglish rule beside it would
// have left the model holding both instructions, which is a coin flip: exactly
// the defect shape fixed in the empty-roster work.
//
// Voice has no script and must be byte-identical — asserted below.
//
// Run: node tests/test-reply-script.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const lean = require('../brain-lean');
const { inboundScript } = require('../whatsappChannel');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };

lean._setRosterForTest({ text: '', doctors: [{
  id: 'd', name: 'Dr. A', specialty: 'GP', fee_inr: 300, is_on_call: false,
  schedule: 'Mon 10:00-13:00', windows: [{ dow: 1, start: '10:00', end: '12:30' }], taken: [],
}] });
const P = (replyScript) => lean.buildSystemPrompt({
  rosterSlice: lean.sliceRoster([], {}), channel: 'whatsapp', replyScript, hindiInCall: true });

const ALLOW = /patient ne LATIN akshar mein likha hai/;
const BAN   = /Romanized Hindi \(aapka\/kya\/baje\) KABHI nahi/;

console.log('\n[1] the script detector');
ok('plain Latin is latin',        () => assert.strictEqual(inboundScript('hi'), 'latin'));
ok('Hinglish is latin',           () => assert.strictEqual(inboundScript('appointment chahiye'), 'latin'));
ok('Devanagari is indic',         () => assert.strictEqual(inboundScript('नमस्ते'), 'indic'));
ok('Kannada is indic',            () => assert.strictEqual(inboundScript('ನಮಸ್ಕಾರ'), 'indic'));
ok('mixed script counts as indic',() => assert.strictEqual(inboundScript('ok ठीक है'), 'indic'));
ok('digits alone give no signal', () => assert.strictEqual(inboundScript('12345'), null));
ok('empty gives no signal',       () => assert.strictEqual(inboundScript(''), null));

console.log('\n[2] a Latin message gets the Hinglish rule, and ONLY that rule');
{
  const p = P('latin');
  ok('Hinglish is instructed', () => assert(ALLOW.test(p)));
  // THE POINT OF THE FILE. Both present = the model is told two opposite things.
  ok('the "never Romanized Hindi" ban is GONE, not merely outvoted',
    () => assert(!BAN.test(p), 'the contradicting rule survived — the model is being told both'));
}

console.log('\n[3] an Indic message keeps the original rule');
{
  const p = P('indic');
  ok('the script-matching ban is present', () => assert(BAN.test(p)));
  ok('the Hinglish rule is absent',        () => assert(!ALLOW.test(p)));
}

console.log('\n[4] no signal falls back to today\'s behaviour');
{
  const p = P(null);
  ok('ban present when script is unknown', () => assert(BAN.test(p)));
  ok('no Hinglish rule',                   () => assert(!ALLOW.test(p)));
}

console.log('\n[5] VOICE is untouched — it has no script');
{
  const v = lean.buildSystemPrompt({ rosterSlice: lean.sliceRoster([], {}), hindiInCall: true });
  ok('voice keeps the original script rule', () => assert(BAN.test(v)));
  ok('voice never sees the Hinglish rule',   () => assert(!ALLOW.test(v)));
}

console.log(`\n${pass}/${pass + fail} passing`);
if (fail) { console.log('✗ FAILURES'); process.exit(1); }
console.log('✓ She answers in the alphabet she was written to.');
process.exit(0);
