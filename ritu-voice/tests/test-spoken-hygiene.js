#!/usr/bin/env node
// ─── TWO THINGS CALLERS HEARD THAT ARE NOT WORDS ────────────────────────────
// Both found by a 33-agent adversarial audit of live calls on 2026-08-15, both
// confirmed by executing the shipped code rather than by reading it.
//
// 1. A LITERAL PLACEHOLDER, READ ALOUD.
//
//        "हो गया जी, डॉ. मनोज देव जी के साथ आपकी अपॉइंटमेंट {time} कर दी है."
//
//    CANNED_LINES declared `rescheduled` TWICE in one object literal. Last key
//    wins, silently — so the placeholder-free copy became dead code and every
//    caller of the key suddenly needed {doctor} AND {time}. brain-lean.js:987
//    passes only {doctor}; cannedLine substituted what it was given and handed
//    the rest to TTS verbatim. Canned lines skip cleanResponse and
//    sanitizeForSpeech has no brace rule, so nothing downstream caught it.
//
// 2. THREE SCRIPTS IN ONE TTS REQUEST. Live call ed685d54, first second:
//
//        ನಮಸ್ಕಾರ পৃথ্বী ಅವರೇ! ನಾನು ಋತು, स्माईल मल्टीस्पेशालिटी क्लिनिक ಇಂದ...
//
//    A Kannada frame, the patient's name in BENGALI (whatever script their row
//    holds) and the clinic's name in DEVANAGARI (the configured string), sent
//    as one request with the Kannada speaker. An Indic TTS engine does not
//    code-switch mid-utterance — and the foreign run here is the caller's name.
//
// The reschedule path is also where an ENGLISH weekday reached an Indic voice:
// one side built its own `toLocaleString('en-IN')` string, which is the same
// leak a609ae9 fixed for model text, arriving by a route that fix never covered.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
process.env.CLINIC_MODE = 'lean';

const assert = require('assert');
const { cannedLine, speakableTime } = require('../brain-lean.js');
const { toSpeakableScript, toSpeakableScriptWords, scriptOf } = require('../devanagari.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nSPOKEN HYGIENE — nothing reaches TTS that is not a word\n');

// ── 1. NO PLACEHOLDER IS EVER SPOKEN ───────────────────────────────────────
const KEYS_WITH_SLOTS = ['rescheduled', 'booked', 'slotAlt', 'slotTaken', 'onCallUseCallback', 'notWorkingNoAlt'];

ok('THE LIVE DEFECT: rescheduled with only {doctor} speaks no braces', () => {
  // Exactly how brain-lean.js:987 used to call it.
  const s = cannedLine('rescheduled', { languageCode: 'hi-IN' }, { doctor: 'डॉ. मनोज देव' });
  assert(!/[{}]/.test(s), `a placeholder reached the caller: ${s}`);
  assert(s.length > 10, `the line collapsed to nothing: ${JSON.stringify(s)}`);
});

ok('NO canned line in ANY language can emit a brace, whatever it is passed', () => {
  const LANGS = ['hi-IN', 'mr-IN', 'en-IN', 'kn-IN', 'pa-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'ml-IN', 'od-IN'];
  for (const key of KEYS_WITH_SLOTS) {
    for (const lang of LANGS) {
      for (const args of [{}, { doctor: 'X' }, { time: 'Y' }, { alt: 'Z' }, { specialty: '' }]) {
        const s = cannedLine(key, { languageCode: lang }, args);
        assert(!/[{}]/.test(s), `${key}/${lang} with ${JSON.stringify(args)} -> ${s}`);
      }
    }
  }
});

ok('an EMPTY argument does not leave a double space either', () => {
  // "मैंने  के लिए कॉलबैक लगा दिया है" — a hole with no braces around it.
  const s = cannedLine('callbackArranged', { languageCode: 'hi-IN' }, { specialty: '' });
  assert(!/ {2,}/.test(s), `double space survived: ${JSON.stringify(s)}`);
  assert(!/\s+[,.।!?]/.test(s), `space before punctuation: ${JSON.stringify(s)}`);
});

ok('a fully-supplied line is UNCHANGED — the guard must not eat real content', () => {
  const s = cannedLine('rescheduled', { languageCode: 'hi-IN' },
    { doctor: 'डॉ. मनोज देव', time: 'सोमवार, 5:00 pm' });
  assert(/डॉ\. मनोज देव/.test(s), `the doctor was lost: ${s}`);
  assert(/सोमवार/.test(s), `the time was lost: ${s}`);
});

ok('CANNED_LINES has no duplicate keys — the shadowing that caused this', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'brain-lean.js'), 'utf8');
  const start = src.indexOf('const CANNED_LINES = {');
  assert(start > 0, 'CANNED_LINES not found — renamed?');
  const body = src.slice(start, src.indexOf('\n};', start));
  const keys = [...body.matchAll(/^ {2}([a-zA-Z_]+): \{/gm)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [],
    `duplicate key(s) shadowing silently: ${[...new Set(dupes)].join(', ')} — ` +
    `the last one wins and the earlier copy becomes unreachable dead code`);
});

