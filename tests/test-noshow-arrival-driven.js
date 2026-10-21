#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE NO-SHOW JOB ASKS "DID THEY ARRIVE?", NOT "DID ANYONE CONFIRM?"
//
// Until 2026-09-12 runNoShowJob selected `confirmed = false`. Nothing in
// production ever set confirmed = TRUE, so every patient who turned up would
// have been marked no_show and messaged "aaj aap nahi aa paaye" an hour after
// their slot. Migration 019 adds appointments.arrived_at, which the desk's
// Arrived button writes, and the job now sweeps `arrived_at IS NULL`.
//
// This file drives the job (flag on) against an intercepted pool and proves:
//   · the SELECT carries the arrival predicate and not the old flag;
//   · a row the arrival predicate returns is the row that gets marked;
//   · the sweep is still bounded (1h grace, 48h floor) — the arithmetic that
//     was always right must not regress while the column changes.
//
// MUT-NOSHOW-CONFIRMED-PREDICATE simulates the regression: the SQL the job
// sends is rewritten back to `confirmed = false` before the stub answers it —
// exactly what production would send if someone reverted the predicate. Every
// assertion about the predicate must then go red.
//
// Run:            node tests/test-noshow-arrival-driven.js
// Prove it fails: MUTANT=MUT-NOSHOW-CONFIRMED-PREDICATE node tests/test-noshow-arrival-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');
require('./_bootstrap').mutatesEnv('arms NOSHOW_JOB=on to drive the job body that the gate normally hides');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nNO-SHOW JOB — arrival predicate, driven\n');

(async () => {
  // Patch the senders BEFORE the scheduler binds them (same order lesson as
  // test-scheduler-gates-driven.js: a later patch is invisible to it).
  const db = require('../db.js');
  const whatsapp = require('../whatsapp.js');
  const sends = [];
  whatsapp.sendTemplateOrText = async (to, tmpl, vars, text) => { sends.push({ to, text }); return 'wamid.TEST'; };
  whatsapp.sendWhatsAppMessage = async () => 'wamid.TEST';
  whatsapp.sendWhatsAppTemplate = async () => 'wamid.TEST';
  const scheduler = require('../scheduler.js');

  const unarrived = {
    id: 'appt-unarrived', appointment_time: new Date(Date.now() - 2 * 3600e3),
    patient_id: 'pat-1', phone_number: '+919999999999',
  };

  const queries = [];
  db.pool.query = async (sql, params = []) => {
    let s = String(sql).replace(/\s+/g, ' ');
    if (MUTANT === 'MUT-NOSHOW-CONFIRMED-PREDICATE') {
      // The regression, as production would send it.
      s = s.replace(/arrived_at IS NULL/gi, 'confirmed = false');
    }
    queries.push({ sql: s, params });
    // The intercept answers ONLY the arrival predicate. If the job asks the
    // old question it gets nothing — which is the point: the row a receptionist
    // marked Arrived is exactly the row the old predicate would have swept.
    if (/FROM appointments a/i.test(s) && /arrived_at IS NULL/i.test(s)) return { rows: [unarrived], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  db.getOrCreateConversation = async () => ({ id: 'conv-1', language: 'hi' });
  db.saveWhatsAppMessage = async () => ({});

  process.env.NOSHOW_JOB = 'on';
  const result = await scheduler.runNoShowJob();
  delete process.env.NOSHOW_JOB;

  const select = queries.find((q) => /FROM appointments a/i.test(q.sql));
  const updates = queries.filter((q) => /UPDATE appointments SET status = 'no_show'/i.test(q.sql));

  ok('the sweep SELECT exists', () => assert.ok(select, 'no SELECT FROM appointments was issued'));
  ok('the sweep asks arrived_at IS NULL', () => {
    assert.match(select.sql, /\barrived_at IS NULL\b/i, `predicate missing from: ${select.sql}`);
  });
  ok('the sweep no longer asks confirmed = false', () => {
    assert.doesNotMatch(select.sql, /confirmed\s*=\s*false/i, `old predicate still present: ${select.sql}`);
  });
  ok('the sweep keeps its 1-hour grace and 48-hour floor', () => {
    assert.match(select.sql, /INTERVAL '1 hour'/i, 'grace window gone');
    assert.match(select.sql, /INTERVAL '48 hours'/i, '48h floor gone');
    assert.match(select.sql, /LIMIT 50/i, 'per-run cap gone');
  });
  ok('the sweep is scoped to status = booked (arrival is a column, never a status)', () => {
    assert.match(select.sql, /a\.status = 'booked'/i, 'status scope gone');
  });
  ok('the row the arrival predicate returns is the row marked no_show', () => {
    assert.strictEqual(result.scanned, 1, `scanned=${result.scanned}`);
    assert.strictEqual(updates.length, 1, `${updates.length} UPDATE(s)`);
    assert.deepStrictEqual(updates[0].params, ['appt-unarrived']);
  });
  ok('that patient is messaged once', () => {
    assert.strictEqual(sends.length, 1, `${sends.length} send(s)`);
    assert.strictEqual(sends[0].to, '+919999999999');
  });

  if (MUTANT && fail === 0) {
    console.log(`\n  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`);
    process.exit(1);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
