// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEDULED JOBS — and the gate in front of each one.
//
// WHY EVERY JOB IS A NAMED EXPORT. Until 2026-08-26 every cron body here was
// an inline anonymous closure inside cron.schedule(...). Nothing could reach
// them: no test could drive one, and no test ever did. That is not a style
// problem, it is the reason the no-show job shipped broken and stayed broken.
//
// THE NO-SHOW JOB, specifically. It selects `confirmed = false` one hour after
// an appointment, marks the row no_show, and WhatsApps the patient "aaj aap
// nahi aa paaye". The arithmetic is correct. The column is not: NOTHING in
// production ever sets confirmed = TRUE — db.markAppointmentConfirmed exists
// and its only caller is a test file. So every patient who ATTENDS is marked a
// no-show and told they did not turn up. Measured on the demo clinic
// 2026-08-25: 52 of 59 appointments mismarked, 25 of them in 30 days.
// It stays gated OFF until the desk ships an attendance writer.
//
// THE DEFAULTS ARE NOT UNIFORM, DELIBERATELY. A gate that defaults OFF is
// "fail closed" for a job that does damage, and a silent regression for a job
// that works: a clinic whose reminders stop hearing nothing is a clinic that
// finds out from its patients. So the three jobs that do what they claim
// default ON and are switched off per clinic; the one that is broken defaults
// OFF and must be switched on deliberately. The resolved state of all four is
// printed at boot and recorded in runtimeConfig(), so "which jobs ran" is
// never a question you have to answer by reading this file.
// ═══════════════════════════════════════════════════════════════════════════
const cron = require('node-cron');
const db = require('./db');
const config = require('./config');
const { sendReminder, sendFollowup, sendTemplateOrText, checkWhatsAppTokenHealth, checkWhatsAppWebhookRoute } = require('./whatsapp');
const { updateRow } = require('./sheets');
// The job gates live in their own module because runtimeConfig.js records the
// same resolved values on every call — one definition, no drift.
const { JOB_FLAGS, jobEnabled, jobStates } = require('./jobFlags');
const { getClinicWhatsAppCreds } = require('./clinicWhatsApp'); // the clinic's own WhatsApp when desk-connected (audit 2026-09-18)
const { drainOutbox } = require('./outbox');
const templateStatus = require('./templateStatus'); // module object: tests stub checkTemplateStatus

process.env.TZ = 'Asia/Kolkata';

// ─────────────────────────────────────────────────────────────────────────────
// THE JOBS. Each returns a small result object so a driven test can assert on
// what it did without reading the database: { gated } when the flag is off,
// { scanned, acted } when it ran.
// ─────────────────────────────────────────────────────────────────────────────

async function runReminderJob() {
  if (!jobEnabled('REMINDER_JOB', true)) return { gated: true };
  let scanned = 0, acted = 0;
  try {
    const appointments = await db.getAppointmentsForReminder();
    scanned = appointments.length;
    for (const appt of appointments) {
      if (!appt.phone_number) continue;
      await sendReminder(appt);
      acted++;
    }
  } catch (err) {
    console.error('Reminder job error:', err.message);
  }
  return { scanned, acted };
}

async function runFollowupJob() {
  if (!jobEnabled('FOLLOWUP_JOB', true)) return { gated: true };
  let scanned = 0, acted = 0;
  try {
    const appointments = await db.getAppointmentsForFollowup();
    scanned = appointments.length;
    for (const appt of appointments) {
      if (!appt.phone_number) continue;
      await sendFollowup(appt);
      acted++;
    }
  } catch (err) {
    console.error('Followup job error:', err.message);
  }
  return { scanned, acted };
}

