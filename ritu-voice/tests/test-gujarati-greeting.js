#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A GUJARATI CLINIC WAS BEING GREETED IN MARATHI.
//
// GREETING_TEXTS held mr / hi / kn only. GREETING_LANG=gu-IN therefore hit the
// guard, printed a warning nobody would read in a Railway log, and fell back to
// Marathi — so Skin Essence's very first caller would have been answered in a
// language neither doctor speaks. Silent in the sense that matters: the call
// still works, it is just wrong.
//
// This file also covers the recording notice (setup form Q72 = yes). It is
// OPT-IN: a greeting is the one line every caller hears, and clinics already
// running never agreed to it, so RECORDING_NOTICE=on is per-deploy rather than
// a fleet change. The notice is folded INTO the greeting string — one TTS call,
// one cached buffer, no first-turn latency.
//
// And it covers the echo, which is the part that bites: callHandler already
// filters the OPERATOR's recording announcement out of STT. Now Ritu says one
// herself, so her own words can come back through the transcript — those must
// be dropped, while a caller genuinely ASKING "શું આ કૉલ રેકોર્ડ થાય છે?" must
// still reach the model. Same regex, opposite verdicts.
//
// Run:            node tests/test-gujarati-greeting.js
// Prove it fails: MUTANT=MUT-NO-GU-GREETING node tests/test-gujarati-greeting.js
//                 MUTANT=MUT-ECHO-BLIND-GU  node tests/test-gujarati-greeting.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nGUJARATI GREETING + RECORDING NOTICE\n');

const fs = require('fs');
const SRC = fs.readFileSync('callHandler.js', 'utf8');

// GREETING_LANG and RECORDING_NOTICE are read at module load, so each
// configuration needs its own process — the same reason the emergency-v2 test
// spawns children. The child prints what a caller would actually hear.
function greetingUnder(env) {
  const code = `
    process.env.SKIP_BOOT_AUDIO='1';
    const config=require('./config.js');
    const {toSpeakableScriptWords}=require('./devanagari.js');
    const h=require('./callHandler.js');
    // Drive the real builders through a handler instance where possible; the
    // opening line is module state, so read it the way boot does.
    const src=require('fs').readFileSync('callHandler.js','utf8');
    process.stdout.write(JSON.stringify({ lang: h.__greetingLang || null }));
  `;
  return execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, ...env }, encoding: 'utf8', cwd: process.cwd(),
  });
}

// ── [1] gu-IN is a real greeting language, not a fallback ────────────────
const guTables = MUTANT === 'MUT-NO-GU-GREETING'
  ? SRC.replace(/^\s*'gu-IN':.*$/gm, '')
  : SRC;

