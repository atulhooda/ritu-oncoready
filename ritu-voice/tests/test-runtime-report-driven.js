#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE VOICE SERVICE WRITES ITS RUNNING SWITCHES WHERE THE DESK CAN READ THEM.
//
// The desk cannot see this service's environment, so it hard-coded a
// 30-minute slot and could not say whether Ritu may cancel. db.reportRuntime()
// runs at boot and shadows the live values onto the clinic row (migration 019):
// slot_minutes, agent_may_cancel, and the job flags as JSON.
//
// Driven against an intercepted pool: the UPDATE must carry config's values,
// and a database without the column (42703) must be a warning, never a throw —
// boot has to survive a migration that has not landed yet.
//
// Run: node tests/test-runtime-report-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};

console.log('\nRUNTIME REPORT — driven\n');

(async () => {
  const config = require('../config.js');
  const db = require('../db.js');
  const { jobStates } = require('../jobFlags.js');

  const queries = [];
  db.pool.query = async (sql, params = []) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' '), params });
    return { rows: [], rowCount: 1 };
  };

  const r = await db.reportRuntime({ marker: 'test' });
  const upd = queries.find((q) => /UPDATE clinics/i.test(q.sql));

  ok('reports ok and issues one UPDATE clinics', () => {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(upd, 'no UPDATE clinics issued');
  });
  ok('the UPDATE writes slot_minutes, agent_may_cancel, runtime and the timestamp', () => {
    assert.match(upd.sql, /slot_minutes = \$2/);
    assert.match(upd.sql, /agent_may_cancel = \$3/);
    assert.match(upd.sql, /runtime = \$4/);
    assert.match(upd.sql, /runtime_reported_at = NOW\(\)/);
  });
  ok('the values are config\'s own, for this clinic', () => {
    assert.strictEqual(upd.params[0], config.clinicId);
    assert.strictEqual(upd.params[1], config.appointmentSlotMinutes);
    assert.strictEqual(upd.params[2], config.agentMayCancel);
  });
  ok('the runtime JSON carries the resolved job flags and the extra marker', () => {
    const j = JSON.parse(upd.params[3]);
    assert.deepStrictEqual(j.jobs, jobStates());
    assert.strictEqual(j.marker, 'test');
    assert.ok(j.bootedAt, 'bootedAt missing');
  });

  // A database where 019 has not landed: the column is missing.
  db.pool.query = async () => { const e = new Error('column "slot_minutes" of relation "clinics" does not exist'); e.code = '42703'; throw e; };
  let threw = null, r2;
  try { r2 = await db.reportRuntime(); } catch (e) { threw = e; }
  ok('a missing column is reported, not thrown (boot survives an unapplied migration)', () => {
    assert.strictEqual(threw, null, `threw: ${threw && threw.message}`);
    assert.strictEqual(r2.ok, false);
  });

  // No clinics row at all.
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  const r3 = await db.reportRuntime();
  ok('a missing clinic row is reported as no_clinic_row', () => {
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.error, 'no_clinic_row');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
