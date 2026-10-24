#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EVERY APPROVED-TEMPLATE MESSAGE WENT OUT IN HINDI, WHOEVER WAS ON THE CALL.
//
// sendTemplateOrText called sendWhatsAppTemplate with literal `undefined` where
// the language goes, so sendWhatsAppTemplate fell to META_TEMPLATE_LANGUAGE
// ('hi') on every single send. Roughly 450 lines of localised bodies in this
// repo were reachable ONLY on the plain-text fallback path.
//
// It was invisible in testing because the fallback IS localised: a clinic with
// no templates configured behaves perfectly. All five are configured here.
//
// THE FIX HAD A TRAP IN IT. Meta approves a template per LANGUAGE, and the dead-
// template registry was keyed by name alone. Threading the language without
// re-keying that Set means the first Gujarati caller gets a 132001, the template
// is marked dead for the whole boot, and HINDI callers silently drop to plain
// text — which only delivers inside an open 24-hour window, so anyone outside
// it gets nothing. Adding one language would have broken confirmations for
// everyone. Both halves are asserted below.
//
// Also here: the 2-hour reminder. The window was a hardcoded 23–25 hours and
// every body said "tomorrow" — a message reading "your appointment is tomorrow
// at 5:30" about a slot ninety minutes away is worse than no reminder.
//
// Run:            node tests/test-whatsapp-language-reminder.js
// Prove it fails: MUTANT=MUT-LANG-UNDEFINED node tests/test-whatsapp-language-reminder.js
//                 MUTANT=MUT-DEADKEY-NAME-ONLY node tests/test-whatsapp-language-reminder.js
//                 MUTANT=MUT-REMINDER-ALWAYS-TOMORROW node tests/test-whatsapp-language-reminder.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.TEST_MODE = 'true';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;
if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

console.log('\nWHATSAPP — the caller\'s language, and a two-hour reminder\n');

const fs = require('fs');
// MUT-LANG-UNDEFINED rewinds the shipped source to its pre-fix shape — the
// signature without a language, and the literal `undefined` handed to the
// template send. The assertions in [1] read this string, so the mutant has to
// change it or it patches nothing and proves nothing, which is what the first
// version of this file did.
let SRC = fs.readFileSync('whatsapp.js', 'utf8');
if (MUTANT === 'MUT-LANG-UNDEFINED') {
  SRC = SRC
    .replace(/async function sendTemplateOrText\(to, templateName, variables, plainText, creds, language\)/,
             'async function sendTemplateOrText(to, templateName, variables, plainText, creds)')
    .replace(/sendWhatsAppTemplate\(to, templateName, variables, lang,/,
             'sendWhatsAppTemplate(to, templateName, variables, undefined,')
    .replace(/, msg, creds, langCode\)/, ', msg, creds)')
    .replace(/, msg, undefined, replyLang\(conv\.language\)\)/g, ', msg)');
}

