#!/usr/bin/env node
// ─── TWO GUARDS THAT EXISTED, ON PATHS THAT DID NOT USE THEM ────────────────
//
// 1. THE MODEL NARRATED ITSELF AND WE SPOKE IT. Live, read aloud to callers:
//
//        (பெங்காலியில் பேச நான் தயார்).                     "(I am ready to speak in Bengali)"
//        (ਤੁਸੀਂ ਚਾਹੋ ਤਾਂ ਹੁਣ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰ ਸਕਦੇ ਹੋ, ਜੀ!)   "(You can speak in Punjabi now, ji!)"
//
//    sanitizeForSpeech stripped code fences, headers, bold, bullets and doubled
//    clock times — but not brackets. callHandler already strips parens
//    wholesale in the history-matching path, which is right THERE because
//    nothing is spoken; copying that rule to the speech path would have been
//    the wrong fix arrived at honestly. MEASURED across every Ritu turn in
//    production: 2 whole-utterance parentheticals, and 63 INLINE ones — every
//    one a doctor's specialty, "(Orthopedic Surgeon)", "(MD Medicine)". A
//    blanket strip fixes 2 defects by silently deleting 63 correct offers.
//
// 2. THE DATETIME LOCALISER WAS WIRED TO ONE PATH OF THREE. a609ae9 stopped
//    "Thursday 17:00" reaching a Hindi-only caller and wired it inside
//    processLeanRaw. The STREAMED path never enters processLeanRaw — sentences
//    go from getLeanResponseStream straight to speakStream — and fmtAlt fed
//    canned lines the tool's raw English weekday, which bypasses it on BOTH
//    paths. The mutation test that proved a609ae9 was "unwire it from
//    processLeanRaw", which passes whether or not the other two are covered.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
process.env.CLINIC_MODE = 'lean';

const assert = require('assert');
const { _sanitizeForSpeech: sanitize } = require('../callHandler.js');
const { cannedLine } = require('../brain-lean.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nNARRATION AND DATETIME — what reaches the voice\n');

// ── 1. THE TWO LIVE STAGE DIRECTIONS ───────────────────────────────────────
ok('THE LIVE ONES: a whole-utterance parenthetical is unwrapped, not spoken with brackets', () => {
  const CASES = [
    ['(பெங்காலியில் பேச நான் தயார்).', 'பெங்காலியில் பேச நான் தயார்'],
    ['(ਤੁਸੀਂ ਚਾਹੋ ਤਾਂ ਹੁਣ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰ ਸਕਦੇ ਹੋ, ਜੀ!)', 'ਤੁਸੀਂ ਚਾਹੋ ਤਾਂ ਹੁਣ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰ ਸਕਦੇ ਹੋ, ਜੀ!'],
  ];
  for (const [raw, want] of CASES) {
    const got = sanitize(raw, 'FALLBACK');
    assert(!/^[(]/.test(got), `still starts with a bracket: ${got}`);
    assert.strictEqual(got, want, `got ${JSON.stringify(got)}`);
  }
});

ok('UNWRAPPED, NOT DROPPED — the caller is waiting on this turn', () => {
  // Dropping would leave silence where the model had something reasonable to
  // say. The content of a stage direction is usually a fine sentence.
  const got = sanitize('(பெங்காலியில் பேச நான் தயார்).', 'FALLBACK');
  assert.notStrictEqual(got, 'FALLBACK', 'the turn became the generic fallback instead of the sentence inside');
  assert(got.length > 5);
});

// ── 2. THE 63 THAT MUST SURVIVE ────────────────────────────────────────────
ok('AN INLINE PARENTHETICAL IS UNTOUCHED — this is 63 real offers', () => {
  const REAL = [
    'हमारे यहाँ डॉ. संजय वाघ जी (Orthopedic Surgeon) हैं, वो आज उपलब्ध हैं।',
    "Since you're looking for an appointment, Dr. Anjali Deshmukh (Dentist) is available.",
    'ਡਾ. ਅਲਕਾ ਰਾਨਾਡੇ (MD Medicine) ਅੱਜ ਰਾਤ 8:00 ਵਜੇ ਤੱਕ ਉਪਲਬਧ ਹਨ।',
    'ठीक है जी, कल सुबह डॉ. कविता फड़के (Gynecologist) उपलब्ध हैं।',
  ];
  // Asserts the PARENTHETICAL survives, not that the string is byte-identical:
  // sanitizeForSpeech legitimately rewrites other things in the same sentence.
  // The Punjabi line here lost its "ਵਜੇ" after "8:00" on the first run — which
  // is the time-doubling rule working, since Sarvam vocalizes "8:00" WITH the
  // o'clock word and the caller would otherwise hear "aath vaje vaje". Asserting
  // equality would have made this test demand that a real fix be reverted.
  for (const s of REAL) {
    const got = sanitize(s, 'FALLBACK');
    const paren = s.match(/\([^)]*\)/)[0];
    assert(got.includes(paren),
      `the specialty was deleted from a real offer:\n        in:  ${s}\n        out: ${got}`);
    assert.notStrictEqual(got, 'FALLBACK', `a normal offer became the fallback: ${s}`);
  }
});