// ── 2. THE APPOINTMENT TIME IS SPOKEN IN THE CALLER'S LANGUAGE ─────────────
ok('the reschedule time is localized, not an English weekday', () => {
  const iso = '2026-08-17T11:30:00Z';   // Monday, 5:00 pm IST
  const EXPECT = {
    'hi-IN': 'सोमवार', 'mr-IN': 'सोमवार', 'kn-IN': 'ಸೋಮವಾರ',
    'bn-IN': 'সোমবার', 'ta-IN': 'திங்கள்', 'te-IN': 'సోమవారం',
  };
  for (const [lang, want] of Object.entries(EXPECT)) {
    const t = speakableTime(iso, { languageCode: lang });
    assert(t.includes(want), `${lang}: expected ${want}, got "${t}"`);
    assert(!/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(t),
      `${lang} still carries an ENGLISH weekday: "${t}"`);
  }
});

ok('a missing or unparseable time degrades to empty, never to "Invalid Date"', () => {
  for (const bad of [null, undefined, '', 'not-a-date']) {
    assert.strictEqual(speakableTime(bad, { languageCode: 'hi-IN' }), '',
      `${JSON.stringify(bad)} produced something speakable`);
  }
});

// ── 3. ONE SCRIPT PER UTTERANCE ────────────────────────────────────────────
ok('THE LIVE GREETING: the Bengali name and Devanagari clinic become Latin', () => {
  const live = 'ನಮಸ್ಕಾರ পৃথ্বী ಅವರೇ! ನಾನು ಋತು, स्माईल मल्टीस्पेशालिटी क्लिनिक ಇಂದ.';
  const got = toSpeakableScriptWords(live, 'kn-IN');
  assert(!/[ঀ-৿]/.test(got), `Bengali survived into a Kannada utterance: ${got}`);
  assert(!/[ऀ-ॿ]/.test(got), `Devanagari survived into a Kannada utterance: ${got}`);
  assert(/ನಮಸ್ಕಾರ/.test(got), `the Kannada frame was damaged: ${got}`);
  assert(/Prithbi/.test(got), `the name did not survive in any form: ${got}`);
});

ok('SAME-SCRIPT IS UNTOUCHED — a Devanagari clinic on a Hindi call', () => {
  const hi = 'नमस्ते सिद्धार्थ जी! मैं ऋतू, स्माईल मल्टीस्पेशालिटी क्लिनिक से।';
  assert.strictEqual(toSpeakableScriptWords(hi, 'hi-IN'), hi,
    'a correct same-script greeting was rewritten — this must be a no-op');
});

ok('a Kannada name on a Kannada call stays Kannada (do not romanize the right thing)', () => {
  assert.strictEqual(toSpeakableScript('ಪೃಥ್ವಿ', 'kn-IN'), 'ಪೃಥ್ವಿ');
  assert.strictEqual(toSpeakableScript('পৃথ্বী', 'bn-IN'), 'পৃথ্বী');
  assert.strictEqual(toSpeakableScript('सिद्धार्थ', 'mr-IN'), 'सिद्धार्थ');
});

ok('Latin and an unknown language code pass straight through', () => {
  assert.strictEqual(toSpeakableScript('Siddharth', 'kn-IN'), 'Siddharth');
  // Never guess for a language whose script we have not mapped.
  assert.strictEqual(toSpeakableScript('পৃথ্বী', 'xx-IN'), 'পৃথ্বী');
  assert.strictEqual(toSpeakableScriptWords('ಡೋಲೋ 650', 'kn-IN'), 'ಡೋಲೋ 650');
});

ok('an unromanizable name is kept as-is — mispronounced beats missing', () => {
  const odd = 'ঀ';   // a Bengali codepoint that yields no Latin letters
  assert.strictEqual(toSpeakableScript(odd, 'kn-IN'), odd);
});

ok('scriptOf identifies each block, and is null for Latin', () => {
  assert.strictEqual(scriptOf('ಪೃಥ್ವಿ'), 0x0C80);
  assert.strictEqual(scriptOf('পৃথ্বী'), 0x0980);
  assert.strictEqual(scriptOf('सिद्धार्थ'), 0x0900);
  assert.strictEqual(scriptOf('Siddharth'), null);
  assert.strictEqual(scriptOf('650'), null);
});

// ── 4. THE SHIPPED GREETING IS WHAT GOES OUT ───────────────────────────────
ok('the greeting the handler exposes is script-normalized, not the raw table', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(/const GREETING_TEXT = toSpeakableScriptWords\(/.test(src),
    'GREETING_TEXT no longer passes through toSpeakableScriptWords — the new-patient greeting can mix scripts again');
  // Allows wrapper calls between the two — withRecordingNotice() now sits there,
  // and the previous pattern demanded they be adjacent, so a correct change read
  // as a regression. Still a SOURCE test with the usual limit: it proves the call
  // is written, not that it runs. The nesting order is what matters here and is
  // what it checks — normalization must be OUTERMOST, or a notice added after it
  // would go to TTS unnormalized.
  assert(/toSpeakableScriptWords\(\s*\n?\s*(?:[A-Za-z_$][\w$]*\(\s*\n?\s*)*\(RETURNING_GREETING_TEXTS/.test(src),
    'the RETURNING greeting no longer normalizes — this is the one that carries the stored patient name');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
