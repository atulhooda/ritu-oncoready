#!/usr/bin/env node
// ─── ONE HANDSET, FIVE SPELLINGS, NO PATIENT ────────────────────────────────
// tools/utils/phoneNormalizer.js has claimed since the day it was written to be
// the "single source of truth for all tools + db.js". The tools imported it.
// db.js did not, and compared `phone = $2` against whatever string the carrier
// happened to send that call.
//
// MEASURED ON PRODUCTION 2026-08-11, scoped per clinic the way db.js queries:
//
//     Smile Dental ....... 30 phone strings ->  22 real handsets   (8 split)
//     Sai Shradha ........  5 phone strings ->   3 real handsets   (2 split)
//
// One handset was filed under all three of "9945450845", "919945450845" and
// "+919945450845". Which one you got decided whether you were a patient. Every
// consequence is silent:
//     getPatientMedications  -> no prior      (recall, the metric we optimise)
//     getReturningPatientName-> greeted as new, asked your name again
//     checkReturningPatient  -> no history
//
// AND A SECOND BUG IN THE SAME FUNCTION. getReturningPatientName ordered by
// created_at DESC, took LIMIT 1, and only THEN ran cleanPersonName. Prithvi's
// handset holds, newest first:
//     ಅಪರಿಚಿತ | pruthvi | gawda | prithvi | . | unknown
// "ಅಪರಿಚಿತ" is Kannada for "unknown". It is the newest row, so the single row
// the query returned cleaned to null and a patient with four recorded visits
// was greeted as a stranger. The junk filter was correct; it just ran after the
// choice had already been made.
//
// THIS TEST DRIVES db.js. Three of four production defects this week passed
// tests that read source text (see tests/test-whatsapp-inbound.js), so the stub
// below is a small query interpreter, not an agreeable mock: it asserts the
// phone parameter is a real ARRAY and does set membership. A string parameter
// would substring-match "9945450845" inside "+919945450845" and let the bug
// through green — which is exactly the shape of vacuous pass being guarded
// against here.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
// CLINIC_ID_UUID, not CLINIC_ID. config.js:242 reads CLINIC_ID_UUID and NOTHING
// in production reads a bare CLINIC_ID — this file was the only place in the
// repo that set it. It went unnoticed because the old in-line upsertPatient
// never checked the clinic id; patientIdentity.resolvePatient does, and returned
// null for every call, which surfaced as "the feature is broken" rather than
// "the harness was configured for a variable that does not exist".
process.env.CLINIC_ID_UUID = process.env.CLINIC_ID_UUID || '11111111-1111-1111-1111-111111111111';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nPHONE IDENTITY — one handset is one patient, however it is spelled\n');

