'use strict';
require('dotenv').config();
process.env.SKIP_BOOT_AUDIO = '1';
// ═══════════════════════════════════════════════════════════════════════════
// metaTemplates.js — the template set every clinic's WhatsApp account needs
//
// Templates belong to the WABA. A clinic that has just connected through the
// desk has NONE, and every message the server starts (confirmation, reminder,
// follow-up, no-show and missed-call recovery, a doctor's day off, a callback
// alert to staff) falls to plain text, which Meta refuses outside a 24h window
// (131047) while still returning a message id. MEASURED 2026-09-14: the Skin
// Essence WABA had 0 templates; the demo WABA had 3 of 7, English only.
//
// ONE definition per template, in gu/hi/mr/en, with EXACTLY the body variables
// the server sends (VARS below is that contract; tests/test-meta-templates.js
// pins it against the senders). {clinic} is filled per language: the local-
// script name for the clinic's own language, the Latin name everywhere else —
// Latin inside a Hindi sentence is normal; Gujarati inside a Hindi one is not.
//
//   npm run wa:templates                                  readiness table (status per template × language)
//   npm run wa:templates -- create --lang gu,hi,en        dry run: print the payloads
//   npm run wa:templates -- create --lang gu,hi,en --yes  submit the missing ones (skips ones that exist)
//   flags: --only name1,name2   --name-en "…"  --name-local "…"  --name-hi "…"
//          --local-lang gu (default META_TEMPLATE_LANGUAGE)   --waba <id>
//
// Credentials: the clinic's stored token + waba_id (desk connect) via
// clinicWhatsApp; else META_ACCESS_TOKEN with --waba <id>. Clinic names from
// --name-en / --name-local, defaulting to CLINIC_NAME / CLINIC_GREETING_NAME.
// Runs inside the container: railway ssh -s engageo-server-v2 -- npm run wa:templates -- create --lang gu,hi,en --yes
// (no parentheses or pipes on that command line — railway ssh mangles them).
//
// DOC (Meta, message-templates/components, read 2026-09-14): BODY ≤ 1024 chars;
// positional variables {{1}}…{{n}} in order; a body with variables must carry
// example.body_text; names are lowercase letters, digits and underscores.
// ASSUMED (not found in the doc, enforced anyway because the approved set
// satisfies it): no variable at the start or end of a body, none adjacent,
// no newline or tab inside a body.
// ═══════════════════════════════════════════════════════════════════════════

const { TEMPLATE_TEXT, EXAMPLES, VARS, LANGS, buildTemplate, nameFor, checkText, readiness, renderText } = require('../templateTexts');

function printReadiness(r, langs) {
  console.log(`\n  ${'template'.padEnd(26)} ${langs.map((l) => l.padEnd(12)).join('')}`);
  for (const row of r.table) console.log(`  ${row.name.padEnd(26)} ${langs.map((l) => row[l].padEnd(12)).join('')}`);
  console.log(`\n  ready: ${r.approved} of ${r.total} template×language pairs approved`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith('--')) || 'status';
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const yes = args.includes('--yes');
  const config = require('../config');
  const langs = (flag('--lang') || 'gu,en').split(',').map((s) => s.trim()).filter(Boolean);
  const only = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(TEMPLATE_TEXT);
  for (const t of only) if (!TEMPLATE_TEXT[t]) { console.error(`✗ unknown template "${t}" — one of ${Object.keys(TEMPLATE_TEXT).join(', ')}`); process.exit(2); }
  const names = { en: flag('--name-en') || process.env.CLINIC_NAME || '', local: flag('--name-local') || process.env.CLINIC_GREETING_NAME || '' };
  for (const l of LANGS) if (flag(`--name-${l}`)) names[l] = flag(`--name-${l}`);
  const localLang = flag('--local-lang') || String(config.whatsapp.defaultTemplateLanguage || 'en').split('_')[0].split('-')[0].toLowerCase();

  const axios = require('axios');
  const v = config.whatsapp.apiVersion;
  let token = null, waba = flag('--waba');
  const db = require('../db');
  try {
    const { getClinicWhatsAppCreds } = require('../clinicWhatsApp');
    const creds = await getClinicWhatsAppCreds(config.clinicId);
    if (creds) {
      token = creds.accessToken;
      if (!waba) { const { rows } = await db.pool.query('SELECT waba_id FROM clinics WHERE id = $1', [config.clinicId]); waba = rows[0] && rows[0].waba_id; }
      console.log('credentials: the clinic\'s own (desk connect)');
    }
  } catch (e) { /* fall through to env */ }
  if (!token) { token = config.whatsapp.accessToken; console.log('credentials: META_ACCESS_TOKEN (env)'); }
  if (!token || !waba) { console.error('✗ need a token and a WABA id (connect from the desk, or pass --waba)'); process.exit(2); }
  const H = { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 };
  const url = `https://graph.facebook.com/${v}/${waba}/message_templates`;

  const list = async () => { const r = await axios.get(url, { ...H, params: { fields: 'name,language,status,category,rejected_reason', limit: 100 } }); return r.data.data || []; };
  const existing = await list();
  console.log(`WABA …${String(waba).slice(-4)}: ${existing.length} template(s)`);
  for (const t of existing) console.log(`  ${t.name.padEnd(28)} [${t.language}] ${t.status}${t.category ? ' ' + t.category : ''}${t.rejected_reason && t.rejected_reason !== 'NONE' ? '  rejected: ' + t.rejected_reason : ''}`);
  printReadiness(readiness(existing, langs), langs);
  if (cmd !== 'create') { await db.pool.end().catch(() => {}); return; }

  console.log(`\n${yes ? 'SUBMITTING' : 'DRY RUN (add --yes to submit)'} — languages: ${langs.join(', ')}; local script for "${localLang}"; templates: ${only.join(', ')}`);
  for (const name of only) for (const lang of langs) {
    const have = existing.find((t) => t.name === name && t.language === lang && t.status !== 'REJECTED');
    if (have) { console.log(`  = ${name} [${lang}] already ${have.status} — skipped`); continue; }
    let payload;
    try { payload = buildTemplate(name, lang, names, { localLang }); }
    catch (e) { console.log(`  ✗ ${name} [${lang}] not submitted: ${e.message}`); continue; }
    if (!yes) { console.log('  → ' + JSON.stringify(payload)); continue; }
    try {
      const r = await axios.post(url, payload, H);
      console.log(`  ✓ ${name} [${lang}] submitted → ${r.data.status || 'PENDING'}${r.data.category ? ' as ' + r.data.category : ''}`);
    } catch (e) {
      console.log(`  ✗ ${name} [${lang}] ${e.response && e.response.data ? JSON.stringify(e.response.data.error || e.response.data).slice(0, 300) : e.message}`);
    }
  }
  await db.pool.end().catch(() => {});
}

module.exports = { TEMPLATE_TEXT, EXAMPLES, VARS, LANGS, buildTemplate, nameFor, checkText, readiness, renderText };
if (require.main === module) main().catch((e) => { console.error('✗', e.message); process.exit(1); });
