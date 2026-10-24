#!/usr/bin/env node
// ─── ONE HANDSET, TWO PATIENTS, ONE MEDICATION LIST ─────────────────────────
// db.js getPatientMedications keys on PHONE:
//     WHERE clinic_id = $1 AND phone = $2
// and callHandler._loadPriorMeds calls it with nothing but this.callerPhone.
// But `patients` is UNIQUE (clinic_id, phone, name) and db.js says why in its
// own comment — "a later real name creates a distinct row (family-friendly)".
// Several people per handset is a designed-for state, and shared phones are the
// norm in Indian clinics.
//
// So Papa's medication list is loaded as a matcher prior when Rahul calls. That
// prior runs at PRIOR_MAX_DIST 0.50 (readback.js:850) — TWICE the general bar —
// under a comment reading "the worst case is echoing back a molecule they
// really do take".
//
// VERIFIED BY EXECUTION, with ['Metformin','Telmisartan','Atorvastatin'] as the
// household prior:
//     "matarman"  ->  []   becomes  ["Metformin"]
//     "tarasan"   ->  []   becomes  ["Atorvastatin"]
// Neither is a drug. Garbled speech from the person actually on the line gets
// pulled onto somebody else's prescription, read back as "आप Metformin ले रहे
// हैं?", collects a "हाँ", and is written to the WRONG patient's record.
//
// SAME CLASS AS THE CANCEL BUG (556b9b4), different table. There the fix was to
// stop guessing which family member; here it is the same: when the handset
// carries more than one patient and nothing identifies WHICH one is speaking,
// the safe prior is no prior. A single-patient phone — the common case — keeps
// the benefit untouched.
//
// Not solved by using the greeting name: that comes from getReturningPatientName
// (db.js:56) = ORDER BY created_at DESC LIMIT 1, the most recently REGISTERED
// name on the handset, not whoever is on the line. Filtering by it would swap a
// random household member for a confidently wrong one.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { findAllDrugMentions } = require('../readback.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nMEDICATION PRIOR — must not carry a household member\'s drugs\n');