async function runNoShowJob() {
  // THE GATE. Inside the function, not around the cron.schedule call, so
  // tests/test-scheduler-gates-driven.js can prove the gate itself holds —
  // a gate nothing drives is the same class of thing as the bug it guards.
  if (!jobEnabled('NOSHOW_JOB', false)) return { gated: true };
  let scanned = 0, acted = 0;
  try {
    const creds = await getClinicWhatsAppCreds(config.clinicId).catch(() => null);
    // 48h lower bound + per-run cap: a scheduler restart (or downtime) must
    // never mass-mark weeks-old rows no_show and WhatsApp each one
    // "aaj aap nahi aa paaye" about a long-past appointment.
    const res = await db.pool.query(`
      SELECT a.id, a.appointment_time, a.patient_id, p.phone AS phone_number
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      WHERE a.clinic_id = $1
        AND a.appointment_time < NOW() - INTERVAL '1 hour'
        AND a.appointment_time > NOW() - INTERVAL '48 hours'
        AND a.status = 'booked'
        -- ATTENDANCE IS A COLUMN THE DESK WRITES (migration 019), not the
        -- confirmed flag nothing in production ever set. A patient the
        -- receptionist marked Arrived can never be swept here.
        AND a.arrived_at IS NULL
      ORDER BY a.appointment_time
      LIMIT 50
    `, [config.clinicId]);
    scanned = res.rows.length;
    for (const appt of res.rows) {
      if (!appt.phone_number) continue;

      await db.pool.query("UPDATE appointments SET status = 'no_show', updated_at = NOW() WHERE id = $1", [appt.id]);

      const msg = "Aaj aap nahi aa paaye, koi baat nahi. Kya hum naya appointment fix karein?";

      // Same dead-template-safe path as every other sender (was drifted: this
      // gated on the always-truthy template name → burned 132001s, sent nothing).
      const noShowTmpl = config.whatsapp.templates && config.whatsapp.templates.no_show;
      // The patient's own language, not the fleet default. sendTemplateOrText
      // used to pass none, so every template went out in META_TEMPLATE_LANGUAGE.
      const conv0 = await db.getOrCreateConversation(appt.phone_number, appt.patient_id);
      const sid = await sendTemplateOrText(appt.phone_number, noShowTmpl, {}, msg, creds, conv0 && conv0.language);

      // Only record the outbound row when something actually went out — a null
      // sid meant a recovery message the dashboard showed but the patient never got.
      if (sid) {
        await db.saveWhatsAppMessage(conv0.id, appt.patient_id, 'outbound', msg, 'no_show_recovery', sid);
      }
      acted++;
    }
  } catch (err) {
    console.error('No-show detection error:', err.message);
  }
  return { scanned, acted };
}

async function runMissedCallJob() {
  if (!jobEnabled('MISSED_CALL_JOB', true)) return { gated: true };
  let scanned = 0, acted = 0;
  try {
    const creds = await getClinicWhatsAppCreds(config.clinicId).catch(() => null);
    const calls = await db.getMissedCallsForFollowup();
    scanned = calls.length;
    for (const call of calls) {
      // The clinic's OWN name. This was the string "Sai Shradha Health Care
      // Centre", compiled in — so every clinic in the fleet would have told
      // its patients they had called the first clinic. Silo does not catch
      // this: separate deploys still ship the same constant.
      const msg = `Aapne ${config.greetingClinicName} ko call kiya tha. Kya main aapki madad kar sakti hoon?`;

      const missedTmpl = config.whatsapp.templates && config.whatsapp.templates.missed_call;
      const convM = await db.getOrCreateConversation(call.caller_phone, call.patient_id);
      const sid = await sendTemplateOrText(call.caller_phone, missedTmpl, {}, msg, creds, convM && convM.language);

      if (sid) {
        await db.saveWhatsAppMessage(convM.id, call.patient_id, 'outbound', msg, 'missed_call', sid);
        await db.markCallWhatsAppSent(call.call_sid);
        await updateRow(call.call_sid, { 'WhatsApp_Sent': true });
      }
      acted++;
    }
  } catch (err) {
    console.error('Missed call followup error:', err.message);
  }
  return { scanned, acted };
}

/** Console-only. Ungated: it sends nothing and touches nothing. */
// The outbox: what the desk queued (module 4 day-off notices, module 2b staff
// alerts), sent through the one WhatsApp path. Every minute; a row is claimed
// per attempt so an overlapping tick cannot double-send. See outbox.js.
async function runOutboxJob() {
  if (!jobEnabled('OUTBOX_JOB', true)) return { gated: true };
  try {
    return await drainOutbox();
  } catch (err) {
    console.error('Outbox job error:', err.message);
    return { error: err.message };
  }
}

// Which templates Meta has approved, per language → clinics.runtime.templates
// (the desk's readiness card, module 5). Shortly after boot and hourly; a read
// only. TEMPLATE_STATUS_CHECK=off disables it.
async function runTemplateStatusJob() {
  if (String(process.env.TEMPLATE_STATUS_CHECK || 'on').trim().toLowerCase() === 'off') return { gated: true };
  // A local boot (the deploy gate's boot-smoke, a laptop .env pointed at a
  // shared database) must not write its credential-less verdict into the
  // clinic's row: only a Railway service checks.
  if (!process.env.RAILWAY_SERVICE_NAME) return { gated: true, reason: 'not a Railway service' };
  try {
    const templates = await templateStatus.checkTemplateStatus();
    await db.reportRuntime({ templates });
    return { ran: true, approved: templates.approved, total: templates.total, error: templates.error };
  } catch (err) {
    console.error('Template status job error:', err.message);
    return { error: err.message };
  }
}

