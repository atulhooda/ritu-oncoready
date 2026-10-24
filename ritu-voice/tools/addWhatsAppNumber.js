#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// addWhatsAppNumber.js — put a clinic's number on the Cloud API, by API.
//
// WHY THIS EXISTS. Meta's Embedded Signup popup is the documented way to
// onboard a number, and on 2026-09-11 it stopped reporting anything back for
// this app: the dialog opened, rendered its screens, and posted no
// WA_EMBEDDED_SIGNUP message at all — measured on both the coexistence and the
// standard branch, with the exact `extras` object logged. Nothing that flow
// hands back (waba_id, phone_number_id, the auth code) ever arrived, so no
// onboarding could complete for ANY number, however eligible. Hours went into
// chasing the number before the instrument proved it was never the variable.
//
// Everything that popup does is a Graph call we can make ourselves with the
// system-user token, which is the real dividend of Tech Provider status:
//   add → request_code → verify_code → register(pin) → subscribe → override
//
// PREREQUISITE: the number must NOT be registered on WhatsApp. Meta refuses a
// live number here, exactly as the popup does. Coexistence is the only path
// that keeps the WhatsApp Business app on the number, and it is unavailable
// while the flow above is broken.
//
//   node tools/addWhatsAppNumber.js add --number 91XXXXXXXXXX --name "Clinic Name" [--voice]
//   node tools/addWhatsAppNumber.js verify --code 123456
//   node tools/addWhatsAppNumber.js finish
//
// Env: META_ACCESS_TOKEN, META_WEBHOOK_VERIFY_TOKEN, WA_ONBOARD_WABA_ID
//      (or --waba), PUBLIC_WEBHOOK_URL (or RAILWAY_PUBLIC_DOMAIN).
// State between steps lives in a JSON file (--state, default a temp file), so
// the three commands can run minutes apart while someone reads the code.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const V = (process.env.META_API_VERSION || 'v23.0').trim();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const need = (v, what) => { if (!v) { console.error(`✗ ${what} is not set`); process.exit(2); } return v; };

const STATE = arg('--state', path.join(os.tmpdir(), 'wa-onboard-state.json'));
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (o) => fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...o }, null, 1));
const mask = (s) => String(s || '').replace(/\d(?=\d{4})/g, '•');

function call(method, p, body) {
  const token = need(process.env.META_ACCESS_TOKEN, 'META_ACCESS_TOKEN');
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      method, hostname: 'graph.facebook.com', path: `/${V}/${p}`,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (rs) => {
      let b = ''; rs.on('data', (d) => { b += d; });
      rs.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b.slice(0, 300) }; }
        if (rs.statusCode >= 400 || j.error) {
          return rej(new Error(`${p} → ${rs.statusCode} ${JSON.stringify(j.error || j).slice(0, 400)}`));
        }
        res(j);
      });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const waba = () => need(arg('--waba', process.env.WA_ONBOARD_WABA_ID), 'WA_ONBOARD_WABA_ID (or --waba)');
const callbackUrl = () => (process.env.PUBLIC_WEBHOOK_URL || '').trim()
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/whatsapp/incoming` : '');

async function add() {
  const full = String(arg('--number', '')).replace(/\D/g, '');
  const name = arg('--name', '');
  if (!/^\d{10,15}$/.test(full)) { console.error('✗ --number must be full international digits, e.g. 919825971010'); process.exit(2); }
  if (!name) { console.error('✗ --name is required — it is the sender name patients see'); process.exit(2); }
  const cc = full.startsWith('91') ? '91' : full.slice(0, 2);
  const phone = full.slice(cc.length);
  console.log(`Adding ${mask(full)} as "${name}" to WABA …${String(waba()).slice(-4)}`);
  const r = await call('POST', `${waba()}/phone_numbers`, { cc, phone_number: phone, verified_name: name });
  saveState({ phoneNumberId: r.id, full, name, waba: waba() });
  console.log(`  ✓ phone_number_id ${r.id}`);
  const method = has('--voice') ? 'VOICE' : 'SMS';
  await call('POST', `${r.id}/request_code`, { code_method: method, language: 'en' });
  console.log(`  ✓ code requested by ${method}. Read it on the phone, then:`);
  console.log('     node tools/addWhatsAppNumber.js verify --code XXXXXX');
}

async function verify() {
  const st = readState();
  if (!st.phoneNumberId) { console.error('✗ run "add" first'); process.exit(2); }
  const code = String(arg('--code', '')).replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) { console.error('✗ --code must be 6 digits'); process.exit(2); }
  await call('POST', `${st.phoneNumberId}/verify_code`, { code });
  console.log('  ✓ number verified');
  // Meta asks for this PIN again on any future re-registration or migration, so
  // a value nobody recorded is a trap. Prefer a deliberate one from the env.
  const envPin = (process.env.WA_REGISTER_PIN || '').trim();
  const pin = /^\d{6}$/.test(envPin) ? envPin : String(require('crypto').randomInt(100000, 1000000));
  await call('POST', `${st.phoneNumberId}/register`, { messaging_product: 'whatsapp', pin });
  saveState({ pin, registered: true });
  console.log(`  ✓ registered for Cloud API · two-step PIN ${pin}  ← RECORD THIS`);
  console.log('     node tools/addWhatsAppNumber.js finish');
}

async function finish() {
  const st = readState();
  if (!st.registered) { console.error('✗ run "verify" first'); process.exit(2); }
  const W = st.waba || waba();
  await call('POST', `${W}/subscribed_apps`, {});
  console.log('  ✓ app subscribed to this WhatsApp account');
  const want = callbackUrl();
  if (!want) {
    console.warn('  ⚠ no PUBLIC_WEBHOOK_URL / RAILWAY_PUBLIC_DOMAIN — webhooks stay on the APP-LEVEL url (the demo server)');
  } else {
    // Order matters: a body-less subscribe wipes any override, so this runs after.
    await call('POST', `${W}/subscribed_apps`, {
      override_callback_uri: want,
      verify_token: need(process.env.META_WEBHOOK_VERIFY_TOKEN, 'META_WEBHOOK_VERIFY_TOKEN'),
    });
    const back = await call('GET', `${W}/subscribed_apps`);
    const got = (back.data || []).map((a) => a.override_callback_uri).filter(Boolean)[0] || null;
    console.log(`  ${got === want ? '✓' : '✗'} webhooks → ${got || 'APP-LEVEL url'}`);
  }
  const n = await call('GET', `${st.phoneNumberId}?fields=display_phone_number,verified_name,status,platform_type,quality_rating,health_status`);
  console.log(`  number ${mask(n.display_phone_number)} "${n.verified_name}" ${n.status} ${n.platform_type} health=${n.health_status ? n.health_status.can_send_message : '—'}`);
  console.log(`\n  SET ON THE VOICE SERVER:  META_PHONE_NUMBER_ID=${st.phoneNumberId}`);
  console.log('  THEN TEMPLATES:           npm run wa:templates -- create --lang gu,en --yes');
}

const cmd = process.argv[2];
const run = cmd === 'add' ? add : cmd === 'verify' ? verify : cmd === 'finish' ? finish : null;
if (!run) {
  console.log('usage: add --number 91XXXXXXXXXX --name "Clinic Name" [--voice] | verify --code XXXXXX | finish');
  process.exit(1);
}
run().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