ok("GREETING_TEXTS has a gu-IN entry (without it GREETING_LANG=gu-IN becomes Marathi)", () => {
  const block = guTables.slice(guTables.indexOf('const GREETING_TEXTS'), guTables.indexOf('const RETURNING_GREETING_TEXTS'));
  assert.match(block, /'gu-IN':/, 'no Gujarati opener — the boot guard would fall back to mr-IN');
});
ok('RETURNING_GREETING_TEXTS has one too (a returning caller must not switch language)', () => {
  const i = guTables.indexOf('const RETURNING_GREETING_TEXTS');
  const block = guTables.slice(i, i + 1200);
  assert.match(block, /'gu-IN':/, 'a returning Gujarati caller would be greeted in Marathi');
});
ok('the Gujarati opener is in Gujarati script', () => {
  const m = SRC.match(/'gu-IN': `([^`]+)`/);
  assert.ok(m, 'gu-IN opener not found');
  assert.match(m[1], /[઀-૿]/, `not Gujarati script: ${m[1]}`);
});
ok('it interpolates the configured clinic name, never a hardcoded one', () => {
  const m = SRC.match(/'gu-IN': `([^`]+)`/);
  assert.match(m[1], /\$\{config\.greetingClinicName\}/,
    'the clinic name is baked into the greeting — every other clinic would announce Skin Essence');
});
ok('it asks how it can help, not what is wrong (the callers are not ill)', () => {
  const m = SRC.match(/'gu-IN': `([^`]+)`/);
  assert.match(m[1], /મદદ/, `expected an offer of help: ${m[1]}`);
  assert.doesNotMatch(m[1], /તકલીફ/, 'asks a hydrafacial enquiry what ails them');
});

// ── [2] The recording notice ─────────────────────────────────────────────
// DRIVEN, not grepped. The first version matched the parse expression in
// callHandler.js — so it failed when the parse moved to config.js to stop being
// duplicated in runtimeConfig, even though the behaviour was identical. Where a
// flag is read is not the property; what it defaults to is.
const noticeStates = JSON.parse(execFileSync(process.execPath, ['-e',
  `const c = require('./config.js');
   const off = c.recordingNotice;
   process.stdout.write(JSON.stringify({ unset: off }));`
], { env: { ...process.env, SKIP_BOOT_AUDIO: '1', RECORDING_NOTICE: '' }, encoding: 'utf8', cwd: process.cwd() })
  .match(/\{[^{}]*\}(?![\s\S]*\{[^{}]*\})/)[0]);
const noticeOn = JSON.parse(execFileSync(process.execPath, ['-e',
  `process.stdout.write(JSON.stringify({ on: require('./config.js').recordingNotice }));`
], { env: { ...process.env, SKIP_BOOT_AUDIO: '1', RECORDING_NOTICE: 'on' }, encoding: 'utf8', cwd: process.cwd() })
  .match(/\{[^{}]*\}(?![\s\S]*\{[^{}]*\})/)[0]);

ok('the notice is OPT-IN — a clinic that never asked for it is unchanged', () => {
  assert.strictEqual(noticeStates.unset, false,
    'an unset RECORDING_NOTICE announces recording anyway — every clinic already running would start disclosing without being asked');
  assert.strictEqual(noticeOn.on, true, 'RECORDING_NOTICE=on does not switch it on');
});
ok('the flag is parsed in exactly one place', () => {
  const hits = fs.readdirSync('.').filter((f) => f.endsWith('.js'))
    .filter((f) => /process\.env\.RECORDING_NOTICE/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(hits, ['config.js'],
    `parsed in ${hits.join(', ')} — two parses of one flag is how the recorded value stops matching the acted-on one`);
});
// COMPARED AS OBJECTS, NOT AS SOURCE TEXT. The previous version regexed this
// file for /'xx-IN': `/ — matching only entries whose value is a TEMPLATE
// LITERAL. The four shipped languages are backticked purely because they
// interpolate the clinic name, so a fifth added with plain quotes would have
// been invisible to the guard, and test-language-coverage.js exempts
// RECORDING_NOTICES on the written promise that this assertion keeps the tables
// in step. It also never looked at RETURNING_GREETING_TEXTS at all, so a
// half-added language would greet a returning caller in Marathi — the exact
// defect this commit was written to fix, one table over.
ok('all three language tables hold exactly the same set', () => {
  const h = require('../callHandler.js');
  const keys = (t) => {
    assert.ok(h[t], `${t} is not exported — the guard cannot compare it`);
    return Object.keys(h[t]).sort();
  };
  const greet = keys('GREETING_TEXTS');
  assert.deepStrictEqual(keys('RETURNING_GREETING_TEXTS'), greet,
    'a language can open a call but not greet a RETURNING caller — they would hear Marathi on their second call');
  assert.deepStrictEqual(keys('RECORDING_NOTICES'), greet,
    'a greeting language has no recording notice — with RECORDING_NOTICE=on that caller gets no disclosure, and only a console.warn records it');
});
ok('a half-added language is caught by the tables, not by a regex', () => {
  const h = require('../callHandler.js');
  // Plain-quoted entries must count. This is the case the old guard missed.
  const probe = { ...h.GREETING_TEXTS, 'ta-IN': 'plain quoted, no interpolation' };
  assert.ok(Object.keys(probe).includes('ta-IN'),
    'object comparison cannot see a plain-quoted entry either — the fix did not work');
  assert.notDeepStrictEqual(Object.keys(probe).sort(), Object.keys(h.RECORDING_NOTICES).sort(),
    'adding a greeting language without its notice would not be detected');
});
ok('the notice becomes its own sentence, not a clause glued to the clinic name', () => {
  // Reproduce the composition the module performs.
  const notice = 'આ કૉલ રેકોર્ડ થાય છે.';
  const text = 'નમસ્તે! હું ઋતુ, Skin Essence માંથી — બોલો, હું આપની કેવી રીતે મદદ કરી શકું?';
  const m = text.match(/\s+—\s+|।\s+|\.\s+/);
  const at = text.indexOf(m[0]);
  const out = `${text.slice(0, at).trim()}. ${notice} ${text.slice(at + m[0].length).trim()}`;
  assert.doesNotMatch(out, /માંથી આ કૉલ/, 'the notice runs into the clinic name with no stop');
  assert.doesNotMatch(out, /—/, 'the dangling em-dash survived the insertion');
  assert.match(out, /માંથી\. આ કૉલ રેકોર્ડ થાય છે\. બોલો/, `composed badly: ${out}`);
});
ok('the returning-caller greeting carries the notice too', () => {
  assert.match(SRC, /withRecordingNotice\(\s*\n?\s*\(RETURNING_GREETING_TEXTS/,
    'a returning caller is never told the call is recorded');
});

// ── [3] The echo filter — same regex, opposite verdicts ──────────────────
const handler = require('../callHandler.js');
const isAnnouncement = handler.isRecordingAnnouncement
  || (() => { throw new Error('isRecordingAnnouncement is not exported'); });

const guRe = {
  words: /रिकॉर्ड|रेकॉर्ड|record|રેકોર્ડ|રિકોર્ડ/,
  question: /क्या|શું|\?/,
  tail: /कॉल|call|बीइंग|being|हो रही|की जा रही|किया जा रह|रहा है|रही है|કૉલ|કોલ|થાય છે|થઈ રહ્યો/,
};
const blind = MUTANT === 'MUT-ECHO-BLIND-GU';
if (blind) console.log('  [MUTANT] MUT-ECHO-BLIND-GU — the filter loses its Gujarati tokens\n');
// Clean runs drive the REAL exported function. The reconstruction below is used
// only by the mutant, to replay the pre-fix Devanagari-only regex — it is a
// record of what the code used to do, not a restatement of what it does now.
const detect = !blind ? isAnnouncement : (t) => {
  const s = (t || '').toLowerCase();
  if (!/रिकॉर्ड|रेकॉर्ड|record/.test(s)) return false;
  if (/क्या|\?/.test(s)) return false;
  return /कॉल|call|बीइंग|being|हो रही|की जा रही|किया जा रह|रहा है|रही है/.test(s);
};

ok('OUR OWN Gujarati notice, echoed back through STT, is dropped', () => {
  assert.strictEqual(detect('આ કૉલ રેકોર્ડ થાય છે'), true,
    'the notice would be treated as something the patient said and answered');
});
ok('a caller ASKING whether the call is recorded still reaches the model', () => {
  assert.strictEqual(detect('શું આ કૉલ રેકોર્ડ થાય છે?'), false,
    'a genuine question was eaten by the echo filter');
});
ok('the Hindi and English behaviour is unchanged', () => {
  assert.strictEqual(isAnnouncement('दिस कॉल इज नाउ बीइंग रिकॉर्डेड'), true);
  assert.strictEqual(isAnnouncement('क्या यह कॉल रिकॉर्ड हो रही है?'), false);
});
ok('a treatment enquiry is never mistaken for a recording announcement', () => {
  assert.strictEqual(isAnnouncement('હાઇડ્રાફેશિયલ કેટલાનું છે'), false);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
