#!/usr/bin/env node
'use strict';
// THE TATHASTU SEED WRITES THE FORM'S ROWS ONCE, AND NOTHING TWICE.
// Driven with an in-memory pool: first run inserts the clinic, two doctors
// (one on-call, no schedule), seven daily windows and two FAQs; a second run
// against the now-populated tables inserts nothing and replaces the schedule.
// Run: node tests/test-seed-tathastu-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
const seedMod = require('../db/seed-tathastu');

function memPool() {
  const db = { clinics: new Set(), doctors: new Set(), faqs: new Set(), schedules: new Map() }; // schedules per doctor
  const log = [];
  const client = {
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      log.push({ s, params });
      if (/^SELECT id FROM clinics/.test(s)) return { rows: db.clinics.has(params[0]) ? [{ id: params[0] }] : [] };
      if (/^INSERT INTO clinics/.test(s)) { db.clinics.add(params[0]); return { rows: [] }; }
      if (/^SELECT id FROM doctors/.test(s)) return { rows: db.doctors.has(params[0]) ? [{ id: params[0] }] : [] };
      if (/^INSERT INTO doctors/.test(s)) { db.doctors.add(params[0]); return { rows: [] }; }
      if (/^DELETE FROM doctor_schedules/.test(s)) { db.schedules.set(params[0], 0); return { rows: [] }; }
      if (/^INSERT INTO doctor_schedules/.test(s)) { db.schedules.set(params[0], (db.schedules.get(params[0]) || 0) + 1); return { rows: [] }; }
      if (/^SELECT id FROM clinic_faqs/.test(s)) return { rows: db.faqs.has(params[1]) ? [{ id: 1 }] : [] };
      if (/^INSERT INTO clinic_faqs/.test(s)) { db.faqs.add(params[1]); return { rows: [] }; }
      return { rows: [] }; // BEGIN/COMMIT/UPDATE
    },
    release: () => {},
  };
  return { db, log, connect: async () => client };
}

(async () => {
  console.log('\nTATHASTU SEED — driven\n');
  const pool = memPool();
  const first = await seedMod.seed(pool, { log: () => {} });
  ok('first run: clinic + 2 doctors + 7 windows + 2 FAQs', () => assert.deepStrictEqual(first, { clinic: 1, doctors: 2, schedules: 7, faqs: 2 }));
  ok('Dr. Suhas is on-call with no schedule; Dr. Hrishikesh is the default doctor, Mon–Sun 10:00–20:00', () => {
    const ins = pool.log.filter((q) => /^INSERT INTO doctors/.test(q.s));
    const suhas = ins.find((q) => /Suhas/.test(q.params[2])); const hri = ins.find((q) => /Hrishikesh/.test(q.params[2]));
    assert.strictEqual(suhas.params[4], true); assert.strictEqual(hri.params[4], false);
    const sched = pool.log.filter((q) => /^INSERT INTO doctor_schedules/.test(q.s));
    assert.ok(sched.every((q) => q.params[0] === seedMod.HRISHIKESH_ID && q.params[2] === '10:00' && q.params[3] === '20:00'));
    assert.deepStrictEqual(sched.map((q) => q.params[1]).sort(), [0, 1, 2, 3, 4, 5, 6]);
    const upd = pool.log.find((q) => /^UPDATE clinics SET name/.test(q.s));
    assert.strictEqual(upd.params[2], 'Tathastu'); assert.strictEqual(upd.params[4], 'en');
    // the default doctor is set only after the doctor rows exist (FK) — the first live run died on this
    const dd = pool.log.findIndex((q) => /^UPDATE clinics SET default_doctor_id/.test(q.s));
    const lastDoctorInsert = pool.log.map((q) => /^INSERT INTO doctors/.test(q.s)).lastIndexOf(true);
    assert.ok(dd > lastDoctorInsert, 'default_doctor_id must be set after the doctors are inserted');
    assert.strictEqual(pool.log[dd].params[1], seedMod.HRISHIKESH_ID);
  });
  const second = await seedMod.seed(pool, { log: () => {} });
  ok('second run: nothing inserted, the 7 windows replaced not doubled', () => { assert.deepStrictEqual(second, { clinic: 0, doctors: 0, schedules: 7, faqs: 0 }); assert.strictEqual(pool.db.schedules.get(seedMod.HRISHIKESH_ID), 7); assert.strictEqual(pool.db.schedules.get(seedMod.SUHAS_ID) || 0, 0); });
  ok('no placeholder text reaches a patient', () => { for (const f of seedMod.FAQS) assert.ok(f.answer && !/type here|paste/i.test(f.answer)); });
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
