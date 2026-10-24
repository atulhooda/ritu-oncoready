#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEDULED JOBS, DRIVEN — INCLUDING THE GATE THAT STOPS ONE OF THEM.
//
// The no-show job selects `arrived_at IS NULL` an hour after an appointment,
// marks the row no_show, and WhatsApps the patient "aaj aap nahi aa paaye".
// Until 2026-09-12 it selected `confirmed = false`, a column nothing in
// production ever set, so it would have messaged the patients who ATTENDED
// (52 of 59 mismarked on the demo clinic, 2026-08-25). arrived_at is written by
// the desk's Arrived button (migration 019); the predicate itself is proven by
// tests/test-noshow-arrival-driven.js. The gate stays default-off until a clinic
// is marking arrivals daily.
//
// WHY THIS FILE EXISTS AT ALL. Until 2026-08-26 every job here was an inline
// closure inside cron.schedule(...) — unreachable, so untested, which is how
// the bug survived. The refactor to named exports is what makes this file
// possible, and this file is what stops the refactor from being decorative.
//
// The gate is asserted by DRIVING the job against an intercepted pool and
// proving no UPDATE and no send happened — not by grepping for the flag.
// MUT-NOSHOW-ALWAYS-ON removes the gate and must turn this file red.
//
// Run:            node tests/test-scheduler-gates-driven.js
// Prove it fails: MUTANT=MUT-NOSHOW-ALWAYS-ON node tests/test-scheduler-gates-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('drives every job flag through both values — the flags themselves are under test');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};

const MUTANT = process.env.MUTANT || null;

console.log('\nSCHEDULER GATES — driven, not grepped\n');