async function runMorningDigest() {
  try {
    const res = await db.pool.query(`
      SELECT COUNT(*) FROM appointments
      WHERE clinic_id = $1
        AND (appointment_time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND status = 'booked'
    `, [config.clinicId]);
    console.log(`MORNING DIGEST: ${res.rows[0].count} appointments scheduled for today.`);
    return { scanned: Number(res.rows[0].count) };
  } catch (err) {
    console.error('Morning digest error:', err.message);
    return { scanned: 0 };
  }
}

async function runTokenHealthCheck() {
  if (process.env.TOKEN_HEALTH_CHECK !== 'on') return { gated: true };
  try {
    await checkWhatsAppTokenHealth();
  } catch (err) {
    console.error('Token health check error:', err.message);
  }
  return { ran: true };
}

// Where do this clinic's WhatsApp replies go? Same gate as the token probe
// (TOKEN_HEALTH_CHECK=on — nothing calls Meta until the operator enables it).
async function runWebhookRouteCheck() {
  if (process.env.TOKEN_HEALTH_CHECK !== 'on') return { gated: true };
  try {
    return await checkWhatsAppWebhookRoute();
  } catch (err) {
    console.error('Webhook route check error:', err.message);
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function initScheduler() {
  console.log('Initializing Scheduler (Timezone: Asia/Kolkata)...');

  const s = jobStates();
  console.log(`[SCHEDULER] jobs: reminder=${s.reminder ? 'ON' : 'off'} followup=${s.followup ? 'ON' : 'off'} missedCall=${s.missedCall ? 'ON' : 'off'} outbox=${s.outbox ? 'ON' : 'off'} noShow=${s.noShow ? 'ON' : 'off'}`);

  // The no-show warning is loud and explains itself, because the failure it
  // guards against is invisible from the outside: the job "works", and the
  // patients it messages are the ones who turned up.
  if (!s.noShow) {
    console.log('[SCHEDULER] ⚠ no-show job DISABLED: it sweeps appointments.arrived_at IS NULL after');
    console.log('[SCHEDULER]   close (22:30 IST). Set NOSHOW_JOB=on ONLY once the desk\'s Arrived button');
    console.log('[SCHEDULER]   is in daily use at this clinic — otherwise attending patients are messaged.');
  } else {
    console.log('[SCHEDULER] ⚠ no-show job ENABLED — the desk must be marking arrivals (arrived_at),');
    console.log('[SCHEDULER]   or attending patients will be marked no_show and messaged.');
  }

  cron.schedule('*/30 * * * *', () => { runReminderJob(); });
  cron.schedule('0 20 * * *',   () => { runFollowupJob(); });
  // AFTER CLOSE, IN CLINIC TIME. The old '0 19' ran in the container's clock
  // and would have swept a morning session while the evening one was still on.
  // 22:30 IST is after every clinic's last slot; the desk's own day-close pass
  // at closing time handles the same rows first, so this is the safety net.
  cron.schedule('30 22 * * *',  () => { runNoShowJob(); }, { timezone: 'Asia/Kolkata' });
  cron.schedule('0 9 * * *',    () => { runMorningDigest(); });
  // Daily WhatsApp token health check (S7-T1). OFF by default — set
  // TOKEN_HEALTH_CHECK=on to enable. Probes Meta's debug_token: logs
  // days-to-expiry; alerts (n8n + [WA-TOKEN-ALERT] console) when the token is
  // invalid or <14 days from expiry, so the 190 class is caught BEFORE
  // confirmations start silently dying. 08:30 IST — before the morning digest.
  cron.schedule('30 8 * * *',   () => { runTokenHealthCheck(); });
  cron.schedule('35 8 * * *',   () => { runWebhookRouteCheck(); });
  cron.schedule('0 * * * *',    () => { runMissedCallJob(); });
  cron.schedule('* * * * *',    () => { runOutboxJob(); });
  cron.schedule('5 * * * *',    () => { runTemplateStatusJob(); });
  // First template check 20 s after boot, once the runtime report has landed.
  const t = setTimeout(() => { runTemplateStatusJob(); }, 20000);
  if (t && t.unref) t.unref();
}

module.exports = {
  initScheduler,
  runOutboxJob,
  runTemplateStatusJob,
  runReminderJob,
  runFollowupJob,
  runNoShowJob,
  runMissedCallJob,
  runMorningDigest,
  runTokenHealthCheck,
  runWebhookRouteCheck,
  jobEnabled,
  jobStates,
  JOB_FLAGS,
};
