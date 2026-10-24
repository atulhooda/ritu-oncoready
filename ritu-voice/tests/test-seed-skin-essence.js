#!/usr/bin/env node
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
// The Skin Essence seed, driven against a pg-mem database built from the real
// migrations: run twice, the second run changes nothing; every row the spec
// names is there with the values the code reads (disclose_price, the 19:00
// evening window, the follow-up policy, the default doctor); past holidays are
// not written. MUTANT=MUT-SEED-ACCUMULATES — the treatment upsert becomes an insert.
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { newDb, DataType } = require('pg-mem');
const { splitStatements } = require('../db/splitStatements');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

(async () => {
  const mem = newDb();
  // pg-mem evaluates a column default once per statement unless the function is impure;
  // trim() is missing entirely (016's CHECK constraints use it).
  mem.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => require('crypto').randomUUID() });
  mem.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (x) => (x == null ? null : String(x).trim()) });
  mem.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (x) => (x == null ? null : String(x).length) });
  let applied = 0, skipped = [];
  for (const f of ['001_tool_calling_schema.sql', '012_treatments.sql', '014_price_disclosure.sql', '015_clinic_fee_policy.sql', '016_clinic_faqs.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8');
    for (const stmt of splitStatements(sql)) { try { mem.public.none(stmt); applied++; } catch (e) { skipped.push(`${f}: ${e.message.split('\n')[0].slice(0, 80)}`); } }
  }
  console.log(`  schema: ${applied} statements applied, ${skipped.length} pg-mem could not run` + (skipped.length ? `\n    ${skipped.slice(0, 6).join('\n    ')}` : ''));
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const seedMod = require('../db/seed-skin-essence.js');
  if (MUTANT === 'MUT-SEED-ACCUMULATES') {
    const real = pool.connect.bind(pool);
    pool.connect = async () => { const c = await real(); const q = c.query.bind(c); c.query = (sql, params) => (/SELECT id FROM treatments/.test(sql) ? Promise.resolve({ rows: [] }) : q(sql, params)); return c; };
  }
  const count = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
  const r1 = await seedMod.seed(pool, { today: '2026-09-05', log: () => {} });
  const r2 = await seedMod.seed(pool, { today: '2026-09-05', log: () => {} });

  console.log('\n[1] the rows the spec names');
  await ok('one clinic, fixed id', async () => assert.strictEqual(await count('SELECT count(*)::int n FROM clinics WHERE id = $1', [seedMod.CLINIC_ID]), 1));
  await ok('two doctors, fee 700', async () => assert.strictEqual(await count("SELECT count(*)::int n FROM doctors WHERE clinic_id = $1 AND fee_inr = 700", [seedMod.CLINIC_ID]), 2));
  await ok('24 schedule rows, Mon–Sat', async () => { assert.strictEqual(await count('SELECT count(*)::int n FROM doctor_schedules WHERE doctor_id IN ($1, $2)', [seedMod.DAKSHA_ID, seedMod.JIGISHA_ID]), 24); assert.strictEqual(await count('SELECT count(*)::int n FROM doctor_schedules WHERE doctor_id IN ($1, $2) AND day_of_week = 0', [seedMod.DAKSHA_ID, seedMod.JIGISHA_ID]), 0); });
  await ok("Dr. Jigisha's evening window ends 19:00, Dr. Daksha's 20:00", async () => {
    const j = await pool.query("SELECT end_time::text AS e FROM doctor_schedules WHERE doctor_id = $1 AND start_time::text LIKE '16:%' LIMIT 1", [seedMod.JIGISHA_ID]);
    const d = await pool.query("SELECT end_time::text AS e FROM doctor_schedules WHERE doctor_id = $1 AND start_time::text LIKE '16:%' LIMIT 1", [seedMod.DAKSHA_ID]);
    assert.match(j.rows[0].e, /^19:00/); assert.match(d.rows[0].e, /^20:00/);
  });
  await ok('the lunch break: no window covers 15:00', async () => assert.strictEqual(await count("SELECT count(*)::int n FROM doctor_schedules WHERE doctor_id IN ($1, $2) AND start_time <= '15:00' AND end_time > '15:00'", [seedMod.DAKSHA_ID, seedMod.JIGISHA_ID]), 0));
  await ok('five treatments; wart and tattoo removal not quotable', async () => {
    assert.strictEqual(await count('SELECT count(*)::int n FROM treatments WHERE clinic_id = $1 AND active', [seedMod.CLINIC_ID]), 5);
    assert.strictEqual(await count('SELECT count(*)::int n FROM treatments WHERE clinic_id = $1 AND disclose_price = FALSE', [seedMod.CLINIC_ID]), 2);
    const h = await pool.query("SELECT price_min, price_max FROM treatments WHERE clinic_id = $1 AND name = 'Hydrafacial'", [seedMod.CLINIC_ID]);
    assert.strictEqual(Number(h.rows[0].price_min), 3000); assert.strictEqual(h.rows[0].price_max, null);
  });
  await ok('follow-up policy 5 days / ₹400 and the default doctor is Dr. Daksha', async () => {
    const c = await pool.query('SELECT followup_free_days, followup_fee_inr, default_doctor_id FROM clinics WHERE id = $1', [seedMod.CLINIC_ID]);
    assert.strictEqual(Number(c.rows[0].followup_free_days), 5); assert.strictEqual(Number(c.rows[0].followup_fee_inr), 400); assert.strictEqual(c.rows[0].default_doctor_id, seedMod.DAKSHA_ID);
  });
  await ok('holidays: only the dates still ahead, for both doctors', async () => {
    assert.strictEqual(await count("SELECT count(*)::int n FROM doctor_exceptions WHERE doctor_id IN ($1, $2) AND exception_type = 'closed'", [seedMod.DAKSHA_ID, seedMod.JIGISHA_ID]), 2);
    assert.deepStrictEqual(r1.skippedHolidays.sort(), ['2026-08-28', '2026-09-04']);
  });
  await ok('no FAQ row until its text is real', async () => assert.strictEqual(await count('SELECT count(*)::int n FROM clinic_faqs WHERE clinic_id = $1', [seedMod.CLINIC_ID]), 0));

  console.log('\n[2] idempotent: the second run adds nothing');
  await ok('second run: 0 new doctors, 0 new treatments, 0 new holidays', async () => { assert.strictEqual(r2.doctors, 0); assert.strictEqual(r2.treatments, 0); assert.strictEqual(r2.exceptions, 0); assert.strictEqual(r2.clinic, 0); });
  await ok('counts unchanged after the second run', async () => { assert.strictEqual(await count('SELECT count(*)::int n FROM treatments WHERE clinic_id = $1', [seedMod.CLINIC_ID]), 5); assert.strictEqual(await count('SELECT count(*)::int n FROM doctor_schedules WHERE doctor_id IN ($1, $2)', [seedMod.DAKSHA_ID, seedMod.JIGISHA_ID]), 24); });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