ok('TWO parentheticals in one sentence are not mistaken for a wrapper', () => {
  // "(a) and (b)" matches /^\(.*\)$/ but unwrapping yields "a) and (b".
  const s = '(Orthopedic Surgeon) और (Dentist) दोनों उपलब्ध हैं।';
  assert.strictEqual(sanitize(s, 'FALLBACK'), s);
  const t = '(पहला) (दूसरा)';
  assert.strictEqual(sanitize(t, 'FALLBACK'), t, `unwrapped a non-wrapper: ${sanitize(t, 'FALLBACK')}`);
});

ok('text after the closing bracket means it was never a wrapper', () => {
  const s = '(जी हाँ) डॉक्टर उपलब्ध हैं।';
  assert.strictEqual(sanitize(s, 'FALLBACK'), s);
});

// ── 3. TEMPLATE SCAFFOLDING IS NOT A SENTENCE ──────────────────────────────
ok('a square/curly-bracketed whole utterance is degenerate, not unwrapped', () => {
  // "[Patient Name]" reached the patients table once already (47aa061). Spoken,
  // it must become the fallback — unwrapping would say "Patient Name" aloud.
  for (const s of ['[Patient Name]', '{{time}}', '<doctor_name>']) {
    assert.strictEqual(sanitize(s, 'FALLBACK'), 'FALLBACK', `${s} was spoken as ${sanitize(s, 'FALLBACK')}`);
  }
});

// ── 4. THE DATETIME GUARD, ON EVERY PATH ───────────────────────────────────
ok('the STREAMED path localizes — it is the path production takes', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'brain-lean.js'), 'utf8');
  const stream = src.slice(src.indexOf('async function* getLeanResponseStream'));
  const emits = [...stream.matchAll(/yield \{ kind: 'sentence', text: ([^,]+),/g)].map((m) => m[1].trim());
  assert(emits.length >= 2, `expected the sentence and tail emits, found ${emits.length}`);
  for (const e of emits) {
    assert(/^localizeSpoken\(/.test(e),
      `a streamed sentence is emitted without localization: yield ... text: ${e}. ` +
      `getLeanResponseStream never passes through processLeanRaw, so this is the ONLY guard it gets.`);
  }
});

ok('fmtAlt localizes — canned lines bypass processLeanRaw on BOTH paths', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'brain-lean.js'), 'utf8');
  const fn = src.match(/function fmtAlt\(alt, context\) \{[\s\S]*?\n\}/);
  assert(fn, 'fmtAlt no longer takes a context — it cannot localize without one');
  assert(/localizeSpoken\(raw, context\)/.test(fn[0]),
    'fmtAlt returns the raw tool string again — English weekdays go straight into cannedLine');
  assert(/fmtAlt\(\(result\.alternatives \|\| \[\]\)\[0\], context\)/.test(src),
    'the fmtAlt call site stopped passing context');
});

ok('an alternative slot is spoken in the caller\'s language, end to end', () => {
  // Through the real canned line, as the caller would hear it.
  const line = cannedLine('slotAlt', { languageCode: 'kn-IN' }, { alt: 'ಸೋಮವಾರ 5:00 pm' });
  assert(/ಸೋಮವಾರ/.test(line), `the localized alternative did not survive: ${line}`);
  assert(!/\b(Monday|Thursday|Tuesday)\b/.test(line), `an English weekday reached a Kannada line: ${line}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
