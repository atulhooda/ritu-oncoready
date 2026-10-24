#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// webhookRoute.js — where does Meta deliver THIS clinic's WhatsApp replies?
//
// Reads the WABA override (clinic token) and the app-level callback (app
// token) and compares with where this server lives. Read-only; prints the
// verdict and exits 0 (matches) / 3 (mismatch) / 4 (nothing to check).
//
// Run inside the container (no parentheses or pipes on that command line):
//   railway ssh -s engageo-server-v2 -- npm run wa:route
// Repair from the desk container:
//   railway ssh -s ritu-desk -- npm run wa:webhook -- --set
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
process.env.SKIP_BOOT_AUDIO = '1';
const { checkWhatsAppWebhookRoute } = require('../whatsapp');
const db = require('../db');

(async () => {
  const r = await checkWhatsAppWebhookRoute();
  console.log(JSON.stringify(r, null, 2));
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(r.ok === true ? 0 : r.skipped ? 4 : 3);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
