#!/usr/bin/env node
'use strict';
// THE DESK CAN SEE WHICH TEMPLATES META HAS APPROVED, WITHOUT A TERMINAL.
//
// templateStatus.checkTemplateStatus reads the WABA's template list, folds it
// into our seven templates × the languages that matter, and the scheduler's
// hourly job writes it into clinics.runtime.templates via db.reportRuntime —
// which must keep it on later reports. Driven with a stub list and a stub pool.
//
// Run:            node tests/test-template-status-driven.js
// Prove it fails: MUTANT=MUT-TEMPLATES-NOT-REPORTED node tests/test-template-status-driven.js
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.META_TEMPLATE_LANGUAGE = 'gu';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const db = require('../db');
const ts = require('../templateStatus');
const scheduler = require('../scheduler');
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const EXISTING = [
  { name: 'appointment_confirmation', language: 'gu', status: 'APPROVED', category: 'UTILITY' },
  { name: 'appointment_confirmation', language: 'en', status: 'APPROVED', category: 'UTILITY' },
  { name: 'appointment_confirmation', language: 'mr', status: 'PENDING', category: 'UTILITY' },
  { name: 'appointment_reminder', language: 'gu', status: 'PENDING', category: 'UTILITY' },
  { name: 'no_show_recovery', language: 'hi', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' },
  { name: 'engageo_welcome', language: 'en', status: 'APPROVED', category: 'MARKETING' },
];

(async () => {
  console.log('\nTEMPLATE STATUS — driven\n');

  ok('statusBlock: default language first, found languages in the middle, English last; marketing templates ignored', () => {
    const b = ts.statusBlock(EXISTING, 'gu', '1234567893915');
    assert.deepStrictEqual(b.languages, ['gu', 'hi', 'mr', 'en']);
    assert.strictEqual(b.waba, '…3915');
    const row = (n) => b.table.find((r) => r.name === n);
    assert.strictEqual(row('appointment_confirmation').gu, 'APPROVED');
    assert.strictEqual(row('appointment_confirmation').mr, 'PENDING');
    assert.strictEqual(row('appointment_reminder').hi, 'MISSING');
    assert.strictEqual(row('no_show_recovery').hi, 'REJECTED(INVALID_FORMAT)');
    assert.strictEqual(b.approved, 2); assert.strictEqual(b.total, 7 * 4);
    assert.ok(!b.table.some((r) => r.name === 'engageo_welcome'));
    assert.ok(b.checkedAt);
  });
  ok('an English-default clinic lists English once, first', () => assert.deepStrictEqual(ts.statusBlock(EXISTING, 'en', 'x').languages, ['en', 'gu', 'hi', 'mr']));

  const block = await ts.checkTemplateStatus({ creds: { token: 't', waba: '5077' }, list: async () => EXISTING, log: quiet });
  ok('checkTemplateStatus folds the live list into the block', () => { assert.strictEqual(block.approved, 2); assert.strictEqual(block.waba, '…5077'); });
  const noCreds = await ts.checkTemplateStatus({ creds: null, log: quiet });
  ok('no credentials → an error block naming the fix, never a throw', () => assert.match(noCreds.error, /credentials/));
  const failed = await ts.checkTemplateStatus({ creds: { token: 't', waba: '1' }, list: async () => { const e = new Error('x'); e.response = { data: { error: { message: 'Invalid OAuth access token' } } }; throw e; }, log: quiet });
  ok('a Meta error → an error block with Meta\'s message', () => assert.match(failed.error, /OAuth/));

  // the job writes the block into the runtime report
  const reported = [];
  const realReport = db.reportRuntime;
  delete process.env.RAILWAY_SERVICE_NAME;
  const local = await scheduler.runTemplateStatusJob();
  ok('outside Railway the job is gated', () => assert.strictEqual(local.gated, true));
  process.env.RAILWAY_SERVICE_NAME = 'engageo-server-v2';
  db.reportRuntime = async (extra) => { reported.push(extra); return { ok: true }; };
  ts.checkTemplateStatus = async () => block;
  if (MUTANT === 'MUT-TEMPLATES-NOT-REPORTED') db.reportRuntime = async () => ({ ok: true }); // the block is computed and dropped
  const r = await scheduler.runTemplateStatusJob();
  ok('runTemplateStatusJob reports { templates } through db.reportRuntime', () => {
    assert.strictEqual(r.ran, true);
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].templates, block);
  });
  process.env.TEMPLATE_STATUS_CHECK = 'off';
  const gated = await scheduler.runTemplateStatusJob();
  ok('TEMPLATE_STATUS_CHECK=off gates the job', () => assert.deepStrictEqual(gated, { gated: true }));
  delete process.env.TEMPLATE_STATUS_CHECK;
  db.reportRuntime = realReport;

  // reportRuntime keeps earlier extras and the boot time across reports
  const writes = [];
  db.pool.query = async (sql, params) => { writes.push(JSON.parse(params[3])); return { rowCount: 1, rows: [] }; };
  await db.reportRuntime({ templates: { approved: 1, total: 7 } });
  await db.reportRuntime();
  ok('a later reportRuntime() keeps the templates block and the same bootedAt', () => {
    assert.strictEqual(writes.length, 2);
    assert.deepStrictEqual(writes[1].templates, { approved: 1, total: 7 });
    assert.strictEqual(writes[1].bootedAt, writes[0].bootedAt);
    assert.ok(writes[1].jobs && typeof writes[1].jobs.outbox === 'boolean', 'jobs include outbox');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
