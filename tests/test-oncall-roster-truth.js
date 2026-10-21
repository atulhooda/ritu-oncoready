#!/usr/bin/env node
// ─── A HAND-WRITTEN LIST OF SIX OVERRULED THE DATABASE ──────────────────────
// LIVE CALL a386bf9938438087ab12a072fb331a8c, 2026-08-12 06:52 IST, verbatim
// from calls.transcript — a Marathi conversation:
//
//   patient  मला कॅन्सर स्पेशालिस्टला भेटायाचे आहे.
//   ritu     आमच्याकडे डॉ. रेखा सरदेसाई (ऑनकोलॉजिस्ट) आहेत, पण त्या ऑन-कॉल
//            स्पेशालिस्ट आहेत. मी त्यांना तुमच्यासाठी कॉलबॅक लावून देऊ का?
//   ritu     Specialty "Oncologist" is not recognized as an on-call specialty.
//   patient  हो लावा।
//   ritu     Specialty "Oncologist" is not recognized as an on-call specialty.
//   [caller hangs up]
//
// TWO FAILURES, EACH SUFFICIENT ON ITS OWN.
//
// 1. Dr. Rekha Sardesai is a real, active, on-call Oncologist — the ONLY
//    on-call doctor this clinic has. ON_CALL_SPECIALTY_ALIASES listed six
//    specialties and gated on them BEFORE reading the roster, so a constant in
//    a source file overruled the database. The prompt offered her correctly;
//    the tool then denied she existed.
//
// 2. error_message is English developer text and brain-lean.js SPOKE it, twice,
//    to a Marathi speaker. I wrote the comment "its error_message is written to
//    be spoken, so prefer it" the previous day. It was simply false.
//
// Same shape as the four sentinel lists that read REQUEST_CALLBACK aloud at a
// patient 20 hours earlier: a hand-maintained constant that must agree with
// reality, and does not. The roster IS the reality.
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

console.log('\nON-CALL ROSTER — the database decides who exists, not a constant\n');

(async () => {
  const tool = require('../tools/requestCallback.js');

  // The real Smile Dental on-call roster: exactly one doctor, an Oncologist.
  const rosterPool = (doctors) => ({
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FROM doctors/i.test(s)) return { rows: doctors, rowCount: doctors.length };
      if (/FROM callbacks/i.test(s) && /SELECT id, patient_name/i.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO callbacks/i.test(s)) return { rows: [{ id: 'cb-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  });
  const ONCOLOGY = [{ id: 'd1', name: 'Dr. Rekha Sardesai', specialty: 'Oncologist' }];
  const ctx = (doctors) => ({ pool: rosterPool(doctors), clinicId: 'clinic-1', patientPhone: '+918273500806' });

  const run = (specialty, doctors = ONCOLOGY) =>
    tool.execute({ patient_name: 'Siddharth', specialty, reason: 'Cancer consultation' }, ctx(doctors));

  // ── 1. the exact live failure ────────────────────────────────────────────
  await ok('THE LIVE CALL: "Oncologist" reaches the on-call oncologist', async () => {
    const r = await run('Oncologist');
    assert(r && r.success,
      `the only on-call doctor at this clinic IS an Oncologist and the tool refused: ${r && r.error_message}`);
  });

  await ok('"Oncology" reaches her too — the stem, not the exact string', async () => {
    const r = await run('Oncology');
    assert(r && r.success, `refused a trivial variant of the stored specialty: ${r && r.error_message}`);
  });

  // ── 2. the alias map must still work for what it did cover ──────────────
  await ok('the alias groups still match — neurology/neurologist', async () => {
    const NEURO = [{ id: 'd2', name: 'Dr. Manoj Deo', specialty: 'Neurologist' }];
    for (const said of ['Neurology', 'Neurologist', 'neurology']) {
      const r = await run(said, NEURO);
      assert(r && r.success, `"${said}" no longer matches a Neurologist: ${r && r.error_message}`);
    }
  });

  // ── 3. it must still REFUSE what is genuinely not on call ───────────────
  await ok('a specialty nobody is on call for is still refused', async () => {
    const r = await run('Dermatologist');
    assert(!(r && r.success),
      'matched a specialty no on-call doctor has — the stem rule is too loose and will book air');
    assert(/Oncologist/.test(r.error_message || ''),
      `the refusal should name who IS on call, for the log: ${r.error_message}`);
  });

  await ok('a short or empty specialty cannot stem-match its way in', async () => {
    for (const junk of ['on', 'x', '', '   ']) {
      const r = await run(junk);
      assert(!(r && r.success), `"${junk}" was accepted as a specialty`);
    }
  });

  await ok('a clinic with NOBODY on call says so plainly', async () => {
    const r = await run('Oncologist', []);
    assert(!(r && r.success));
    assert(/no on-call doctors/i.test(r.error_message || ''), `unclear refusal: ${r.error_message}`);
  });

  // ── 4. the patient must never hear the English ─────────────────────────
  await ok('a refusal is spoken in the caller\'s language, never as error_message', async () => {
    const lean = require('../brain-lean.js');
    const db = require('../db.js');
    const real = db.pool.query.bind(db.pool);
    db.pool.query = async (sql) => {
      // No on-call doctor at all, so the tool must refuse.
      if (/FROM doctors/i.test(String(sql))) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
    try {
      const out = await lean.processLeanRaw(
        'ठीक आहे.\nREQUEST_CALLBACK:{"patientName":"Siddharth","specialty":"Oncologist","reason":"Cancer"}',
        { clinicId: 'clinic-1', callerPhone: '+918273500806', languageCode: 'mr-IN' }
      );
      const said = String((out && out.text) || '');
      assert(!/not recognized|No on-call doctor|Invalid patient phone|error/i.test(said),
        `English developer text was handed to TTS — the 2026-08-12 bug: ${JSON.stringify(said)}`);
      assert(!/[A-Za-z]{6,}\s+[A-Za-z]{6,}/.test(said),
        `the refusal looks like an English sentence rather than a spoken line: ${JSON.stringify(said)}`);
      assert(said.length > 0, 'a refusal must still say something — silence reads as a dropped call');
      assert(!out.callbackRequested, 'a refused callback was reported as arranged');
    } finally { db.pool.query = real; }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
