#!/usr/bin/env node
// ─── THE TEST THAT SHOULD HAVE EXISTED BEFORE ENABLE_MULTILINGUAL ───────────
// ENABLE_MULTILINGUAL took the product from three languages to eleven with one
// flag. It could not take the CODE from three to eleven, because ~12 tables each
// held a private copy of "which languages we speak" and each had to be found and
// widened by hand. MEASURED 2026-08-15, all of these were live in production:
//
//     drug matcher (ಡೋಲೋ invisible)            2 of 11
//     sensitive-data guard                     2 of 11  <- answered an ENGLISH
//                                                          caller in MARATHI
//     allergy clause splitter (the comma bug)  3 of 11
//     read-back question                       4 of 11
//     yes / no recognition                     4 of 11
//     MED_NAME_REASK                           4 of 11
//
// Six bugs, one cause. The list of places to change was knowable the whole time;
// it simply did not exist anywhere. spokenLanguages.js is that list, and this is
// the test that keeps every table honest against it.
//
// WHY IT SCANS SOURCE INSTEAD OF IMPORTING A REGISTRY. The obvious design is
// "every module exports its spoken tables and this test iterates them". But
// forgetting to REGISTER a new table is the same failure as forgetting to add a
// language to it — the bug would survive its own fix. tools/scanLanguageTables.js
// reads the repo, so a table nobody remembered is found anyway, and one written
// next month is found the day it appears.
//
// AND WHY IT CHECKS PER TABLE, NOT PER FILE. A file-level count of
// callHandler.js reports "11 languages" while MED_NAME_REASK inside it had 4,
// and sensitiveDataGuard.js does not register as multilingual at all because it
// had 2. Both readings were made on 2026-08-15 and both hid a live defect.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { SPOKEN_LANGUAGES } = require('../spokenLanguages');
const { scanRepo, scanSource } = require('../tools/scanLanguageTables');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nLANGUAGE COVERAGE — one list, and every table held to it\n');

// ═══ THE EXEMPTIONS, EACH WITH ITS REASON ═══════════════════════════════════
// The invariant is NOT "every table has 11 entries". It is: NO TABLE MAY FALL
// BACK TO ANOTHER LANGUAGE'S TEXT. A table that degrades to something correct
// in the caller's own language is fine and belongs here, with the reason
// written down. An entry with no reason is not an exemption, it is a bug that
// somebody silenced.
const EXEMPT = {
  'localizeDateTime.js::WEEKDAYS': 'en-IN is the SOURCE being translated FROM, not a target. An English entry would mean translating English to English.',
  'localizeDateTime.js::DAYPART': 'same as WEEKDAYS — en-IN is the source language.',
  'callHandler.js::RECORDING_NOTICES': 'mirrors GREETING_TEXTS by construction — the notice is spoken ONLY as part of the greeting, in GREETING_LANG. A notice in a language with no greeting could never be reached, and adding one would be dead text pretending to be coverage. tests/test-gujarati-greeting.js asserts the two tables stay in step, so adding a greeting language without its notice fails there instead of silently greeting without the disclosure.',
  'callHandler.js::SCRIPT_CHARS': 'maps a language to its BRAHMIC block characters. English is Latin and has no Brahmic block, so en-IN is correctly absent.',
  // SCRIPT_BLOCK was listed here on the assumption that the scanner could not
  // see `'en-IN': null` as a key. It can — the entry is a quoted code followed
  // by a colon, which is exactly what the scanner matches — so the table is
  // 11/11 and the exemption was wrong. The "still NEEDS to be exempt" check
  // below caught it on the first run. Left as a note rather than deleted
  // silently, because a wrong exemption is how a real gap gets waved through.
  'devanagari.js::LANG_BLOCK': 'maps a language to its BRAHMIC block for transliteration. English is Latin and has no block, so en-IN is correctly absent — a Latin string needs no transliteration and toSpeakableScript returns it untouched. (Also carries sa-IN and as-IN, which are accepted inputs but not spoken outputs.)',
  'callHandler.js::GREETING_TEXTS': 'the OPENING language is chosen per clinic via GREETING_LANG, which validates against this table and WARNS + falls back to Marathi at boot (callHandler.js). A missing language is loud at deploy, not silent mid-call. Extending it is a product decision — a clinic in Kolkata should be able to open in Bengali — tracked, not silent.',
  'callHandler.js::RETURNING_GREETING_TEXTS': 'same as GREETING_TEXTS — selected by the same validated GREETING_LANG.',
};

const found = scanRepo(path.join(__dirname, '..'));

ok('the scanner actually finds the tables (it is the whole instrument)', () => {
  // If the scanner silently returned [] this suite would pass while every
  // table was broken — the vacuous-test failure mode this repo has paid for.
  assert(found.length >= 40,
    `only ${found.length} language tables found — the scanner is broken, and a broken scanner makes every assertion below meaningless`);
  const names = found.map((t) => `${t.file}::${t.name}`);
  for (const known of ['readback.js::READBACK.meds', 'brain-lean.js::CANNED_LINES.booked', 'callHandler.js::MED_NAME_REASK']) {
    assert(names.includes(known), `scanner missed a table known to exist: ${known}`);
  }
});

