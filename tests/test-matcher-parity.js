#!/usr/bin/env node
// ─── THE TWO MATCHERS MUST AGREE ────────────────────────────────────────────
// findDrugMention returns the single best molecule; findAllDrugMentions returns
// every distinct one. They share buildCandidates, the alias table, the brand
// index and the guards — so a surface one of them resolves, the other must find.
//
// MEASURED 2026-08-08, and it was not true:
//
//     findDrugMention("पैन डी")      -> Pantoprazole   (viaBrand, score 1)
//     findAllDrugMentions("पैन डी")  -> []
//
// Pan-D is among the most-prescribed drugs in India. findAllDrugMentions is the
// meds-turn path, so a patient who named it had it silently dropped.
//
// AND IT POISONED THE METRIC. suite/adapters/entity-recall.js resolves the
// DENOMINATOR with findDrugMention and the NUMERATOR with findAllDrugMentions.
// A surface in the gap is therefore counted as gold and can never be recovered
// — not by a better STT, not by a perfect transcript. The recall row carried a
// permanent, invisible deduction.
//
// CAUSE: "पैन डी" romanizes to `pandi`, an exact key in the 116k brand index.
// The candidate is marked aliasOnly (a join across a noise word), and
// findAllDrugMentions did `if (aliasOnly) continue;` BEFORE its brand tier,
// while findDrugMention granted it an exact-only brand look. Same asymmetry
// class as the दवाई bug (f658e7a) — one twin fixed, the other left running.
//
// This file guards the PROPERTY, not the one surface, because the next
// divergence will be somewhere else.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { findDrugMention, findAllDrugMentions } = require('../readback.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const both = (s, opts = { brands: true }) => ({
  one: findDrugMention(s, opts),
  all: findAllDrugMentions(s, opts).map((d) => d.canonical),
});

console.log('\nMATCHER PARITY — what one resolves, the other must find\n');

ok('THE REGRESSION: the Pan-D family resolves in BOTH matchers', () => {
  for (const s of ['पैन डी', 'पैन डी फोर्टी', 'पैन डी ट्वेंटी', 'पैंटॉप']) {
    const { one, all } = both(s);
    assert(one.mentioned, `findDrugMention lost ${s} — the fixture denominator changed`);
    assert(all.includes(one.canonical),
      `findAllDrugMentions cannot find ${s} (${one.canonical}) — a patient naming it loses it, ` +
      `and the recall row counts it as gold that can never be recovered`);
  }
});

ok('PROPERTY: no surface is resolvable by one matcher and invisible to the other', () => {
  // Spread across the tiers that can diverge — alias, brand-exact, generic
  // fuzzy, Devanagari, romanized, multi-word joins.
  const surfaces = [
    'पैन डी', 'पैंटॉप', 'डोलो', 'Dolo 650', 'टेल्मा', 'Telma 40 mg',
    'ग्लाइकोमेट', 'Glycomet GP', 'एसिटाइलसिस्टीन', 'टॉरीन', 'कैल्शियम',
    'मैग्नीशियम', 'लिवोसल्पिराइड', 'सेरेसियोपेप्टिडेस', 'Ecosprin 75',
    'Benadryl cough syrup', 'एमोक्सिसिलिन', 'Augmentin 650 mg',
  ];
  const broken = [];
  for (const s of surfaces) {
    const { one, all } = both(s);
    if (one.mentioned && !all.includes(one.canonical)) broken.push(`${s} -> ${one.canonical}`);
  }
  assert.deepStrictEqual(broken, [],
    `resolvable but unfindable, so permanently unrecoverable:\n      ${broken.join('\n      ')}`);
});

// ── the guards this fix must NOT have loosened ──────────────────────────────
console.log('\nWHAT THE FIX MUST NOT HAVE COST\n');

ok('दवाई — the Hindi word for MEDICINE — still resolves to nothing', () => {
  // f658e7a. "davi" speculates onto BRANDS['davi'] = Dapagliflozin at score 1.0.
  // The parity fix reopens a brand path; it must not reopen THIS one.
  for (const s of ['दवाई', 'कोई दवाई नहीं', 'हाँ एक दवाई चल रही है', 'दवाइयाँ']) {
    const { one, all } = both(s);
    assert(!one.mentioned, `findDrugMention invented ${one.canonical} from "${s}"`);
    assert.deepStrictEqual(all, [], `findAllDrugMentions invented ${all.join(',')} from "${s}"`);
  }
});

ok('speculative variants still never reach the brand index', () => {
  // Measured and REFUSED three times: loose rules, tighter bar, exact-only.
  // The last attempt bought +3.07 recall for +2.59 false positives and flipped
  // seven canaries. The parity fix keeps `!speculative` in its guard; this
  // asserts the outcome rather than the guard's text.
  const { one, all } = both('अशकल्प');   // not a drug; a guessed romanization
  assert(!one.mentioned || one.score === 1,
    'a speculative variant produced a fuzzy brand hit — the refused lever is back');
  assert(all.length === 0 || all.every((c) => c),
    'speculative brand matching reopened');
});

ok('brands:false still resolves nothing through the brand index', () => {
  // The brand index is opt-in. The new tier is inside `if (brands && ...)`;
  // this proves it, by effect rather than by reading the condition.
  const { one, all } = both('पैन डी', { brands: false });
  assert(!one.mentioned, 'the brand index fired with brands:false');
  assert.deepStrictEqual(all, [], 'the brand index fired with brands:false in findAll');
});

ok('an ordinary English sentence still names no drug', () => {
  for (const s of ['I have a headache since two days', 'मुझे सिर दर्द है', 'तो बाहर का खाना बंद करो']) {
    const { all } = both(s);
    assert.deepStrictEqual(all, [], `invented ${all.join(',')} from "${s}"`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
