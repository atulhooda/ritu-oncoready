#!/usr/bin/env node
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('drives the real Meta send path with axios stubbed; TEST_MODE must be off for metaPost to reach the stub');
// A template in the wrong language still delivers; plain text outside a 24h
// window never does. MEASURED 2026-09-07: the demo WABA has the confirmation
// template in "en" only; the caller's language went straight to the request,
// 132001 came back, the text fallback went out, Meta failed it (131047), and
// every record said "sent". This drives sendTemplateOrText through a stubbed
// Meta and the status webhook through the real handler.
process.env.SKIP_BOOT_AUDIO = '1';
process.env.TEST_MODE = 'false';
process.env.META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'test-token';
process.env.META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '123456';
process.env.META_APP_SECRET = 'ladder-test-secret';
const assert = require('assert');
const crypto = require('crypto');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };

// ── stub Meta BEFORE requiring whatsapp.js (it binds the axios module object; post is looked up per call) ──
const axios = require('axios');
const posts = [];
let live = new Set(['appointment_confirmation|en']);     // what the WABA "has"
axios.post = async (url, body) => {
  posts.push(body);
  if (body.type === 'template') {
    const key = `${body.template.name}|${body.template.language.code}`;
    if (!live.has(key)) { const e = new Error('132001'); e.response = { data: { error: { code: 132001, message: '(#132001) Template name does not exist in the translation' } } }; throw e; }
    return { status: 200, data: { messages: [{ id: `wamid.T.${body.template.language.code}.${posts.length}` }] } };
  }
  return { status: 200, data: { messages: [{ id: `wamid.TEXT.${posts.length}` }] } };
};
const db = require('../db.js');
const queries = [];
db.pool.query = async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; };
const wa = require('../whatsapp.js');
const config = require('../config.js');
const tpl = (b) => (b.type === 'template' ? `${b.template.name}@${b.template.language.code}` : 'TEXT');

(async () => {
  console.log('\nTEMPLATE LANGUAGE LADDER — the wrong-language template beats undeliverable text\n');
  console.log(`  default template language in this profile: ${config.whatsapp.defaultTemplateLanguage}`);

  console.log('\n[1] a Marathi caller: mr dead → default dead → en LIVE → sent as a template');
  posts.length = 0;
  const sid1 = await wa.sendTemplateOrText('919999900001', 'appointment_confirmation', { 1: 'सतीश', 2: 'Mon 5 pm' }, 'plain text', null, 'mr-IN');
  await ok('a template sid came back', async () => assert.match(String(sid1), /^wamid\.T\.en\./));
  await ok('no plain text was sent', async () => assert.ok(!posts.some((b) => b.type === 'text'), posts.map(tpl).join(' → ')));
  await ok('the ladder was walked in order: mr, then the default, then en', async () => {
    const langs = posts.map((b) => b.template.language.code);
    assert.strictEqual(langs[0], 'mr'); assert.strictEqual(langs[langs.length - 1], 'en');
    assert.ok(langs.includes(config.whatsapp.defaultTemplateLanguage), `default not tried: ${langs.join(',')}`);
  });

  console.log('\n[2] the next Marathi caller goes straight to the live language — dead languages are remembered');
  posts.length = 0;
  const sid2 = await wa.sendTemplateOrText('919999900002', 'appointment_confirmation', { 1: 'x', 2: 'y' }, 'plain text', null, 'mr-IN');
  await ok('one request, in en', async () => { assert.strictEqual(posts.length, 1); assert.strictEqual(tpl(posts[0]), 'appointment_confirmation@en'); assert.ok(sid2); });

  console.log('\n[3] a template the WABA has in NO language: plain text, as the last resort');
  posts.length = 0;
  const sid3 = await wa.sendTemplateOrText('919999900003', 'appointment_reminder', { 1: 'x', 2: 'y' }, 'reminder text', null, 'hi-IN');
  await ok('every ladder language was tried, then text', async () => { assert.strictEqual(posts[posts.length - 1].type, 'text'); assert.ok(posts.filter((b) => b.type === 'template').length >= 2, posts.map(tpl).join(' → ')); assert.match(String(sid3), /^wamid\.TEXT/); });
  await ok('the failed languages were recorded dead, so the next reminder skips them', async () => { posts.length = 0; await wa.sendTemplateOrText('919999900004', 'appointment_reminder', {}, 't', null, 'hi-IN'); assert.strictEqual(posts.length, 1); assert.strictEqual(posts[0].type, 'text'); });

  console.log('\n[4] a timeout is NOT "dead": no fallthrough to text, no language marked');
  posts.length = 0;
  const realPost = axios.post;
  axios.post = async (url, body) => { posts.push(body); const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; };
  const sid4 = await wa.sendTemplateOrText('919999900005', 'appointment_confirmation', {}, 'plain', null, 'en-IN');
  axios.post = realPost;
  await ok('returns null, one attempt, no text', async () => { assert.strictEqual(sid4, null); assert.strictEqual(posts.length, 1); assert.strictEqual(posts[0].type, 'template'); });

  console.log('\n[5] the status webhook writes Meta\'s verdict onto the outbound row');
  {
    const body = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: {}, statuses: [
      { id: 'wamid.S1', status: 'failed', timestamp: '1', recipient_id: '919999900001', errors: [{ code: 131047, title: 'Re-engagement message' }] },
      { id: 'wamid.S2', status: 'delivered', timestamp: '2', recipient_id: '919999900002' },
    ] } }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
    const req = { rawBody: raw, body, get: (h) => (h.toLowerCase() === 'x-hub-signature-256' ? sig : undefined) };
    let status = null; const res = { sendStatus: (s) => { status = s; return res; }, status: (s) => { status = s; return res; }, send: () => res, type: () => res, json: () => res };
    queries.length = 0;
    await wa.handleIncomingWhatsApp(req, res);
    await new Promise((r) => setTimeout(r, 50));
    const upd = queries.filter((q) => /UPDATE whatsapp_messages SET delivery_status/.test(q.sql));
    await ok('accepted (200) and both verdicts written', async () => { assert.strictEqual(status, 200); assert.strictEqual(upd.length, 2); });
    await ok('the failed one carries 131047', async () => { const f = upd.find((q) => q.params[2] === 'wamid.S1'); assert.ok(f, 'no row for S1'); assert.strictEqual(f.params[0], 'failed'); assert.strictEqual(f.params[1], 131047); });
    await ok('the delivered one carries no error', async () => { const d = upd.find((q) => q.params[2] === 'wamid.S2'); assert.strictEqual(d.params[0], 'delivered'); assert.strictEqual(d.params[1], null); });
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