(async () => {
  // ORDER MATTERS, AND IT BIT ONCE. scheduler.js destructures its senders at
  // require time (`const { sendTemplateOrText } = require('./whatsapp')`), so a
  // patch applied after that require is invisible to it — the first run of this
  // file reached the real Meta endpoint. Patch the module, THEN load the
  // scheduler, so nothing in this test can leave the machine.
  const db = require('../db.js');
  const whatsapp = require('../whatsapp.js');

  let sends = [];
  whatsapp.sendTemplateOrText = async (to, tmpl, vars, text) => { sends.push({ to, text }); return 'wamid.TEST'; };
  whatsapp.sendWhatsAppMessage = async () => 'wamid.TEST';
  whatsapp.sendWhatsAppTemplate = async () => 'wamid.TEST';
  whatsapp.sendReminder = async () => 'wamid.TEST';
  whatsapp.sendFollowup = async () => 'wamid.TEST';

  let scheduler = require('../scheduler.js');

  // ── MUT-NOSHOW-ALWAYS-ON: the gate is deleted. Everything below that proves
  //    the job stays dark must go red. This is the both-ways rule: a test that
  //    has never been watched failing is not yet evidence of anything.
  if (MUTANT === 'MUT-NOSHOW-ALWAYS-ON') {
    const real = scheduler.runNoShowJob;
    scheduler = Object.assign({}, scheduler, {
      runNoShowJob: async () => { delete process.env.NOSHOW_JOB_GATE_BYPASS; const saved = process.env.NOSHOW_JOB; process.env.NOSHOW_JOB = 'on'; try { return await real(); } finally { if (saved === undefined) delete process.env.NOSHOW_JOB; else process.env.NOSHOW_JOB = saved; } },
    });
    console.log('  [MUTANT] MUT-NOSHOW-ALWAYS-ON — the gate is bypassed\n');
  }

  // ── The intercepts. Every write the job could make is captured, not made.
  const stale = {
    id: 'appt-1', appointment_time: new Date(Date.now() - 2 * 3600e3),
    patient_id: 'pat-1', phone_number: '+919999999999',
  };
  let queries = [];
  db.pool.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');
    queries.push({ sql: s, params });
    if (/FROM appointments a/i.test(s) && /arrived_at IS NULL/i.test(s)) return { rows: [stale], rowCount: 1 };
    if (/COUNT\(\*\) FROM appointments/i.test(s)) return { rows: [{ count: '3' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  db.getOrCreateConversation = async () => ({ id: 'conv-1' });
  db.saveWhatsAppMessage = async () => ({});
  db.getAppointmentsForReminder = async () => [stale];
  db.getAppointmentsForFollowup = async () => [];
  db.getMissedCallsForFollowup = async () => [];

  const reset = () => { queries = []; sends = []; };
  const updates = () => queries.filter((q) => /UPDATE appointments SET status = 'no_show'/i.test(q.sql));

  // ─────────────────────────────────────────────────────────────────────────
  // [1] THE GATE ITSELF — flag unset, the job must do nothing at all.
  // ─────────────────────────────────────────────────────────────────────────
  delete process.env.NOSHOW_JOB;
  reset();
  const gatedResult = await scheduler.runNoShowJob();

  ok('flag unset → the no-show job reports itself gated', () => {
    assert.deepStrictEqual(gatedResult, { gated: true },
      `expected {gated:true}, got ${JSON.stringify(gatedResult)}`);
  });
  ok('flag unset → NO row is marked no_show', () => {
    assert.strictEqual(updates().length, 0,
      `${updates().length} appointment(s) would have been marked no_show`);
  });
  ok('flag unset → NO patient is messaged "aap nahi aa paaye"', () => {
    assert.strictEqual(sends.length, 0,
      `${sends.length} message(s) would have gone out: ${JSON.stringify(sends)}`);
  });
  ok('flag unset → the job does not even SELECT (it returns before touching the DB)', () => {
    assert.strictEqual(queries.length, 0, `${queries.length} quer(ies) issued while gated`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [2] THE JOB IS DISABLED, NOT DELETED — with the flag on it still works.
  //     A gate that quietly broke the thing it guards would be its own bug.
  // ─────────────────────────────────────────────────────────────────────────
  process.env.NOSHOW_JOB = 'on';
  reset();
  const armedResult = await scheduler.runNoShowJob();
  delete process.env.NOSHOW_JOB;

  ok('flag on → the job runs and reports what it did', () => {
    assert.strictEqual(armedResult.gated, undefined, 'still gated with the flag on');
    assert.strictEqual(armedResult.scanned, 1, `scanned=${armedResult.scanned}`);
    assert.strictEqual(armedResult.acted, 1, `acted=${armedResult.acted}`);
  });
  ok('flag on → the row IS marked and the patient IS messaged', () => {
    assert.strictEqual(updates().length, 1, 'the update did not happen with the flag on');
    assert.strictEqual(sends.length, 1, 'the message did not go out with the flag on');
    assert.match(sends[0].text, /nahi aa paaye/, 'the message body changed unexpectedly');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [3] THE OTHER THREE JOBS DEFAULT ON — the asymmetry is deliberate and is
  //     asserted, because a uniform default would silently stop the reminders
  //     of every clinic already running. That is the regression this shape of
  //     gate exists to avoid, so it gets a test rather than a comment.
  // ─────────────────────────────────────────────────────────────────────────
  for (const k of ['REMINDER_JOB', 'FOLLOWUP_JOB', 'MISSED_CALL_JOB']) delete process.env[k];
  reset();
  const rem = await scheduler.runReminderJob();
  ok('reminder job defaults ON (an unset flag must not stop a working clinic)', () => {
    assert.strictEqual(rem.gated, undefined, 'the reminder job was gated by default');
    assert.strictEqual(rem.scanned, 1, `scanned=${rem.scanned}`);
  });

  process.env.REMINDER_JOB = 'off';
  reset();
  const remOff = await scheduler.runReminderJob();
  delete process.env.REMINDER_JOB;
  ok('reminder job can be switched off per clinic', () => {
    assert.deepStrictEqual(remOff, { gated: true });
  });

  ok('the five defaults are exactly: four on, no-show off', () => {
    for (const k of ['REMINDER_JOB', 'FOLLOWUP_JOB', 'MISSED_CALL_JOB', 'NOSHOW_JOB']) delete process.env[k];
    assert.deepStrictEqual(scheduler.jobStates(),
      { reminder: true, followup: true, missedCall: true, noShow: false, outbox: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [4] THE FLAG'S VALUE IS RECORDED ON THE CALL — a dashboard claim is not
  //     evidence. runtimeConfig must report the SAME resolved values, from the
  //     same function, so "was the job armed?" is answerable months later.
  // ─────────────────────────────────────────────────────────────────────────
  ok('runtimeConfig records the resolved job states', () => {
    const { runtimeConfig } = require('../runtimeConfig.js');
    assert.deepStrictEqual(runtimeConfig().jobs, scheduler.jobStates(),
      'runtimeConfig and the scheduler disagree about which jobs are armed');
  });
  ok('runtimeConfig follows the flag rather than re-deriving it', () => {
    const { runtimeConfig } = require('../runtimeConfig.js');
    process.env.NOSHOW_JOB = 'on';
    const armed = runtimeConfig().jobs.noShow;
    delete process.env.NOSHOW_JOB;
    const unarmed = runtimeConfig().jobs.noShow;
    assert.strictEqual(armed, true, 'NOSHOW_JOB=on was not recorded as armed');
    assert.strictEqual(unarmed, false, 'the unset flag was not recorded as off');
  });
  ok('the boot line prints the job states (recorded ⇒ printed)', () => {
    const { describeRuntimeConfig } = require('../runtimeConfig.js');
    const text = describeRuntimeConfig().join('\n');
    assert.match(text, /jobs:.*noShow=/, 'the boot log does not state whether the no-show job is armed');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) {
    console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`);
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