(async () => {

  // ── the harm, stated as a matcher fact so it cannot be argued away ────────
  await ok('THE HARM: a prior pulls non-drug speech onto the prior holder\'s drugs', () => {
    const prior = ['Metformin', 'Telmisartan', 'Atorvastatin'];
    for (const [word, drug] of [['matarman', 'Metformin'], ['tarasan', 'Atorvastatin']]) {
      const without = findAllDrugMentions(word, { brands: true }).map((d) => d.canonical);
      const with_ = findAllDrugMentions(word, { brands: true, prior }).map((d) => d.canonical);
      assert.deepStrictEqual(without, [], `${word} should resolve to nothing unaided`);
      assert(with_.includes(drug),
        `the prior no longer biases at all — if PRIOR_MAX_DIST was tightened this test needs rewriting, ` +
        `but the household fix below is what must carry the safety`);
    }
  });

  // ── the fix: who the prior is loaded FOR ─────────────────────────────────
  const db = require('../db.js');
  const realQuery = db.pool.query.bind(db.pool);

  // Two patients on one handset, Papa holding the medications.
  // The count is no longer COUNT(DISTINCT name) — that counted 'Unknown' and
  // 'ಅಪರಿಚಿತ' as people, so any handset that had once produced a placeholder row
  // looked like a household and lost the prior the guard exists to protect.
  // db.js now selects the names and counts what survives cleanPersonName,
  // case-folded. This stub follows the real query; the shape it used to model no
  // longer exists, and left as it was it went on passing against nothing.
  const stub = (distinctPatients) => {
    const names = ['Prithvi', 'Atul', 'Sunita'].slice(0, distinctPatients);
    db.pool.query = async (sql, params) => {
      assert(!/phone = \$\d/.test(String(sql)),
        'a phone-keyed query is comparing one string again — see tests/test-phone-identity.js');
      if (/SELECT name FROM patients/i.test(sql)) {
        return { rows: names.map((n) => ({ name: n })), rowCount: names.length };
      }
      return { rows: [{ canonical: 'Metformin', brand: 'glycomet', resolution: 'affirmed' }], rowCount: 1 };
    };
  };

  await ok('a SHARED handset loads NO prior — the safe prior is no prior', async () => {
    stub(2);
    try {
      const rows = await db.getPatientMedications('+919876543210');
      assert.deepStrictEqual(rows, [],
        `two patients share this number and nothing says which is calling, yet a medication list was ` +
        `returned: ${JSON.stringify(rows)}`);
    } finally { db.pool.query = realQuery; }
  });

  await ok('a SINGLE-patient handset keeps its prior — the common case is untouched', async () => {
    // Losing the prior for everyone would be trading one failure for another:
    // it exists because a caller's own confirmed drugs are the best possible
    // hint for an 8kHz line.
    stub(1);
    try {
      const rows = await db.getPatientMedications('+919876543210');
      assert.strictEqual(rows.length, 1, 'the prior was lost for a phone with only one patient');
      assert.strictEqual(rows[0].canonical, 'Metformin');
    } finally { db.pool.query = realQuery; }
  });

  await ok('no phone, no prior — unchanged', async () => {
    const rows = await db.getPatientMedications(null);
    assert.deepStrictEqual(rows, []);
  });

  // ── THE GUARD WAS SUPPRESSING EVERYTHING ───────────────────────────────────
  // The two cases above are the guard working. This block is what it cost.
  //
  // MEASURED over 122 substantive production calls across 60 days:
  //     0 arrived with a usable prior
  //    22 HAD one and were suppressed right here
  //   100 had none yet
  //
  // Zero. The medication prior — +10.8pp drug capture at 0.00% false positives,
  // the best-evidenced lever in the July research — had never once reached the
  // matcher. Built, wired at four call sites, disarmed by its own guard.
  //
  // Because `patients` stores the same human under both scripts, "siddharth"
  // and "सिद्धार्थ" counted as a household of two. db.js now folds names
  // through latinFormOf before counting, which is what the guard's own comment
  // said the fix was.
  //
  // Both directions are asserted. The restore is worthless if it also revives
  // the wrong-patient bug this file was written to prevent.
  const stubNames = (names) => {
    db.pool.query = async (sql) => {
      if (/SELECT name FROM patients/i.test(sql)) {
        return { rows: names.map((n) => ({ name: n })), rowCount: names.length };
      }
      return { rows: [{ canonical: 'Metformin', brand: 'glycomet', resolution: 'affirmed' }], rowCount: 1 };
    };
  };

  await ok('ONE person written in two scripts KEEPS the prior', async () => {
    stubNames(['siddharth', 'सिद्धार्थ']);   // a real production handset
    try {
      const rows = await db.getPatientMedications('+919876543210');
      assert.strictEqual(rows.length, 1,
        'one human spelled two ways was counted as a household, and the prior was lost — ' +
        'this is the state that produced 0 priors in 60 days of real calls');
    } finally { db.pool.query = realQuery; }
  });

  await ok('...in either script order, and from Kannada too', async () => {
    for (const pair of [
      ['सिद्धार्थ', 'siddharth'],          // order must not matter
      ['ಸಿದ್ಧಾರ್ಥ', 'siddharth'],           // Kannada — via the block shift
    ]) {
      stubNames(pair);
      try {
        const rows = await db.getPatientMedications('+919876543210');
        assert.strictEqual(rows.length, 1, `${JSON.stringify(pair)} was treated as two people`);
      } finally { db.pool.query = realQuery; }
    }
  });

  await ok('KNOWN GAP: Bengali আদিত্য does not yet fold onto "aditya"', async () => {
    // Not a passing case dressed up as one. latinFormOf('আদিত্য') returns
    // "Adity" — the final vowel is dropped — so it does not match the Latin
    // "aditya" and this handset stays suppressed.
    //
    // Pinned rather than hidden: the recall is genuinely still lost for these
    // callers, and the failure is in the romanizer, not the guard. When the
    // romanizer learns this ending, THIS TEST GOES RED and whoever fixed it
    // moves the pair up into the block above. A gap nobody can see is a gap
    // nobody closes.
    stubNames(['আদিত্য', 'aditya']);
    try {
      const rows = await db.getPatientMedications('+919876543210');
      assert.deepStrictEqual(rows, [],
        'Bengali now folds correctly — move this pair into the test above and delete this case');
    } finally { db.pool.query = realQuery; }
  });

  await ok('TWO real people on one handset are STILL suppressed', async () => {
    // The case the guard exists for, and a real production handset: transliteration
    // must not become a way to merge two humans. A wrong prior runs at
    // PRIOR_MAX_DIST 0.50 and writes another patient's drug into this one's record.
    for (const pair of [
      ['सिद्धार्थ', 'atul'],                // measured in production
      ['siddharth', 'sunita'],
      ['ಸಿದ್ಧಾರ್ಥ', 'ಅತುಲ್'],                 // two people, same non-Latin script
    ]) {
      stubNames(pair);
      try {
        const rows = await db.getPatientMedications('+919876543210');
        assert.deepStrictEqual(rows, [],
          `${JSON.stringify(pair)} are different people, yet a prior was returned`);
      } finally { db.pool.query = realQuery; }
    }
  });

  await ok('two Latin names still count as two — the fold cannot merge them', async () => {
    // latinFormOf returns null for anything already Latin, so the fold is
    // `latin || original`. If that fallback were ever dropped, every Latin name
    // would collapse to the same value and a household would silently merge —
    // the exact bug this file exists to prevent, reintroduced by the fix for it.
    stubNames(['rahul', 'sunita']);
    try {
      const rows = await db.getPatientMedications('+919876543210');
      assert.deepStrictEqual(rows, [], 'two Latin names folded together and revived the prior');
    } finally { db.pool.query = realQuery; }
  });

  await ok('a handset with only placeholder names is unchanged by the fold', async () => {
    // '123' and 'Unknown' are not names; cleanPersonName drops them upstream, so
    // the distinct set is EMPTY and the prior loads — which is the behaviour that
    // shipped before this change, and the reason the count was moved off
    // COUNT(DISTINCT name) in the first place. Asserted so the fold is not
    // blamed for it later.
    stubNames(['123', 'Unknown']);
    try {
      const rows = await db.getPatientMedications('+919876543210');
      assert.strictEqual(rows.length, 1,
        'placeholder-only handsets used to keep their prior; the fold changed that');
    } finally { db.pool.query = realQuery; }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