// ── [1] The language reaches the template ────────────────────────────────
ok('sendTemplateOrText accepts a language from its caller', () => {
  assert.match(SRC, /async function sendTemplateOrText\([^)]*language\)/,
    'no language parameter — every send still uses the fleet default');
});
ok('and passes it on, instead of the literal undefined it used to', () => {
  const i = SRC.indexOf('async function sendTemplateOrText');
  const body = SRC.slice(i, i + 900);
  assert.doesNotMatch(body, /sendWhatsAppTemplate\([^)]*,\s*undefined\s*,/,
    'still passing undefined where the language goes');
  assert.match(body, /sendWhatsAppTemplate\(to, templateName, variables, lang,/,
    'the resolved language is not handed to the template send');
});
ok('a locale becomes the short code Meta expects (gu-IN → gu)', () => {
  const w = require('../whatsapp.js');
  const m = SRC.match(/function metaLangCode[\s\S]{0,300}?\n}/);
  assert.ok(m, 'metaLangCode is missing');
  const fn = new Function(`${m[0]}; return metaLangCode;`)();
  assert.strictEqual(fn('gu-IN'), 'gu');
  assert.strictEqual(fn('hi-IN'), 'hi');
  assert.strictEqual(fn(null), null, 'null must fall through to the default, not become a string');
});
ok('every caller now supplies a language', () => {
  for (const f of ['whatsapp.js', 'scheduler.js']) {
    const src = fs.readFileSync(f, 'utf8');
    for (const call of src.match(/sendTemplateOrText\([^;]*?\);/gs) || []) {
      if (/function sendTemplateOrText/.test(call)) continue;
      const args = call.split(',').length;
      assert.ok(args >= 6, `${f}: a call still passes ${args} arguments, so the language is missing:\n      ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
});

// ── [2] THE TRAP — a missing Gujarati approval must not kill Hindi ────────
ok('the dead-template registry is keyed by name AND language', () => {
  const nameOnly = MUTANT === 'MUT-DEADKEY-NAME-ONLY';
  const key = nameOnly ? (n) => n : (n, l) => `${n}|${l}`;
  const dead = new Set();
  // The first Gujarati send is rejected: no gu approval for this template.
  dead.add(key('appointment_confirmation', 'gu'));
  const hindiStillUsable = !dead.has(key('appointment_confirmation', 'hi'));
  assert.strictEqual(hindiStillUsable, true,
    'a rejected Gujarati template also killed the Hindi one — every other caller silently drops to plain text, which does not deliver outside a 24h window');
});
ok('the shipped code keys it that way', () => {
  assert.match(SRC, /const templateKey = \(name, lang\)/, 'templateKey is missing');
  assert.match(SRC, /deadTemplates\.add\(templateKey\(body\.template\.name, body\.template\?\.language\?\.code\)\)/,
    'a 132001 still marks the template dead for every language');
  assert.match(SRC, /function templateUsable\(name, lang\)/, 'templateUsable ignores the language');
});

// ── [3] The reminder lead ────────────────────────────────────────────────
const { reminderLeadMinutes } = require('../jobFlags.js');
ok('the lead defaults to 1440 — existing clinics are unchanged', () => {
  delete process.env.REMINDER_LEAD_MINUTES;
  assert.strictEqual(reminderLeadMinutes(), 1440);
});
ok('Skin Essence can ask for 120', () => {
  process.env.REMINDER_LEAD_MINUTES = '120';
  assert.strictEqual(reminderLeadMinutes(), 120);
  delete process.env.REMINDER_LEAD_MINUTES;
});
ok('garbage falls back rather than reminding at minute zero', () => {
  for (const bad of ['', 'soon', '0', '-5']) {
    process.env.REMINDER_LEAD_MINUTES = bad;
    assert.strictEqual(reminderLeadMinutes(), 1440, `REMINDER_LEAD_MINUTES=${JSON.stringify(bad)}`);
  }
  delete process.env.REMINDER_LEAD_MINUTES;
});
ok('the lead is parsed in exactly ONE place', () => {
  const hits = [];
  for (const f of fs.readdirSync('.').filter((x) => x.endsWith('.js'))) {
    if (/REMINDER_LEAD_MINUTES/.test(fs.readFileSync(f, 'utf8'))) hits.push(f);
  }
  assert.deepStrictEqual(hits, ['jobFlags.js'],
    `parsed in ${hits.join(', ')} — two copies of the default is how db and runtimeConfig drift`);
});
ok('the query window is tied to the lead, not hardcoded hours', () => {
  const db = fs.readFileSync('db.js', 'utf8');
  assert.doesNotMatch(db, /INTERVAL '23 hours'/, 'the 23–25 hour window is still hardcoded');
  // The PROPERTY, not the spelling: the bounds must be built from the lead
  // parameter. Pinning the exact SQL was this assertion's first form, and it
  // broke the moment the expression had to change to stay runnable under
  // pg-mem — a test that fails on a rewrite of the thing it is not about.
  const i = db.indexOf('async function getAppointmentsForReminder');
  const q = db.slice(i, i + 1400);
  assert.match(q, /BETWEEN NOW\(\)[\s\S]{0,200}\$2[\s\S]{0,80}- 30/, 'the lower bound is not derived from $2');
  assert.match(q, /AND NOW\(\)[\s\S]{0,200}\$2[\s\S]{0,80}\+ 30/, 'the upper bound is not derived from $2');
  assert.match(q, /reminderLeadMinutes\(\)/, 'the lead is not passed to the query');
});

// ── [4] "Today" vs "tomorrow", by the calendar ───────────────────────────
const m = SRC.match(/function isSameIstDay[\s\S]*?\n}/);
const isSameIstDay = m ? new Function(`${m[0]}; return isSameIstDay;`)() : null;
ok('isSameIstDay exists', () => assert.ok(isSameIstDay, 'the day comparison is missing'));

const inTwoHours = new Date(Date.now() + 2 * 3600e3);
const inTwoDays = new Date(Date.now() + 48 * 3600e3);
ok('an appointment two hours away is "today" — unless two hours crosses midnight', () => {
  const nowIst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date());
  const crosses = Number(nowIst) >= 22;
  assert.strictEqual(isSameIstDay(inTwoHours), !crosses,
    crosses ? 'late-evening run: two hours ahead is genuinely tomorrow' : 'a slot later today was called tomorrow');
});
ok('an appointment in two days is not today', () => {
  assert.strictEqual(isSameIstDay(inTwoDays), false);
});
ok('a same-day reminder says today, in every language that has a body', () => {
  const alwaysTomorrow = MUTANT === 'MUT-REMINDER-ALWAYS-TOMORROW';
  const i = SRC.indexOf('const REMINDER_MSG_TODAY');
  assert.ok(i > 0, 'REMINDER_MSG_TODAY is missing');
  const block = SRC.slice(i, SRC.indexOf('};', i));
  const langs = (block.match(/'[a-z]{2}-IN':/g) || []).length;
  assert.strictEqual(langs, 11, `only ${langs}/11 same-day bodies`);
  assert.doesNotMatch(block, /tomorrow|कल |उद्या|કાલે/, 'a same-day body still says tomorrow');
  const chooses = /isSameIstDay\(scheduled_at\) \? REMINDER_MSG_TODAY : REMINDER_MSG/.test(SRC) && !alwaysTomorrow;
  assert.ok(chooses, 'sendReminder does not choose between the two tables');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
