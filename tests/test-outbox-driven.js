#!/usr/bin/env node
'use strict';
// THE OUTBOX SENDS EACH ROW ONCE, MARKS IT ONCE, AND SAYS WHY WHEN IT CANNOT.
//
// outbound_messages (migration 020) holds rows the DESK queued — a doctor's
// day off, a staff callback alert. drainOutbox claims each row per attempt
// (UPDATE … WHERE attempts = N), sends through the one WhatsApp sender, marks
// sent (wamid + ledger row) or reschedules/fails with the reason. Driven with
// an in-memory pool and a stub sender; no network.
//
// Run:            node tests/test-outbox-driven.js
// Prove it fails: MUTANT=MUT-OUTBOX-NO-MARK node tests/test-outbox-driven.js
//                 (the 'sent' update becomes a no-op → the row is sent again next tick)
require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.CLINIC_ID = process.env.CLINIC_ID || '5e55e11c-0a1d-4b7e-9c3f-5c1de55e0001';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const db = require('../db');
const config = require('../config');
const outbox = require('../outbox');

// ── an in-memory outbound_messages ──────────────────────────────────────────
function makePool(rows, { claimFails = false, missing = false } = {}) {
  const log = [];
  return {
    rows, log,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      log.push({ s, params });
      if (missing) { const e = new Error('relation "outbound_messages" does not exist'); e.code = '42P01'; throw e; }
      if (/^SELECT id, kind/.test(s)) {
        const due = rows.filter((r) => r.status === 'queued' && r.scheduled_at <= Date.now()).slice(0, params[1]);
        return { rows: due.map((r) => ({ ...r })), rowCount: due.length };
      }
      if (/SET attempts = attempts \+ 1/.test(s)) {
        const r = rows.find((x) => x.id === params[0] && x.status === 'queued' && x.attempts === params[1]);
        if (!r || claimFails) return { rows: [], rowCount: 0 };
        r.attempts++;
        return { rows: [{ attempts: r.attempts }], rowCount: 1 };
      }
      if (/SET status = 'sent'/.test(s)) {
        if (MUTANT === 'MUT-OUTBOX-NO-MARK') return { rows: [], rowCount: 1 };
        const r = rows.find((x) => x.id === params[0]); r.status = 'sent'; r.wamid = params[1]; r.last_error = null;
        return { rows: [], rowCount: 1 };
      }
      if (/SET status = 'failed'/.test(s)) { const r = rows.find((x) => x.id === params[0]); r.status = 'failed'; r.last_error = params[1]; return { rows: [], rowCount: 1 }; }
      if (/SET last_error = \$2, scheduled_at/.test(s)) { const r = rows.find((x) => x.id === params[0]); r.last_error = params[1]; r.scheduled_at = Date.now() + Number(params[2]) * 60000; return { rows: [], rowCount: 1 }; }
      throw new Error('unexpected SQL: ' + s.slice(0, 80));
    },
  };
}
const row = (id, kind, extra = {}) => ({
  id, kind, to_phone: '919876543210', patient_id: 'p1', appointment_id: 'a1', callback_id: null,
  variables: { '1': 'Reena', '2': 'Dr. Daksha Patel', '3': 'Wed, 16 Sept, 5:30 pm' }, language: 'gu-IN',
  status: 'queued', attempts: 0, scheduled_at: 0, ...extra,
});
const ledger = [];
db.getOrCreateConversation = async (phone, patientId) => ({ id: 'conv-' + phone, patientId });
db.saveWhatsAppMessage = async (convId, patientId, direction, body, type, sid) => { ledger.push({ convId, direction, body, type, sid }); return 1; };
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

