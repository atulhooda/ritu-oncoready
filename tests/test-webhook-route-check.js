#!/usr/bin/env node
'use strict';
// Where do this clinic's WhatsApp replies go — and does the server KNOW?
//
// One Meta app, one app-level callback URL (the demo's). A second clinic
// connected through the desk's coexistence flow gets our app subscribed to its
// WABA with NO override, so its patients' replies and delivery receipts land on
// the demo server. Nothing on the clinic's own server ever sees a message, and
// the desk says "Connected". checkWhatsAppWebhookRoute reads the truth from
// Meta (WABA override with the clinic token, else the app-level URL with the
// app token) and compares it with where THIS server lives.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-ROUTE-IGNORES-OVERRIDE — the WABA override is ignored, only the app-level URL counts
//   MUTANT=MUT-ROUTE-ALWAYS-OK        — the verdict never fails
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('drives the route check against stubbed Graph reads: RAILWAY_PUBLIC_DOMAIN, PUBLIC_WEBHOOK_URL, TOKEN_HEALTH_CHECK, WA_TOKEN_ENC_KEY, META_APP_SECRET, N8N_WEBHOOK_URL are the inputs under test');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const crypto = require('crypto');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

// ── inputs ───────────────────────────────────────────────────────────────────
const KEY = crypto.randomBytes(32).toString('hex');
process.env.WA_TOKEN_ENC_KEY = KEY;
process.env.META_APP_SECRET = 'app-secret-for-test';
process.env.N8N_WEBHOOK_URL = '';
delete process.env.PUBLIC_WEBHOOK_URL;
process.env.RAILWAY_PUBLIC_DOMAIN = 'skin-essence.up.railway.app';
const HERE = 'https://skin-essence.up.railway.app/whatsapp/incoming';
const DEMO = 'https://demo.up.railway.app/whatsapp/incoming';
function encrypt(text) {   // the desk's lib/crypto.ts format: v1:iv:tag:ct (hex)
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

// ── stubs BEFORE requires (patch-before-require) ─────────────────────────────
const axios = require('axios');
const world = { override: null, appLevel: DEMO, apps: 1, connected: true, subscribedAppsFails: false, debugTokenFails: false, subscriptionsFail: false };
const gets = [];
axios.get = async (url, opts = {}) => {
  gets.push(url);
  if (url.endsWith('/debug_token')) { if (world.debugTokenFails) { const e = new Error('debug_token refused'); e.response = { data: { error: { message: 'Invalid OAuth access token' } } }; throw e; } return { data: { data: { app_id: 'APP1', is_valid: true } } }; }
  if (url.endsWith('/subscribed_apps')) {
    if (world.subscribedAppsFails) { const e = new Error('boom'); e.response = { data: { error: { message: 'no access' } } }; throw e; }
    const data = world.apps ? [{ whatsapp_business_api_data: { id: 'APP1', name: 'Engageo Crib' }, override_callback_uri: world.override || undefined }] : [];
    return { data: { data } };
  }
  if (url.endsWith('/APP1/subscriptions')) {
    if (world.subscriptionsFail) { const e = new Error('nope'); e.response = { data: { error: { message: '(#100) app token rejected' } } }; throw e; }
    assert.strictEqual((opts.params || {}).access_token, 'APP1|app-secret-for-test', 'app-level read must use the app token');
    return { data: { data: [{ object: 'whatsapp_business_account', callback_url: world.appLevel, active: true }] } };
  }
  throw new Error('unexpected GET ' + url);
};
axios.post = async () => ({ data: {} });
const db = require('../db.js');
db.pool.query = async (sql) => {
  if (/FROM clinics WHERE id/.test(sql)) return { rows: [{ waba_id: world.connected ? 'WABA1' : null, whatsapp_status: world.connected ? 'connected' : null }] };
  if (/clinic_whatsapp_secrets/.test(sql)) return { rows: world.connected ? [{ phone_number_id: 'PN1', access_token_enc: encrypt('clinic-token') }] : [] };
  return { rows: [] };
};
const wa = require('../whatsapp.js');
if (MUTANT === 'MUT-ROUTE-IGNORES-OVERRIDE') wa.effectiveWebhookRoute = ({ appLevel }) => appLevel || null;
if (MUTANT === 'MUT-ROUTE-ALWAYS-OK') wa.webhookRouteVerdict = () => true;
const alerts = []; const realErr = console.error;
console.error = (...a) => { const s = a.join(' '); if (s.includes('[WA-TOKEN-ALERT]')) alerts.push(s); else realErr(...a); };
const run = async (patch) => { Object.assign(world, { override: null, appLevel: DEMO, apps: 1, connected: true, subscribedAppsFails: false, debugTokenFails: false, subscriptionsFail: false }, patch); alerts.length = 0; gets.length = 0; return wa.checkWhatsAppWebhookRoute({ clinicId: 'c1' }); };

(async () => {
  console.log('\nWEBHOOK ROUTE CHECK — does this server know where its replies go?\n');
  console.log('[1] the silo case: WABA override → this server');
  await ok('override == here → ok, no alert', async () => { const r = await run({ override: HERE }); assert.strictEqual(r.ok, true); assert.strictEqual(r.effective, HERE); assert.strictEqual(alerts.length, 0); });
  await ok('with an override the app-level URL is not even read', async () => { await run({ override: HERE }); assert.ok(!gets.some((u) => u.endsWith('/subscriptions')), 'read the app-level URL needlessly'); });
  await ok('override points at the DEMO → ✗ + alert naming both URLs', async () => { const r = await run({ override: DEMO }); assert.strictEqual(r.ok, false); assert.strictEqual(alerts.length, 1); assert.ok(alerts[0].includes(DEMO) && alerts[0].includes(HERE), alerts[0]); });

  console.log('\n[2] the trap: no override, app-level URL is the demo (the state a fresh desk connect leaves behind)');
  await ok('no override + app-level demo → ✗ + alert says "APP-LEVEL"', async () => { const r = await run({ override: null, appLevel: DEMO }); assert.strictEqual(r.ok, false); assert.strictEqual(r.effective, DEMO); assert.ok(alerts[0] && /APP-LEVEL/.test(alerts[0]), alerts[0]); assert.ok(/wa:webhook/.test(alerts[0]), 'alert must name the repair'); });
  await ok('the demo itself: no override, app-level == here → ok', async () => { process.env.RAILWAY_PUBLIC_DOMAIN = 'demo.up.railway.app'; const r = await run({ override: null, appLevel: DEMO }); process.env.RAILWAY_PUBLIC_DOMAIN = 'skin-essence.up.railway.app'; assert.strictEqual(r.ok, true); assert.strictEqual(alerts.length, 0); });
  await ok('our app not subscribed at all → ✗ + alert', async () => { const r = await run({ apps: 0 }); assert.strictEqual(r.ok, false); assert.strictEqual(r.apps, 0); assert.ok(/NOT subscribed/.test(alerts[0] || ''), alerts[0]); });

  await ok('the app id comes from the subscription entry — a refused debug_token changes nothing (the 2026-09-09 demo false alert)', async () => { const r = await run({ override: null, appLevel: DEMO, debugTokenFails: true }); process.env.RAILWAY_PUBLIC_DOMAIN = 'skin-essence.up.railway.app'; assert.strictEqual(r.effective, DEMO, 'app-level URL was not read'); assert.ok(!gets.some((u) => u.endsWith('/debug_token')), 'debug_token consulted for a single subscribed app'); });
  await ok('an unreadable app-level URL names WHY in the alert', async () => { const r = await run({ override: null, subscriptionsFail: true }); assert.strictEqual(r.ok, false); assert.ok(r.why.some((s) => /app subscriptions: .*app token rejected/.test(s)), JSON.stringify(r.why)); assert.ok(/app token rejected/.test(alerts[0] || ''), alerts[0]); });

  console.log('\n[3] where "expected" comes from');
  await ok('PUBLIC_WEBHOOK_URL beats RAILWAY_PUBLIC_DOMAIN', async () => { process.env.PUBLIC_WEBHOOK_URL = 'https://ritu.skinessence.in/whatsapp/incoming'; const r = await run({ override: 'https://ritu.skinessence.in/whatsapp/incoming' }); delete process.env.PUBLIC_WEBHOOK_URL; assert.strictEqual(r.ok, true); });
  await ok('neither set → skipped, nothing read from Meta', async () => { const d = process.env.RAILWAY_PUBLIC_DOMAIN; delete process.env.RAILWAY_PUBLIC_DOMAIN; const r = await run({}); process.env.RAILWAY_PUBLIC_DOMAIN = d; assert.strictEqual(r.skipped, 'no-expected-url'); assert.strictEqual(gets.length, 0); });

  console.log('\n[4] nothing to check / cannot check');
  await ok('clinic not connected via the desk → skipped, no alert', async () => { const r = await run({ connected: false }); assert.strictEqual(r.skipped, 'not-connected'); assert.strictEqual(alerts.length, 0); });
  await ok('subscribed_apps unreadable → alert, error returned', async () => { const r = await run({ subscribedAppsFails: true }); assert.strictEqual(r.error, 'subscribed_apps'); assert.strictEqual(alerts.length, 1); });

  console.log('\n[5] the scheduler gate and the boot hook');
  const sched = require('../scheduler.js');
  await ok('TOKEN_HEALTH_CHECK off → gated, Meta never called', async () => { process.env.TOKEN_HEALTH_CHECK = 'off'; gets.length = 0; const r = await sched.runWebhookRouteCheck(); assert.deepStrictEqual(r, { gated: true }); assert.strictEqual(gets.length, 0); });
  await ok('TOKEN_HEALTH_CHECK=on → the real check runs', async () => { process.env.TOKEN_HEALTH_CHECK = 'on'; Object.assign(world, { override: HERE, connected: true, subscribedAppsFails: false }); const r = await sched.runWebhookRouteCheck(); assert.strictEqual(r.ok, true); });
  await ok('index.js schedules it once at boot (source, alongside the driven scheduler above)', async () => { const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8'); assert.ok(/runWebhookRouteCheck\(\)/.test(src)); });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
