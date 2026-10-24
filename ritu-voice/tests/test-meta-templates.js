#!/usr/bin/env node
'use strict';
// THE TEMPLATE SET, SHAPED EXACTLY AS THE SERVER SENDS IT.
// sendWhatsAppTemplate passes positional body parameters; a template whose
// variable count differs from the sender's fails every send with 132000 (the
// "Engageo Agency" WABA carried a five-variable confirmation for exactly this
// reason). tools/metaTemplates.js VARS is the contract; this pins it on both
// sides: every text in every language, and the senders' call sites.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-THREE-PARAMS  — a text grows a {{3}} the sender never fills
//   MUTANT=MUT-MARKETING     — the category drifts to MARKETING (priced and gated differently)
//   MUTANT=MUT-NAME-SCRIPT   — the local-script name leaks into every language
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { const r = f(); if (r && typeof r.then === 'function') throw new Error('async callback passed to ok()'); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const tool = require('../tools/metaTemplates.js');
if (MUTANT === 'MUT-THREE-PARAMS') tool.TEMPLATE_TEXT.appointment_confirmation.gu += ' ડૉક્ટર: {{3}}';
if (MUTANT === 'MUT-MARKETING') { const real = tool.buildTemplate; tool.buildTemplate = (...a) => ({ ...real(...a), category: 'MARKETING' }); }
if (MUTANT === 'MUT-NAME-SCRIPT') { const real = tool.buildTemplate; tool.buildTemplate = (name, lang, names, opts) => real(name, lang, { ...names, en: names.local }, opts); }
const NAMES = { en: 'Skin Essence Cosmetic and Laser Center', local: 'સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટર' };
const vars = (s) => [...s.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
const { LANGS, VARS } = tool;
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);

console.log('\n[1] every template × language: exactly the variables the server sends, in order, never adjacent, examples match');
assert.deepStrictEqual(Object.keys(tool.TEMPLATE_TEXT).sort(), Object.keys(VARS).sort(), 'every text has a contract and vice versa');
for (const name of Object.keys(tool.TEMPLATE_TEXT)) for (const lang of LANGS) {
  ok(`${name} [${lang}] → ${VARS[name]} var(s)`, () => {
    const t = tool.buildTemplate(name, lang, NAMES, { localLang: 'gu' });
    const body = t.components.find((c) => c.type === 'BODY');
    assert.deepStrictEqual(vars(body.text), seq(VARS[name]), `variables: ${JSON.stringify(vars(body.text))}`);
    assert.ok(!/\}\}\s*\{\{/.test(body.text), 'adjacent variables are rejected by Meta');
    assert.ok(!/^\s*\{\{/.test(body.text) && !/\}\}\s*$/.test(body.text), 'a body may not start or end with a variable');
    if (VARS[name] > 0) assert.strictEqual(body.example.body_text[0].length, VARS[name], 'one sample value per variable');
    else assert.strictEqual(body.example, undefined, 'no example block without variables');
    assert.strictEqual(t.category, 'UTILITY');
    assert.strictEqual(t.language, lang); assert.strictEqual(t.name, name);
    assert.ok(body.text.length <= 1024, 'body ≤ 1024 chars');
    assert.ok(!/[\n\t]/.test(body.text), 'no newline/tab');
    // gu is the clinic's own language → local script; hi/mr/en → the Latin name.
    const expectName = lang === 'gu' ? NAMES.local : NAMES.en;
    assert.ok(body.text.includes(expectName), `clinic name in the right script (${lang})`);
    if (lang !== 'gu') assert.ok(!body.text.includes(NAMES.local), 'Gujarati name must not appear inside a non-Gujarati sentence');
    assert.ok(!/\{clinic\}/.test(body.text), 'placeholder left in');
    assert.ok(!/(offer|discount|free|% off|ऑफर|ऑफ़र|ઓફર|छूट)/i.test(body.text), 'no promotional wording (Meta would reclassify as MARKETING)');
  });
}

console.log('\n[2] the shape the server sends fits these templates');
ok('sendWhatsAppTemplate builds positional body parameters in numeric order', () => {
  const keys = Object.keys({ '2': 'b', '1': 'a', '3': 'c' }).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)); assert.deepStrictEqual(keys, ['1', '2', '3']);
});
ok('the senders pass exactly VARS variables', () => {
  const fs = require('fs'), path = require('path');
  const wa = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.ok(/sendTemplateOrText\(phone, confirmTmpl, \{ "1": name, "2": timeStr \}/.test(wa), 'confirmation sends {1,2}');
  assert.strictEqual(VARS.appointment_confirmation, 2);
  assert.ok(/\{ "1": patient_name \|\| 'Patient', "2": whenStr \}/.test(wa), 'reminder sends {1,2} with the full date-time');
  assert.strictEqual(VARS.appointment_reminder, 2);
  assert.ok(/sendTemplateOrText\(phone_number, followupTmpl,\s*\{ "1": patient_name \|\| 'Patient' \}/.test(wa), 'follow-up sends {1}');
  assert.strictEqual(VARS.appointment_followup, 1);
  assert.ok(/sendTemplateOrText\(appt\.phone_number, noShowTmpl, \{\}/.test(sched), 'no-show sends no variables');
  assert.strictEqual(VARS.no_show_recovery, 0);
  assert.ok(/sendTemplateOrText\(call\.caller_phone, missedTmpl, \{\}/.test(sched), 'missed-call sends no variables');
  assert.strictEqual(VARS.missed_call_recovery, 0);
});
ok('config names every template the tool creates', () => {
  const config = require('../config');
  const t = config.whatsapp.templates;
  assert.deepStrictEqual(
    [t.confirmation, t.reminder, t.followup, t.no_show, t.missed_call, t.leave, t.staff_alert].sort(),
    Object.keys(VARS).sort());
});

console.log('\n[3] the clinic name follows the language');
ok('local script for the clinic\'s own language, Latin elsewhere, explicit --name-<lang> wins', () => {
  assert.strictEqual(tool.nameFor('gu', NAMES, 'gu'), NAMES.local);
  assert.strictEqual(tool.nameFor('hi', NAMES, 'gu'), NAMES.en);
  assert.strictEqual(tool.nameFor('en', NAMES, 'gu'), NAMES.en);
  assert.strictEqual(tool.nameFor('hi', { ...NAMES, hi: 'स्किन एसेंस' }, 'gu'), 'स्किन एसेंस');
  // the demo: no CLINIC_NAME, only a Latin greeting name → used everywhere
  assert.strictEqual(tool.nameFor('mr', { en: '', local: 'Smile Multispeciality Clinic' }, 'en'), 'Smile Multispeciality Clinic');
});
ok('a missing clinic name is refused, not submitted blank', () => assert.throws(() => tool.buildTemplate('appointment_reminder', 'en', { en: '', local: '' }), /clinic name/));
ok('an unknown language is refused', () => assert.throws(() => tool.buildTemplate('appointment_reminder', 'xx', NAMES), /no text/));
ok('checkText names the defect', () => {
  assert.match(tool.checkText('appointment_followup', 'Hi {{1}} {{2}}'), /variables/);
  assert.match(tool.checkText('appointment_followup', '{{1}} hi'), /start or end/);
  assert.match(tool.checkText('appointment_followup', 'Hi {{1}}\nthere'), /newline/);
  assert.strictEqual(tool.checkText('appointment_followup', 'Hi {{1}}, thanks.'), null);
});

console.log('\n[4] readiness reads Meta\'s list the way a receptionist would');
ok('MISSING / PENDING / APPROVED / REJECTED(reason) per cell, approved count', () => {
  const r = tool.readiness([
    { name: 'appointment_confirmation', language: 'en', status: 'APPROVED' },
    { name: 'appointment_reminder', language: 'gu', status: 'PENDING' },
    { name: 'no_show_recovery', language: 'gu', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' },
  ], ['gu', 'en']);
  const row = (n) => r.table.find((x) => x.name === n);
  assert.strictEqual(row('appointment_confirmation').en, 'APPROVED');
  assert.strictEqual(row('appointment_confirmation').gu, 'MISSING');
  assert.strictEqual(row('appointment_reminder').gu, 'PENDING');
  assert.strictEqual(row('no_show_recovery').gu, 'REJECTED(INVALID_FORMAT)');
  assert.strictEqual(r.approved, 1); assert.strictEqual(r.total, 14);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
process.exit(fail ? 1 : 0);