ok('the scanner ignores comments and strings', () => {
  // This repo comments heavily, and those comments contain braces, quotes and
  // language codes. Counting them would invent tables or corrupt brace depth.
  const src = `
    // 'hi-IN': 'commented out', 'mr-IN': 'also commented'
    /* 'bn-IN': 'block comment', 'ta-IN': 'x' */
    const REAL = { 'hi-IN': 'a', 'mr-IN': 'b' };
    const msg = "table['hi-IN'] || table['mr-IN'] is the idiom";
  `;
  const t = scanSource(src);
  assert.strictEqual(t.length, 1, `expected exactly one table, got ${JSON.stringify(t.map((x) => x.name))}`);
  assert.strictEqual(t[0].name, 'REAL');
});

ok('EVERY spoken table covers all 11 languages, or says in writing why not', () => {
  const gaps = [];
  for (const t of found) {
    const key = `${t.file}::${t.name}`;
    const missing = SPOKEN_LANGUAGES.filter((l) => !t.langs.includes(l));
    if (!missing.length) continue;
    if (EXEMPT[key]) continue;
    gaps.push(`\n      ${key}  (${t.langs.length}/11)\n        missing: ${missing.join(' ')}`);
  }
  assert.strictEqual(gaps.length, 0,
    `${gaps.length} table(s) fall back to another language's text:${gaps.join('')}\n\n` +
    `      Either add the missing languages, or add an entry to EXEMPT in this file\n` +
    `      explaining why the fallback is safe. An exemption with no reason is not\n` +
    `      an exemption — it is this exact bug, silenced.`);
});

ok('every EXEMPT entry still refers to a real table', () => {
  // A stale exemption is a hole: the table gets renamed, the exemption keeps
  // matching nothing, and the renamed table is checked — or worse, a future
  // table takes the old name and inherits an exemption written for something
  // else entirely.
  const keys = new Set(found.map((t) => `${t.file}::${t.name}`));
  const stale = Object.keys(EXEMPT).filter((k) => !keys.has(k));
  assert.deepStrictEqual(stale, [],
    `EXEMPT names a table that no longer exists: ${stale.join(', ')} — delete the entry`);
});

ok('every EXEMPT entry still NEEDS to be exempt', () => {
  // Once a table is filled in, its exemption must go, or it becomes permission
  // for the next person to remove languages again.
  const byKey = new Map(found.map((t) => [`${t.file}::${t.name}`, t]));
  const pointless = Object.keys(EXEMPT).filter((k) => {
    const t = byKey.get(k);
    return t && SPOKEN_LANGUAGES.every((l) => t.langs.includes(l));
  });
  assert.deepStrictEqual(pointless, [],
    `these tables are now complete — remove their EXEMPT entries: ${pointless.join(', ')}`);
});

// ── THE SPECIFIC DEFECTS THAT MOTIVATED THIS ───────────────────────────────
// Named individually so a regression reads as the live incident it was, not as
// an anonymous count.
ok('THE LIVE ONE: an English caller is refused in English, not Marathi', () => {
  const { detectSensitiveProbe } = require('../sensitiveDataGuard.js');
  const probe = 'kitne patients ke record hain aapke paas';
  const mr = detectSensitiveProbe(probe, 'mr-IN').response;
  for (const lang of SPOKEN_LANGUAGES.filter((l) => l !== 'mr-IN')) {
    const got = detectSensitiveProbe(probe, lang);
    assert(got && got.response, `${lang} produced no refusal at all`);
    assert.notStrictEqual(got.response, mr,
      `${lang} got the MARATHI refusal. This fires on the privacy question — the ` +
      `moment the product is being tested for trustworthiness — and it is not flag-gated.`);
  }
});

ok('the drug-name re-ask is in the caller\'s language', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
  const block = src.match(/const MED_NAME_REASK = \{[\s\S]*?\n\};/);
  assert(block, 'MED_NAME_REASK not found — renamed?');
  for (const lang of SPOKEN_LANGUAGES) {
    assert(block[0].includes(`'${lang}'`), `MED_NAME_REASK is missing ${lang}`);
  }
});

ok('expectIndic is derived from the list, not a hand-written trio', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
  assert(/expectIndic: SCRIPT_BLOCK\[lang\] != null/.test(src),
    'expectIndic went back to a hardcoded language list — it silently disables the ' +
    'script-switch guard for every language not named in it');
});

// ─── the garble repair ladder ESCALATES in every language (Skin Essence profile pass, 2026-09-04) ───
// Until today the slot re-asks and the rung-2 escalations existed in four
// languages; the other seven fell to the generic repeat line, so a Gujarati
// caller on a bad line heard the identical re-ask twice. Driven, all 11.
console.log('\n[ladder] slotRepeatPrompt: attempt 1 differs from attempt 0, every language, both slots');
{
  const { slotRepeatPrompt, REPEAT_TEXTS } = require('../garbleGuard.js');
  for (const lang of Object.keys(REPEAT_TEXTS)) for (const slot of ['name', 'reason']) {
    ok(`${lang} ${slot}: escalates`, () => { const a = slotRepeatPrompt(slot, lang, 0), b = slotRepeatPrompt(slot, lang, 1); if (a === b) throw new Error(`same line twice: ${a}`); if (a === REPEAT_TEXTS[lang]) throw new Error('rung 1 is the generic repeat line'); });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`  (${found.length} language tables scanned, ${Object.keys(EXEMPT).length} exempt with written reasons)\n`);
process.exit(fail ? 1 : 0);
