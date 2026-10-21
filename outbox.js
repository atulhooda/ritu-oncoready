'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// outbox.js — messages the DESK decides, sent HERE (migration 020/008)
//
// The desk never talks to Meta. It writes a row to outbound_messages (kind +
// positional variables) and this job, every minute, sends it through the same
// sendTemplateOrText every other sender uses: same template ladder, same
// dead-template handling, same delivery ledger (whatsapp_messages), same
// clinic credentials. One WhatsApp path — the twin-path class of defect
// cannot open here.
//
// Exactly-once per attempt: a row is CLAIMED with an UPDATE that only succeeds
// for the attempt number the worker read, so two workers (or one cron tick
// overlapping a slow send) cannot both send it. A send that returns no
// message id is retried on a growing delay, then marked failed with the reason;
// the desk shows both. A database without migration 020 is reported, not
// crashed on.
//
// Kinds:
//   doctor_leave          {1 name, 2 doctor, 3 when}   → META_TEMPLATE_LEAVE
//   staff_callback_alert  {1 patient, 2 phone, 3 why}  → META_TEMPLATE_STAFF_ALERT
// ═══════════════════════════════════════════════════════════════════════════

const config = require('./config');
const db = require('./db');
const { TEMPLATE_TEXT, nameFor, renderText } = require('./templateTexts');

const KINDS = {
  doctor_leave:         { template: () => config.whatsapp.templates.leave,       text: 'doctor_leave_reschedule', ledger: 'doctor_leave' },
  staff_callback_alert: { template: () => config.whatsapp.templates.staff_alert, text: 'staff_callback_alert',    ledger: 'staff_alert' },
};
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.OUTBOX_MAX_ATTEMPTS || '3', 10) || 3);
const RETRY_MINUTES = [10, 30, 120];

function localLang() {
  return String(config.whatsapp.defaultTemplateLanguage || 'en').split(/[_-]/)[0].toLowerCase();
}
function langKey(langCode, textKey) {
  const k = langCode ? String(langCode).split(/[_-]/)[0].toLowerCase() : null;
  if (k && TEMPLATE_TEXT[textKey] && TEMPLATE_TEXT[textKey][k]) return k;
  const l = localLang();
  return TEMPLATE_TEXT[textKey] && TEMPLATE_TEXT[textKey][l] ? l : 'en';
}

/** The plain-text twin of the template for this row: same words, this language, this clinic. */
function fallbackText(kind, variables, langCode) {
  const def = KINDS[kind];
  if (!def) return '';
  const lang = langKey(langCode, def.text);
  const names = { en: process.env.CLINIC_NAME || '', local: config.greetingClinicName || '' };
  return renderText(def.text, lang, variables || {}, nameFor(lang, names, localLang()));
}

async function drainOutbox({ pool = db.pool, send, creds, limit = 25, log = console } = {}) {
  const sendFn = send || require('./whatsapp').sendTemplateOrText;
  const clinicId = config.clinicId;
  if (!clinicId) return { scanned: 0, sent: 0, failed: 0 };
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, kind, to_phone, patient_id, appointment_id, callback_id, variables, language, attempts
         FROM outbound_messages
        WHERE clinic_id = $1 AND status = 'queued' AND scheduled_at <= NOW()
        ORDER BY id LIMIT $2`,
      [clinicId, limit]
    ));
  } catch (err) {
    if (err.code === '42P01') {
      log.warn('[OUTBOX] outbound_messages missing — migration 020_outbox not applied; nothing sent');
      return { scanned: 0, sent: 0, failed: 0, missing: true };
    }
    throw err;
  }
  if (!rows.length) return { scanned: 0, sent: 0, failed: 0 };
  const c = creds === undefined ? await require('./clinicWhatsApp').getClinicWhatsAppCreds(clinicId).catch(() => null) : creds;
  let sent = 0, failed = 0;
  for (const row of rows) {
    // The claim. Only the worker that read attempts=N advances it to N+1.
    const claim = await pool.query(
      `UPDATE outbound_messages SET attempts = attempts + 1
        WHERE id = $1 AND status = 'queued' AND attempts = $2 RETURNING attempts`,
      [row.id, row.attempts]
    );
    if (!claim.rowCount) continue;
    const attempt = claim.rows[0].attempts;
    const def = KINDS[row.kind];
    if (!def) {
      await pool.query(`UPDATE outbound_messages SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, `unknown kind ${row.kind}`]);
      failed++;
      continue;
    }
    const vars = row.variables && typeof row.variables === 'object' ? row.variables : {};
    const text = fallbackText(row.kind, vars, row.language);
    let sid = null, err = null;
    try { sid = await sendFn(row.to_phone, def.template(), vars, text, c, row.language || undefined); }
    catch (e) { err = e.message; }
    if (sid) {
      await pool.query(`UPDATE outbound_messages SET status = 'sent', wamid = $2, sent_at = NOW(), last_error = NULL WHERE id = $1`, [row.id, sid]);
      sent++;
      // The ledger the desk reads (its WhatsApp chips) — the table every other sender writes.
      try {
        const conv = await db.getOrCreateConversation(row.to_phone, row.patient_id || null, row.language || null);
        if (conv) await db.saveWhatsAppMessage(conv.id, row.patient_id || null, 'outbound', text, def.ledger, sid);
      } catch (e) { log.warn(`[OUTBOX] ledger write failed for #${row.id}: ${e.message}`); }
      continue;
    }
    const reason = err || 'no message id (template not live and plain text refused?)';
    if (attempt >= MAX_ATTEMPTS) {
      await pool.query(`UPDATE outbound_messages SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, reason]);
      failed++;
    } else {
      const mins = RETRY_MINUTES[Math.min(attempt - 1, RETRY_MINUTES.length - 1)];
      await pool.query(`UPDATE outbound_messages SET last_error = $2, scheduled_at = NOW() + ($3::text || ' minutes')::interval WHERE id = $1`, [row.id, reason, String(mins)]);
    }
  }
  log.log(`[OUTBOX] scanned ${rows.length}, sent ${sent}, failed ${failed}`);
  return { scanned: rows.length, sent, failed };
}

module.exports = { drainOutbox, fallbackText, KINDS, MAX_ATTEMPTS, RETRY_MINUTES };
