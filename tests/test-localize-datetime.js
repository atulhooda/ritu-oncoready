#!/usr/bin/env node
// ─── "Thursday 17:00" SAID TO A HINDI CALLER ────────────────────────────────
// LIVE CALL c394b280c4808227d8e28c957d231a8d, 2026-08-13, verbatim from
// calls.transcript — a call conducted entirely in Hindi:
//
//     RITU  उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?
//
// An English weekday and a 24-hour clock, read aloud by an Indic TTS voice.
// Nobody in an Indian clinic says "seventeen hundred hours"; they say "shaam
// paanch baje". A caller does not hear a small formatting slip — they hear a
// machine, and stop trusting the sentence around it.
//
// Same class as the REQUEST_CALLBACK sentinel a patient heard two days earlier
// (42cb33f): machine-shaped text reaching a human ear because nothing stood
// between the model's output and the speaker. The prompt already asks for the
// caller's language and the model almost always complies — but "almost always"
// is not a property you can test, and that is twice in three days.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nDATE/TIME LOCALISATION — no machine clock reaches a caller\n');

(async () => {
  const { localizeDateTime, WEEKDAYS, DAYPART } = require('../localizeDateTime.js');

  // ── 1. the live line ─────────────────────────────────────────────────────
  await ok('THE LIVE LINE: "Thursday 17:00" becomes Hindi', () => {
    const r = localizeDateTime('उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?', 'hi-IN');
    assert(r.changed, 'nothing was rewritten');
    assert(!/Thursday/i.test(r.text), `the English weekday survived: ${r.text}`);
    assert(!/17:00/.test(r.text), `the 24-hour clock survived: ${r.text}`);
    assert(/गुरुवार/.test(r.text), `wrong weekday: ${r.text}`);
    assert(/शाम\s*5:00/.test(r.text), `wrong time or missing part-of-day: ${r.text}`);
  });

  await ok('and the rest of the sentence is untouched', () => {
    const r = localizeDateTime('उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?', 'hi-IN');
    assert(/उस समय उपलब्ध नहीं/.test(r.text), `the reply was mangled: ${r.text}`);
    assert(/ठीक रहेगा\?$/.test(r.text), `the tail was lost: ${r.text}`);
  });

  // ── 2. it must not "fix" what is already right ──────────────────────────
  await ok('a correctly-spoken time is left completely alone', () => {
    const src = 'आज शाम 5:00 बजे बुक कर दिया है।';
    const r = localizeDateTime(src, 'hi-IN');
    assert.strictEqual(r.changed, false, `rewrote a correct sentence: ${r.text}`);
    assert.strictEqual(r.text, src);
    assert.deepStrictEqual(r.leaks, [], `flagged a clean line: ${JSON.stringify(r.leaks)}`);
  });

  await ok('morning hours are not touched — 10:30 is how people say it', () => {
    const r = localizeDateTime('डॉक्टर 10:30 से 11:45 तक हैं।', 'hi-IN');
    assert.strictEqual(r.changed, false, `rewrote a 12-hour time: ${r.text}`);
  });

  await ok('a 24-hour time in the same line as a 12-hour one converts only the 24', () => {
    const r = localizeDateTime('डॉक्टर 10:30 से 13:00 तक उपलब्ध हैं।', 'hi-IN');
    assert(/10:30/.test(r.text), `the morning time was altered: ${r.text}`);
    assert(!/13:00/.test(r.text), `13:00 survived: ${r.text}`);
    assert(/दोपहर\s*1:00/.test(r.text), `13:00 should read as afternoon 1: ${r.text}`);
  });

  // ── 3. midnight, which the first version got wrong ──────────────────────
  await ok('00:30 is NIGHT, not morning', () => {
    // The first version read `h24 < 12` as morning and produced "सुबह 12:30" —
    // half past midnight announced as half past twelve in the morning.
    const r = localizeDateTime('00:30 का slot', 'hi-IN');
    assert(/रात\s*12:30/.test(r.text), `midnight rendered as ${r.text}`);
    assert(!/सुबह/.test(r.text), `00:30 was called morning: ${r.text}`);
  });

  await ok('the part-of-day boundaries match how the day is actually spoken', () => {
    const at = (h) => localizeDateTime(`${String(h).padStart(2, '0')}:00`, 'hi-IN').text;
    assert(/रात/.test(at(23)), `23:00 -> ${at(23)}`);
    assert(/रात/.test(at(20)), `20:00 -> ${at(20)}`);
    assert(/शाम/.test(at(19)), `19:00 -> ${at(19)}`);
    assert(/शाम/.test(at(16)), `16:00 -> ${at(16)}`);
    assert(/दोपहर/.test(at(14)), `14:00 -> ${at(14)}`);
    assert(/दोपहर/.test(at(13)), `13:00 -> ${at(13)}`);
    assert(/रात/.test(at(0)), `00:00 -> ${at(0)}`);
  });

  await ok('1:00 to 12:59 are left ALONE — that is already how people say them', () => {
    // My first version of the test above asserted 01:00 -> "रात 1:00". The code
    // deliberately does not touch it, and the code is right: rewriting "5:00"
    // to "5:00" gains nothing and risks mangling a correct sentence. 1am is not
    // a clinic hour, so the ambiguity this leaves is theoretical.
    for (const h of [1, 5, 9, 11, 12]) {
      const s = `${String(h).padStart(2, '0')}:00 बजे`;
      const r = localizeDateTime(s, 'hi-IN');
      assert.strictEqual(r.changed, false, `rewrote a 12-hour time: ${s} -> ${r.text}`);
      assert.deepStrictEqual(r.leaks, [], `flagged a 12-hour time as a leak: ${s}`);
    }
  });

  // ── 4. every language it claims to serve ────────────────────────────────
  await ok('every language with a table converts, and none is left half-done', () => {
    for (const lang of Object.keys(WEEKDAYS)) {
      const r = localizeDateTime('Thursday 17:00 ?', lang);
      assert(r.changed, `${lang}: nothing changed`);
      assert(!/Thursday/i.test(r.text), `${lang}: weekday survived — ${r.text}`);
      assert(!/17:00/.test(r.text), `${lang}: 24-hour clock survived — ${r.text}`);
      assert(WEEKDAYS[lang].length === 7, `${lang}: incomplete weekday table`);
      assert(DAYPART[lang], `${lang}: has weekdays but no part-of-day words — times would convert bare`);
    }
  });

  await ok('a language with NO table is left alone and REPORTED, never half-converted', () => {
    const r = localizeDateTime('Thursday 17:00 ?', 'xx-XX');
    assert.strictEqual(r.changed, false, 'guessed at a language it has no words for');
    assert(r.leaks.length >= 2,
      'silently passed a machine date through without reporting it — the log line is the only thing that would surface this');
  });

  await ok('an ENGLISH call is not rewritten, but the leak is still reported', () => {
    const r = localizeDateTime('Shall I book Thursday 17:00?', 'en-IN');
    assert.strictEqual(r.changed, false, 'rewrote an English reply into Hindi');
    assert(r.leaks.length >= 2, 'an en-IN reply with a 24-hour clock is still worth seeing in the log');
  });

  // ── 5. it must not fire on ordinary text ────────────────────────────────
  await ok('ordinary Hindi with no dates is untouched', () => {
    for (const s of ['आपको क्या तकलीफ़ है जी?', 'डॉ. मनोज देव न्यूरोलॉजिस्ट हैं।', 'फीस ₹450 है।']) {
      const r = localizeDateTime(s, 'hi-IN');
      assert.strictEqual(r.changed, false, `rewrote: ${s} -> ${r.text}`);
      assert.deepStrictEqual(r.leaks, [], `flagged: ${s}`);
    }
  });

  await ok('empty and null input do not throw', () => {
    for (const v of ['', null, undefined]) {
      const r = localizeDateTime(v, 'hi-IN');
      assert.strictEqual(r.changed, false);
      assert.strictEqual(r.text, '');
    }
  });

  // ── 6. and it is actually WIRED to what gets spoken ─────────────────────
  await ok('THE WIRING: a reply leaving processLeanRaw is already localised', () => {
    // The pure function passing proves nothing if nothing calls it — that is
    // the shape of half this week's defects.
    const lean = require('../brain-lean.js');
    return lean.processLeanRaw('उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?', {
      clinicId: 'c1', callerPhone: '+918273500806', languageCode: 'hi-IN',
    }).then((out) => {
      assert(out && out.text, 'no text returned');
      assert(!/Thursday/i.test(out.text),
        `the localiser exists but the lean brain does not call it: ${out.text}`);
      assert(/गुरुवार/.test(out.text), `not localised on the way out: ${out.text}`);
    });
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
