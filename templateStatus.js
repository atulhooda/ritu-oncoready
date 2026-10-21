'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// templateStatus.js — which templates Meta has approved, per language,
// reported into clinics.runtime.templates for the desk's readiness card.
//
// Module 5 of the clinic-basics program (2026-09-15). Three of the desk's
// features (day-off notices, staff alerts, and every reminder outside a 24h
// window) deliver only through an APPROVED template, and "is it approved yet?"
// was a question only a terminal could answer. Now the voice service asks
// Meta shortly after boot and hourly, and writes the readiness table beside
// the runtime it already reports; the desk shows it as-of a time.
//
// Reads only. Credentials: the clinic's desk-connected token + waba_id, else
// META_ACCESS_TOKEN + META_BUSINESS_ACCOUNT_ID. No credentials → an honest
// error block, never a throw. TEMPLATE_STATUS_CHECK=off disables the job.
// ═══════════════════════════════════════════════════════════════════════════

const config = require('./config');
const db = require('./db');
const { TEMPLATE_TEXT, readiness } = require('./templateTexts');

function defaultLang() {
  return String(config.whatsapp.defaultTemplateLanguage || 'en').split(/[_-]/)[0].toLowerCase();
}

/** The block the desk renders: our seven templates × the languages that matter here. */
function statusBlock(existing, lang, waba) {
  const ours = new Set(Object.keys(TEMPLATE_TEXT));
  const found = new Set((existing || []).filter((t) => ours.has(t.name)).map((t) => t.language));
  const middle = [...found].filter((l) => l !== lang && l !== 'en').sort();
  const languages = [lang, ...middle, ...(lang !== 'en' ? ['en'] : [])];
  const r = readiness(existing || [], languages);
  return {
    checkedAt: new Date().toISOString(),
    waba: waba ? '…' + String(waba).slice(-4) : null,
    defaultLanguage: lang,
    languages,
    table: r.table,
    approved: r.approved,
    total: r.total,
  };
}

async function resolveCreds(clinicId) {
  try {
    const { getClinicWhatsAppCreds } = require('./clinicWhatsApp');
    const c = await getClinicWhatsAppCreds(clinicId);
    if (c && c.accessToken) {
      const { rows } = await db.pool.query('SELECT waba_id FROM clinics WHERE id = $1', [clinicId]);
      if (rows[0] && rows[0].waba_id) return { token: c.accessToken, waba: rows[0].waba_id };
    }
  } catch (_) { /* fall through to env */ }
  if (config.whatsapp.accessToken && config.whatsapp.businessAccountId) {
    return { token: config.whatsapp.accessToken, waba: config.whatsapp.businessAccountId };
  }
  return null;
}

async function listTemplates({ token, waba }) {
  const axios = require('axios');
  const r = await axios.get(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${waba}/message_templates`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { fields: 'name,language,status,category,rejected_reason', limit: 200 },
    timeout: 15000,
  });
  return (r.data && r.data.data) || [];
}

async function checkTemplateStatus({ clinicId = config.clinicId, creds, list = listTemplates, log = console } = {}) {
  const lang = defaultLang();
  const c = creds === undefined ? await resolveCreds(clinicId) : creds;
  if (!c) {
    return { checkedAt: new Date().toISOString(), defaultLanguage: lang, error: 'no WhatsApp credentials: connect WhatsApp from the desk, or set META_ACCESS_TOKEN and META_BUSINESS_ACCOUNT_ID' };
  }
  try {
    const block = statusBlock(await list(c), lang, c.waba);
    log.log(`[TEMPLATES] ${block.approved} of ${block.total} approved on WABA ${block.waba} (${block.languages.join(', ')})`);
    return block;
  } catch (err) {
    const msg = err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message;
    log.warn(`[TEMPLATES] status check failed: ${msg}`);
    return { checkedAt: new Date().toISOString(), defaultLanguage: lang, error: msg };
  }
}

module.exports = { statusBlock, checkTemplateStatus, listTemplates, resolveCreds };
