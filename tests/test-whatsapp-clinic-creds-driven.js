#!/usr/bin/env node
'use strict';
// EVERY WHATSAPP SENDER USES THE CLINIC'S OWN NUMBER AND TOKEN WHEN IT HAS ONE.
// Skin Essence connected WhatsApp from the desk, so its token lives in
// clinic_whatsapp_secrets. Reminders, follow-ups, reschedule offers, guard
// replies and the brain's replies used to send on the env token — which cannot
// act on that clinic's account — so patients replying on WhatsApp received
// nothing. Driven: the secrets row is stubbed, axios captured, three senders
// run; the inbound and scheduler sites are pinned by shape (the inbound path
// needs the whole brain to drive).
// Run: node tests/test-whatsapp-clinic-creds-driven.js
require('./_bootstrap');
require('./_bootstrap').unpin('TEST_MODE', 'false', 'the send path itself is under test; axios is stubbed, nothing leaves this process');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.WA_TOKEN_ENC_KEY = '0123456789abcdef'.repeat(4);
const assert = require('assert');
const crypto = require('crypto');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };
function encrypt(token) {
  const key = Buffer.from(process.env.WA_TOKEN_ENC_KEY, 'hex'); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}
(async () => {
  console.log('\nWHATSAPP — the clinic\'s own credentials on every sender — driven\n');
  const axios = require('axios'); const posts = [];
  axios.post = async (url, body, opts) => { posts.push({ url, auth: opts && opts.headers && opts.headers.Authorization, to: body.to, type: body.type || 'template' }); return { status: 200, data: { messages: [{ id: 'wamid.test' }] } }; };
  const db = require('../db');
  db.pool.query = async (sql) => (/clinic_whatsapp_secrets/.test(String(sql)) ? { rows: [{ phone_number_id: 'PN-CLINIC', access_token_enc: encrypt('TOKEN-CLINIC') }], rowCount: 1 } : { rows: [], rowCount: 0 });
  db.getOrCreateConversation = async () => ({ id: 'conv-1', language: 'gu-IN' });
  for (const k of ['updateConversationState', 'saveWhatsAppMessage', 'markReminderSent', 'markFollowupSent']) db[k] = async () => 1;
  db.upsertPatient = async () => 'p1';
  const config = require('../config');
  const envToken = config.whatsapp.accessToken; const envPn = config.whatsapp.phoneNumberId;
  const w = require('../whatsapp');
  await w.sendReminder({ id: 'a1', phone_number: '919876543210', patient_id: 'p1', scheduled_at: new Date(Date.now() + 3600e3).toISOString(), patient_name: 'Reena', clinicId: 'c1' });
  await w.sendFollowup({ id: 'a1', phone_number: '919876543210', patient_id: 'p1', patient_name: 'Reena', clinicId: 'c1' });
  await w.sendRescheduleOptions({ phone: '919876543210', name: 'Reena', clinicId: 'c1' }, [new Date(Date.now() + 7200e3).toISOString()]);
  ok('reminder, follow-up and reschedule offer all posted to the CLINIC number with the CLINIC token', () => {
    assert.ok(posts.length >= 3, `${posts.length} post(s)`);
    for (const p of posts) { assert.ok(p.url.includes('/PN-CLINIC/messages'), p.url); assert.strictEqual(p.auth, 'Bearer TOKEN-CLINIC'); }
  });
  ok('none of them used the env token or number', () => { for (const p of posts) { if (envToken) assert.ok(!p.auth.includes(envToken)); if (envPn) assert.ok(!p.url.includes(`/${envPn}/`)); } });
  ok('inbound replies and the no-show / missed-call jobs pass the clinic credentials too (shape)', () => {
    const fs = require('fs'), path = require('path');
    const wa = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8'); const sch = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    assert.match(wa, /sendWhatsAppMessage\(cleanPhone, hit\.reply, creds\)/); assert.match(wa, /sendWhatsAppMessage\(cleanPhone, result\.text, creds\)/);
    assert.match(sch, /noShowTmpl, \{\}, msg, creds,/); assert.match(sch, /missedTmpl, \{\}, msg, creds,/);
  });
  console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
})();