(async () => {
  const db = require('../db.js');
  const { phoneVariants } = require('../tools/utils/phoneNormalizer');
  const realQuery = db.pool.query.bind(db.pool);

  // ── a faithful little Postgres ────────────────────────────────────────────
  // rows: [{phone, name, created_at}] newest first is NOT assumed; created_at
  // decides, as it does in the real table.
  let PATIENTS = [];
  let MEDS = [];
  const installStub = () => {
    db.pool.query = async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      // Every phone-keyed query must hand us a LIST. This is the assertion that
      // makes the mutation detectable rather than merely different.
      if (/phone = ANY/.test(s)) {
        assert(Array.isArray(params[1]),
          `phone parameter must be an array for = ANY, got ${typeof params[1]}: ${JSON.stringify(params[1])}`);
      } else if (/FROM patients|FROM patient_medications/.test(s) && /phone/.test(s)) {
        throw new Error(`a phone-keyed query still compares a single string: ${s.slice(0, 90)}`);
      }
      const set = new Set(params[1] || []);
      const mine = (r) => set.has(r.phone);

      if (/UPDATE patients SET name/.test(s)) {
        const row = PATIENTS.find((r) => r.id === params[0]);
        if (row) row.name = params[1];
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO patients/.test(s)) {
        const row = { id: `p${PATIENTS.length + 1}`, phone: params[1], name: params[2], created_at: new Date() };
        PATIENTS.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      // patientIdentity.resolvePatient selects `id, name, created_at`; the old
      // in-line upsertPatient selected `id, phone, name`. Consolidating the three
      // "who is this caller" implementations into one changed the query, and a
      // stub pinned to the dead shape fell through to the default branch and
      // reported the feature broken. Match on the TABLE and the intent, not on a
      // column list that is free to change.
      if (/SELECT id, (?:phone, name|name, created_at) FROM patients/.test(s)) {
        return { rows: PATIENTS.filter(mine), rowCount: 0 };
      }
      if (/SELECT 1 FROM patients/.test(s)) {
        return { rows: PATIENTS.filter(mine).slice(0, 1), rowCount: 0 };
      }
      if (/SELECT name FROM patients/.test(s)) {
        // APPLY THE 'unknown' FILTER ONLY WHEN THE SQL ASKS FOR IT. Two
        // different queries hit this branch and only one carries
        // `LOWER(name) <> 'unknown'`: getReturningPatientName does, the
        // household count does NOT — it relies on cleanPersonName in JS.
        // This stub used to filter unconditionally, so it did db.js's
        // placeholder work for it and the household assertion held no matter
        // what db.js did. Caught by an adversarial audit of this very file on
        // the day it was written, which is the point of mutation-proving a
        // stub instead of trusting it.
        let rows = PATIENTS.filter(mine);
        if (/LOWER\(name\) <> 'unknown'/.test(s)) {
          rows = rows.filter((r) => r.name && r.name.toLowerCase() !== 'unknown');
        }
        if (/ORDER BY created_at DESC/.test(s)) {
          rows = rows.slice().sort((a, b) => b.created_at - a.created_at);
          if (/LIMIT 1/.test(s)) rows = rows.slice(0, 1); // honours the old bug if it returns
        }
        return { rows, rowCount: rows.length };
      }
      if (/FROM patient_medications/.test(s)) {
        return { rows: MEDS.filter(mine), rowCount: MEDS.length };
      }
      return { rows: [], rowCount: 0 };
    };
  };

  const t = (n) => new Date(2026, 0, n);

  // ═══ 1. the handset that is filed under three formats ════════════════════
  await ok('a caller is recognised however the carrier formatted the number', async () => {
    PATIENTS = [{ id: 'p1', phone: '+919945450845', name: 'Prithvi', created_at: t(1) }];
    installStub();
    for (const dialed of ['9945450845', '919945450845', '+919945450845', '09945450845']) {
      assert.strictEqual(await db.getReturningPatientName(dialed), 'Prithvi',
        `dialed as ${dialed} and the patient was not found`);
      assert.strictEqual(await db.checkReturningPatient(dialed), true,
        `dialed as ${dialed} and history was not found`);
    }
  });

  // ═══ 2. the Kannada placeholder that hid a real patient ══════════════════
  await ok('THE BUG: a newer junk row no longer hides an older real name', async () => {
    // Exactly Prithvi's production row set, newest first.
    PATIENTS = [
      { id: 'p1', phone: '9945450845',    name: 'unknown',  created_at: t(1) },
      { id: 'p2', phone: '9945450845',    name: '.',        created_at: t(2) },
      { id: 'p3', phone: '919945450845',  name: 'prithvi',  created_at: t(3) },
      { id: 'p4', phone: '9945450845',    name: 'gawda',    created_at: t(4) },
      { id: 'p5', phone: '+919945450845', name: 'Pruthvi',  created_at: t(5) },
      { id: 'p6', phone: '9945450845',    name: 'ಅಪರಿಚಿತ',  created_at: t(6) }, // newest, junk
    ];
    installStub();
    const got = await db.getReturningPatientName('+919945450845');
    assert.strictEqual(got, 'Pruthvi',
      `the newest row is Kannada for "unknown"; the newest REAL name is Pruthvi, got ${JSON.stringify(got)}`);
  });

  await ok('a handset with nothing but junk is honestly nobody', async () => {
    PATIENTS = [
      { id: 'p1', phone: '9945450845', name: 'unknown', created_at: t(1) },
      { id: 'p2', phone: '9945450845', name: 'ಅಪರಿಚಿತ', created_at: t(2) },
      { id: 'p3', phone: '9945450845', name: 'your name', created_at: t(3) },
    ];
    installStub();
    assert.strictEqual(await db.getReturningPatientName('9945450845'), null,
      'invented a name out of placeholder rows');
  });

  // ═══ 3. the prior, which is what the accuracy number actually rides on ════
  await ok('the medication prior survives a fragmented handset', async () => {
    PATIENTS = [{ id: 'p1', phone: '+919945450845', name: 'Prithvi', created_at: t(1) }];
    MEDS = [{ phone: '919945450845', canonical: 'Metformin', brand: 'glycomet', resolution: 'affirmed' }];
    installStub();
    const rows = await db.getPatientMedications('9945450845');
    assert.strictEqual(rows.length, 1,
      'the prior was stored under one format and read under another — silently lost');
    assert.strictEqual(rows[0].canonical, 'Metformin');
  });

  await ok('an "Unknown" row beside a real one is not a household', async () => {
    // The old COUNT(DISTINCT name) counted 'Unknown' as a person, so the guard
    // fired on the single-patient case it exists to protect.
    PATIENTS = [
      { id: 'p1', phone: '9945450845',    name: 'Unknown',  created_at: t(1) },
      { id: 'p2', phone: '+919945450845', name: 'Prithvi',  created_at: t(2) },
      { id: 'p3', phone: '919945450845',  name: 'prithvi',  created_at: t(3) }, // same human, case
    ];
    MEDS = [{ phone: '9945450845', canonical: 'Metformin', brand: 'glycomet', resolution: 'affirmed' }];
    installStub();
    const rows = await db.getPatientMedications('9945450845');
    assert.strictEqual(rows.length, 1,
      'one patient plus a placeholder plus a case variant was read as three people and the prior was dropped');
  });

  await ok('a REAL household still loses the prior — 556b9b4 stays fixed', async () => {
    PATIENTS = [
      { id: 'p1', phone: '9945450845',    name: 'Prithvi', created_at: t(1) },
      { id: 'p2', phone: '+919945450845', name: 'Atul',    created_at: t(2) },
    ];
    MEDS = [{ phone: '9945450845', canonical: 'Metformin', brand: 'glycomet', resolution: 'affirmed' }];
    installStub();
    assert.deepStrictEqual(await db.getPatientMedications('9945450845'), [],
      'two different people share this handset and one of them got the other\'s drug list');
  });

  // ═══ 4. writes stop making new fragments ═════════════════════════════════
  await ok('a return visit claims the existing row instead of minting a format twin', async () => {
    PATIENTS = [{ id: 'p1', phone: '+919945450845', name: 'Prithvi', created_at: t(1) }];
    installStub();
    const id = await db.upsertPatient('9945450845', 'Prithvi');
    assert.strictEqual(id, 'p1', 'created a second row for a patient already in the table');
    assert.strictEqual(PATIENTS.length, 1, `handset split again: ${JSON.stringify(PATIENTS.map((r) => r.phone))}`);
  });

  await ok('a real name renames the placeholder rather than sitting beside it', async () => {
    PATIENTS = [{ id: 'p1', phone: '+919945450845', name: 'Unknown', created_at: t(1) }];
    installStub();
    const id = await db.upsertPatient('9945450845', 'Prithvi');
    assert.strictEqual(id, 'p1', 'left the placeholder and started a second row');
    assert.strictEqual(PATIENTS[0].name, 'Prithvi');
  });

  await ok('a genuinely new handset is stored canonical', async () => {
    PATIENTS = [];
    installStub();
    await db.upsertPatient('+919945450845', 'Prithvi');
    assert.strictEqual(PATIENTS[0].phone, '9945450845',
      `new rows must go in canonical 10-digit or the fragmentation restarts: got ${PATIENTS[0].phone}`);
  });

  // ═══ 5. the guard on the guard ═══════════════════════════════════════════
  await ok('an unparseable number matches ITSELF and never everything', async () => {
    // phoneVariants returning [] would turn `= ANY([])` into "no rows", but a
    // caller that then fell back to a bare LIKE would match the table. Landlines
    // and garbled STT captures must stay addressable and stay narrow.
    assert.deepStrictEqual(phoneVariants('02224101234'), ['02224101234']);
    assert.deepStrictEqual(phoneVariants(''), []);
    assert.deepStrictEqual(phoneVariants(null), []);
    assert(phoneVariants('9945450845').includes('9945450845'));
  });

  db.pool.query = realQuery;
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