(async () => {
  console.log('\nOUTBOX — driven\n');

  // 1. a queued doctor_leave row is sent once, marked once, and lands in the ledger
  {
    const pool = makePool([row(1, 'doctor_leave')]);
    const sends = [];
    const send = async (to, tmpl, vars, text, creds, lang) => { sends.push({ to, tmpl, vars, text, lang }); return 'wamid.1'; };
    const r1 = await outbox.drainOutbox({ pool, send, creds: null, log: quiet });
    ok('first tick: sent once with the leave template and the three variables', () => {
      assert.deepStrictEqual({ scanned: r1.scanned, sent: r1.sent, failed: r1.failed }, { scanned: 1, sent: 1, failed: 0 });
      assert.strictEqual(sends.length, 1);
      assert.strictEqual(sends[0].tmpl, config.whatsapp.templates.leave);
      assert.deepStrictEqual(sends[0].vars, row(1, 'x').variables);
      assert.strictEqual(sends[0].lang, 'gu-IN');
      assert.ok(/Reena/.test(sends[0].text) && /Dr\. Daksha Patel/.test(sends[0].text) && /Wed, 16 Sept/.test(sends[0].text), 'plain-text twin carries the variables');
      assert.ok(/[઀-૿]/.test(sends[0].text), 'a gu-IN recipient gets Gujarati text');
    });
    ok('the row is marked sent with the message id; the ledger has one doctor_leave row', () => {
      assert.strictEqual(pool.rows[0].status, 'sent'); assert.strictEqual(pool.rows[0].wamid, 'wamid.1'); assert.strictEqual(pool.rows[0].attempts, 1);
      assert.strictEqual(ledger.length, 1); assert.strictEqual(ledger[0].type, 'doctor_leave'); assert.strictEqual(ledger[0].sid, 'wamid.1');
    });
    const r2 = await outbox.drainOutbox({ pool, send, creds: null, log: quiet });
    ok('second tick: nothing is sent again', () => { assert.strictEqual(r2.sent, 0); assert.strictEqual(sends.length, 1); });
  }

  // 2. no message id → retried on a growing delay, then failed with the reason
  {
    const pool = makePool([row(2, 'staff_callback_alert', { language: null })]);
    const send = async () => null;
    await outbox.drainOutbox({ pool, send, creds: null, log: quiet });
    ok('a send with no message id stays queued, attempt 1, rescheduled 10 min out, reason recorded', () => {
      const r = pool.rows[0];
      assert.strictEqual(r.status, 'queued'); assert.strictEqual(r.attempts, 1);
      assert.ok(r.scheduled_at > Date.now() + 9 * 60000, 'rescheduled');
      assert.match(r.last_error, /no message id/);
    });
    pool.rows[0].scheduled_at = 0; await outbox.drainOutbox({ pool, send, creds: null, log: quiet });
    pool.rows[0].scheduled_at = 0; const r3 = await outbox.drainOutbox({ pool, send, creds: null, log: quiet });
    ok(`after ${outbox.MAX_ATTEMPTS} attempts the row is failed, not retried forever`, () => {
      assert.strictEqual(pool.rows[0].status, 'failed'); assert.strictEqual(pool.rows[0].attempts, outbox.MAX_ATTEMPTS); assert.strictEqual(r3.failed, 1);
    });
  }

  // 3. a thrown send is a failure with its message, never an unhandled rejection
  {
    const pool = makePool([row(3, 'doctor_leave')]);
    await outbox.drainOutbox({ pool, send: async () => { throw new Error('token expired (190)'); }, creds: null, log: quiet });
    ok('a throwing sender records its message and reschedules', () => { assert.strictEqual(pool.rows[0].status, 'queued'); assert.match(pool.rows[0].last_error, /190/); });
  }

  // 4. the claim: a row someone else advanced is skipped — no send
  {
    const pool = makePool([row(4, 'doctor_leave')], { claimFails: true });
    let sends = 0;
    await outbox.drainOutbox({ pool, send: async () => { sends++; return 'w'; }, creds: null, log: quiet });
    ok('an unclaimable row (another worker got it) is not sent', () => assert.strictEqual(sends, 0));
  }

  // 5. unknown kind → failed with the reason, never sent
  {
    const pool = makePool([row(5, 'marketing_blast')]);
    let sends = 0;
    await outbox.drainOutbox({ pool, send: async () => { sends++; return 'w'; }, creds: null, log: quiet });
    ok('an unknown kind is failed, not sent', () => { assert.strictEqual(sends, 0); assert.strictEqual(pool.rows[0].status, 'failed'); assert.match(pool.rows[0].last_error, /unknown kind/); });
  }

  // 6. migration 020 not applied → reported, not thrown
  {
    const pool = makePool([], { missing: true });
    const r = await outbox.drainOutbox({ pool, send: async () => 'w', creds: null, log: quiet });
    ok('a database without outbound_messages reports missing:true and sends nothing', () => assert.deepStrictEqual(r, { scanned: 0, sent: 0, failed: 0, missing: true }));
  }

  // 7. the plain-text twin follows the recipient's language and the clinic's name rule
  ok('fallbackText: gu-IN → Gujarati with the local-script name; hi-IN → Hindi with the Latin name; unknown → clinic default', () => {
    const vars = { '1': 'Reena', '2': 'Dr. Daksha Patel', '3': 'Wed, 16 Sept, 5:30 pm' };
    const gu = outbox.fallbackText('doctor_leave', vars, 'gu-IN');
    const hi = outbox.fallbackText('doctor_leave', vars, 'hi-IN');
    const xx = outbox.fallbackText('doctor_leave', vars, 'xx-XX');
    assert.ok(/[઀-૿]/.test(gu) && /Reena/.test(gu));
    assert.ok(/[ऀ-ॿ]/.test(hi) && /Reena/.test(hi));
    assert.ok(xx.length > 20 && /Reena/.test(xx));
    assert.ok(!/\{\{|\{clinic\}/.test(gu + hi + xx), 'no placeholder left');
  });

  // 8. queueStaffAlert writes one row per staff phone from the clinics row, and survives a missing table
  {
    const seen = [];
    const q = { query: async (sql, params) => { seen.push({ sql: String(sql).replace(/\s+/g, ' '), params }); return { rowCount: 2, rows: [] }; } };
    const n = await db.queueStaffAlert({ clinicId: 'c1', callbackId: 'cb-9', patientName: ' Reena ', phone: '+919876543210', reason: 'wants Thursday' }, q);
    ok('queueStaffAlert: INSERT … SELECT unnest(staff_alert_phones) with kind staff_callback_alert and {1,2,3}', () => {
      assert.strictEqual(n, 2);
      assert.match(seen[0].sql, /INSERT INTO outbound_messages/);
      assert.match(seen[0].sql, /unnest\(c\.staff_alert_phones\)/);
      assert.match(seen[0].sql, /'staff_callback_alert'/);
      assert.deepStrictEqual(JSON.parse(seen[0].params[2]), { '1': 'Reena', '2': '+919876543210', '3': 'wants Thursday' });
      assert.strictEqual(seen[0].params[1], 'cb-9');
    });
    const qMissing = { query: async () => { const e = new Error('no such table'); e.code = '42P01'; throw e; } };
    const m = await db.queueStaffAlert({ clinicId: 'c1', callbackId: 'cb-9', patientName: 'R', phone: 'x', reason: 'y' }, qMissing);
    ok('a database without migration 020 queues 0 and never throws into the callback', () => assert.strictEqual(m, 0));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})();
