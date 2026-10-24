const { Pool } = require('pg');
const config = require('./config');
// Pure, no imports of its own — safe from db.js without reaching any cycle.
const { cleanPersonName } = require('./nameGuard');
// phoneNormalizer's own header has always called itself the "single source of
// truth for all tools + db.js". It was true of the tools and false here until
// 2026-08-11, which cost 27% of handsets their lookups. See phoneVariants().
const { phoneVariants, normalizePhone } = require('./tools/utils/phoneNormalizer');
const { offerableEnd, offerableRange } = require('./tools/utils/offerWindow');
const { resolvePatient, latinFormOf } = require('./patientIdentity');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Each active call issues a few short, bursty queries. Keep this >= the
  // concurrent-call cap so calls don't queue on the pool. Default 10 (pg
  // default); raise via PG_POOL_MAX in lockstep with MAX_CONCURRENT_CALLS.
  max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// The schema is now owned by db/migrations/001_tool_calling_schema.sql
// (run via `npm run db:migrate`). initDb() no longer creates tables — it
// just verifies connectivity at startup. Running CREATE TABLE here would
// race the migration and recreate the legacy (wrong) shapes.
async function initDb() {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection OK (schema managed by migrations).');
  } catch (err) {
    console.error('DB connectivity check failed:', err.message);
  }
}

initDb();

// Single-clinic context for the pilot. Multi-tenant callers can pass an
// explicit clinicId later; for now everything scopes to config.clinicId.
function clinic() {
  return config.clinicId || null;
}

// ─── PATIENTS ────────────────────────────────────────────────────────────────

async function checkReturningPatient(phone) {
  if (!phone) return false;
  try {
    const res = await pool.query(
      'SELECT 1 FROM patients WHERE clinic_id = $1 AND phone = ANY($2) LIMIT 1',
      [clinic(), phoneVariants(phone)]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error('DB Error checking returning patient:', err.message);
    return false;
  }
}

// Most recent real (non-"Unknown") name for a caller, or null.
async function getReturningPatientName(phone) {
  if (!phone) return null;
  try {
    const res = await pool.query(
      // NO LIMIT 1. The SQL filter only knows the literal string 'unknown';
      // cleanPersonName knows the rest — and it used to run AFTER the limit, so
      // the newest row decided the answer before anything checked whether it was
      // a name at all. Prithvi's handset holds, newest first:
      //     ಅಪರಿಚಿತ | pruthvi | gawda | prithvi | . | unknown
      // Kannada for "unknown" is the newest row, so cleanPersonName turned the
      // one candidate the query returned into null and a patient with four
      // recorded visits was greeted as a stranger and asked his name again.
      // Rank in SQL, choose in JS: the newest row that is actually a name.
      `SELECT name FROM patients
        WHERE clinic_id = $1 AND phone = ANY($2) AND name IS NOT NULL AND LOWER(name) <> 'unknown'
        ORDER BY created_at DESC`,
      [clinic(), phoneVariants(phone)]
    );
    // The junk list itself was the THIRD independent implementation of this rule
    // — brain.js had FIELD_FRAGMENTS, whatsappChannel had a two-value check, this
    // had a regex — and all three had different coverage. This one missed the
    // Kannada "ಅಪರಿಚಿತ" and a bare "."; the brain.js one has never run a
    // production call at all. One list now.
    for (const r of res.rows) {
      const clean = cleanPersonName(r.name);
      if (clean) return clean;
    }
    return null;
  } catch (err) {
    console.error('DB Error fetching returning patient name:', err.message);
    return null;
  }
}

// Find-or-create a patient row for call logging. New schema patients.name is
// NOT NULL, so a missing name is stored as 'Unknown'. UNIQUE(clinic_id, phone,
// name) means a later real name creates a distinct row (family-friendly);
// getReturningPatientName prefers the real one.
async function upsertPatient(phone, name) {
  // ONE IMPLEMENTATION, in patientIdentity.js. This used to be one of THREE
  // ("who is this caller"), and only this one carried the identity fixes —
  // tools/bookAppointment.js:134 had its own, matching on the EXACT phone
  // string and the EXACT name, which is the path a booking actually takes. That
  // is why 21e6cc1 did not help the live Bengali call: the fix was in the
  // function the booking never called.
  if (!phone) return null;
  try {
    const p = await resolvePatient(pool, clinic(), phone, name);
    return p ? p.id : null;
  } catch (err) {
    console.error('DB Error upserting patient:', err.message);
    return null;
  }
}

// ─── WHATSAPP CONVERSATIONS / MESSAGES ──────────────────────────────────────

async function getOrCreateConversation(phoneNumber, patientId, language) {
  try {
    // language: only set/refine when provided — COALESCE keeps an existing
    // value if this call passes none, so a later inbound-text detection can
    // override the call-seeded default but a null never clobbers it.
    const res = await pool.query(
      `INSERT INTO whatsapp_conversations (clinic_id, phone_number, patient_id, language)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number) DO UPDATE SET last_message_at = NOW(),
         language = COALESCE($4, whatsapp_conversations.language)
       RETURNING *`,
      [clinic(), phoneNumber, patientId, language || null]
    );
    return res.rows[0];
  } catch (err) {
    console.error('getOrCreateConversation error:', err.message);
    return null;
  }
}

async function saveWhatsAppMessage(conversationId, patientId, direction, body, type, messageSid) {
  try {
    const res = await pool.query(
      `INSERT INTO whatsapp_messages (conversation_id, patient_id, direction, body, type, message_sid)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [conversationId, patientId, direction, body, type, messageSid]
    );
    return res.rows[0].id;
  } catch (err) {
    console.error('saveWhatsAppMessage error:', err.message);
    return null;
  }
}

async function getConversationHistory(conversationId, limit = 10) {
  try {
    const res = await pool.query(
      `SELECT direction, body FROM whatsapp_messages
        WHERE conversation_id = $1 ORDER BY sent_at DESC LIMIT $2`,
      [conversationId, limit]
    );
    return res.rows.reverse().map(row => ({
      role: row.direction === 'inbound' ? 'user' : 'assistant',
      content: row.body
    }));
  } catch (err) {
    console.error('getConversationHistory error:', err.message);
    return [];
  }
}

// The pre-visit intake's state for a WhatsApp thread (migration 017). Shape is
// owned by whatsappChannel.hydrateIntake(); this only stores what it is given.
async function updateConversationIntake(conversationId, intake) {
  try {
    await pool.query('UPDATE whatsapp_conversations SET intake = $1::jsonb WHERE id = $2', [JSON.stringify(intake || null), conversationId]);
    return true;
  } catch (err) {
    console.error('[DB] updateConversationIntake failed:', err.message);
    return false;
  }
}

async function updateConversationState(conversationId, state) {
  try {
    await pool.query(
      'UPDATE whatsapp_conversations SET state = $1, last_message_at = NOW() WHERE id = $2',
      [state, conversationId]
    );
  } catch (err) {
    console.error('updateConversationState error:', err.message);
  }
}

// ─── SCHEDULER (reminders / follow-ups / confirmations) ─────────────────────
// Joins to patients + doctors so callers get phone/name/doctor without a
// denormalized phone column on appointments. appointment_time replaces the
// legacy scheduled_at; status='booked' replaces 'scheduled'.

// HOW FAR AHEAD A REMINDER GOES OUT. Was a hardcoded 23–25 hour window; Skin
// Essence wants two hours (setup form Q62). The ±30-minute half-width is tied
// to the */30 cron: any narrower and a delayed tick drops the reminder
// entirely, any wider and a 120-minute lead starts messaging people three hours
// out. reminder_sent still dedupes the overlapping ticks.
//
// The value itself comes from jobFlags.js, which runtimeConfig also reads — one
// parse, one default, no drift.
const { reminderLeadMinutes } = require('./jobFlags');

async function getAppointmentsForReminder() {
  try {
    const res = await pool.query(
      `SELECT a.id, a.appointment_time AS scheduled_at, a.reason,
              p.phone AS phone_number, p.name AS patient_name,
              d.name AS doctor_name, d.specialty
         FROM appointments a
         JOIN patients p ON a.patient_id = p.id
         JOIN doctors  d ON a.doctor_id  = d.id
        WHERE a.clinic_id = $1
          -- The interval is built by text concatenation, with the ::text cast
          -- written out, because tests/test-db-schema-port.js runs THIS SQL
          -- against pg-mem — which parses neither make_interval() nor
          -- integer * interval, and rejects integer || text without the cast.
          -- Postgres accepts all four forms; only one of them is testable. That
          -- test exists because a hand-copied version of this query drifted from
          -- the real one for months, so the real one bends to stay runnable —
          -- a query no test can execute is exactly how that drift began.
          AND a.appointment_time BETWEEN NOW() + ((($2::int - 30)::text) || ' minutes')::interval
                                     AND NOW() + ((($2::int + 30)::text) || ' minutes')::interval
          AND a.reminder_sent = FALSE
          AND a.status = 'booked'`,
      [clinic(), reminderLeadMinutes()]
    );
    return res.rows;
  } catch (err) {
    console.error('getAppointmentsForReminder error:', err.message);
    return [];
  }
}

async function getAppointmentsForFollowup() {
  try {
    const res = await pool.query(
      `SELECT a.id, a.appointment_time AS scheduled_at, a.reason,
              p.phone AS phone_number, p.name AS patient_name,
              d.name AS doctor_name, d.specialty
         FROM appointments a
         JOIN patients p ON a.patient_id = p.id
         JOIN doctors  d ON a.doctor_id  = d.id
        WHERE a.clinic_id = $1
          AND a.appointment_time BETWEEN (CURRENT_DATE - INTERVAL '1 day' + INTERVAL '10 hours')
                                     AND (CURRENT_DATE + INTERVAL '18 hours')
          AND a.status = 'booked'
          AND a.follow_up_sent = FALSE`,
      [clinic()]
    );
    return res.rows;
  } catch (err) {
    console.error('getAppointmentsForFollowup error:', err.message);
    return [];
  }
}

async function markReminderSent(appointmentId) {
  try { await pool.query('UPDATE appointments SET reminder_sent = TRUE, updated_at = NOW() WHERE id = $1', [appointmentId]); }
  catch (err) { console.error('markReminderSent error:', err.message); }
}

async function markFollowupSent(appointmentId) {
  try { await pool.query('UPDATE appointments SET follow_up_sent = TRUE, updated_at = NOW() WHERE id = $1', [appointmentId]); }
  catch (err) { console.error('markFollowupSent error:', err.message); }
}

async function markAppointmentConfirmed(appointmentId) {
  try { await pool.query('UPDATE appointments SET confirmed = TRUE, updated_at = NOW() WHERE id = $1', [appointmentId]); }
  catch (err) { console.error('markAppointmentConfirmed error:', err.message); }
}

async function markAppointmentCancelled(appointmentId) {
  try { await pool.query("UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [appointmentId]); }
  catch (err) { console.error('markAppointmentCancelled error:', err.message); }
}

async function getMissedCallsForFollowup() {
  try {
    const res = await pool.query(
      `SELECT id, exotel_call_sid AS call_sid, patient_phone AS caller_phone, outcome
         FROM calls
        WHERE clinic_id = $1
          AND created_at >= NOW() - INTERVAL '2 hours'
          AND outcome <> 'booked'
          AND whatsapp_sent = FALSE
          AND patient_phone IS NOT NULL`,
      [clinic()]
    );
    return res.rows;
  } catch (err) {
    console.error('getMissedCallsForFollowup error:', err.message);
    return [];
  }
}

// ─── CALL LOGGING ────────────────────────────────────────────────────────────
// Logs the call record only. Appointment rows are created by the
// book_appointment tool (which has the doctor_id the new appointments table
// requires). We map the legacy appointmentBooked boolean to the calls.outcome
// enum.
async function logCallToDb(callData) {
  try {
    const patientId = await upsertPatient(callData.callerPhone, callData.patientName);
    const outcome = callData.outcome
      || (callData.appointmentBooked ? 'booked' : 'inquiry_only');

    await pool.query(
      `INSERT INTO calls (clinic_id, exotel_call_sid, patient_phone, patient_id,
                          patient_name, duration_seconds, outcome, whatsapp_sent,
                          appointment_id, transcript, language, reason,
                          not_booked_reason, diagnostics, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (exotel_call_sid) DO NOTHING`,
      [
        clinic(), callData.callSid, callData.callerPhone, patientId,
        callData.patientName || null, callData.durationSeconds || null, outcome,
        callData.appointmentId || null,
        // transcript is JSONB — stringify the [{role,text,time}] array so the pg
        // driver sends it as json, not a Postgres array.
        callData.transcript && callData.transcript.length ? JSON.stringify(callData.transcript) : null,
        callData.languageDetected || null,
        callData.reason && callData.reason !== 'Unknown' ? callData.reason : null,
        // The classified reason, and the signals behind it. Both nullable: an
        // older caller that does not supply them still writes a valid row.
        callData.notBookedReason || null,
        callData.diagnostics ? JSON.stringify(callData.diagnostics) : null,
        // A scripted test call, stamped so the desk keeps it out of the clinic's
        // numbers (config.testCallerPhones, migration 019).
        isTestCaller(callData.callerPhone)
      ]
    );
  } catch (err) {
    console.error('logCallToDb error:', err.message);
  }
}

// ─── A STAFF-ONLY REQUEST, AS A ROW THE DESK CAN SEE ───────────────────────
// When a clinic keeps cancel/reschedule for its staff (AGENT_MAY_CANCEL=off),
// Ritu tells the caller "I'll note your request, the clinic will call you".
// Until 2026-09-13 nothing was noted anywhere: the promise had no row, so the
// desk's Needs-you queue never showed it and nobody called back. Same class as
// the "callback laga deti hoon" without REQUEST_CALLBACK rule. This is the row.
// Lands in callbacks (the queue the desk already works), specialty is the
// request kind, reason carries the asked-for time. Deduped per phone + kind
// for 30 minutes so a caller who repeats herself is one card, not three.
async function logStaffRequest({ clinicId, patientName, phone, kind, detail }) {
  const specialty = kind === 'cancel' ? 'Cancel request' : 'Reschedule request';
  const p = normalizePhone(phone) || (phone ? String(phone).trim() : '');
  if (!p) return null;
  const { rows: dup } = await pool.query(
    `SELECT id FROM callbacks
      WHERE clinic_id = $1 AND patient_phone = $2 AND specialty = $3 AND status = 'pending'
        AND created_at > NOW() - INTERVAL '30 minutes'
      LIMIT 1`,
    [clinicId, p, specialty]
  );
  if (dup.length) return dup[0].id;
  const { rows } = await pool.query(
    `INSERT INTO callbacks (clinic_id, patient_name, patient_phone, specialty, reason, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [clinicId, (patientName && String(patientName).trim()) || 'Unknown', p, specialty, detail || null]
  );
  const id = rows[0] ? rows[0].id : null;
  if (id) await queueStaffAlert({ clinicId, callbackId: id, patientName, phone: p, reason: detail || specialty });
  return id;
}

// A callback row is also a WhatsApp to the clinic's staff phones (module 2b,
// 2026-09-14): one outbound_messages row per number in
// clinics.staff_alert_phones, sent by the outbox job within a minute. Empty
// list = nothing queued. A database without migration 020 queues nothing and
// says nothing — the callback row itself is never at risk.
async function queueStaffAlert({ clinicId, callbackId, patientName, phone, reason }, q = pool) {
  try {
    const { rowCount } = await q.query(
      `INSERT INTO outbound_messages (clinic_id, kind, to_phone, callback_id, variables, created_by)
       SELECT c.id, 'staff_callback_alert', p, $2::uuid, $3::jsonb, 'ritu'
         FROM clinics c, unnest(c.staff_alert_phones) AS p
        WHERE c.id = $1`,
      [clinicId, callbackId || null, JSON.stringify({
        '1': (patientName && String(patientName).trim()) || 'Unknown',
        '2': phone || '',
        '3': (reason && String(reason).trim()) || 'Call back',
      })]
    );
    return rowCount || 0;
  } catch (err) {
    if (err && err.code !== '42P01' && err.code !== '42703') console.warn('[OUTBOX] staff alert not queued:', err.message);
    return 0;
  }
}

// Is this caller one of OUR test numbers? Both sides normalized, so the env
// list can be written in any format a human writes a phone number in.
function isTestCaller(rawPhone) {
  const me = normalizePhone(rawPhone);
  if (!me) return false;
  const list = (config.testCallerPhones || []).map((p) => normalizePhone(p)).filter(Boolean);
  return list.includes(me);
}

// ─── WHAT THIS SERVICE RUNS WITH, WRITTEN WHERE THE DESK CAN READ IT ─────────
// The desk cannot see this service's environment. Until now it hard-coded a
// 30-minute slot and could not say whether Ritu may cancel — two guesses about
// switches that live only here. At boot, write the running values onto the
// clinic row (migration 019). ONE source: the env var stays the setting, the
// row is its shadow, and the desk reads the shadow. Never throws: a missing
// column (migration not applied yet) is a warning, not a boot failure.
// bootedAt is the boot, not the last report: the report is re-sent hourly with
// the template status (templateStatus.js), and every extra ever reported this
// boot rides along, so a later report never erases an earlier block.
const BOOTED_AT = new Date().toISOString();
let LAST_EXTRA = {};
async function reportRuntime(extra) {
  const { jobStates } = require('./jobFlags');
  LAST_EXTRA = { ...LAST_EXTRA, ...(extra || {}) };
  const runtime = {
    service: process.env.RAILWAY_SERVICE_NAME || null,
    clinicMode: process.env.CLINIC_MODE || null,
    jobs: jobStates(),
    // What a patient may do to their own appointment through Ritu (module 6).
    switches: { reschedule: config.agentMayReschedule, cancel: config.agentMayCancel },
    bootedAt: BOOTED_AT,
    ...LAST_EXTRA
  };
  try {
    const r = await pool.query(
      `UPDATE clinics
          SET slot_minutes = $2, agent_may_cancel = $3, runtime = $4, runtime_reported_at = NOW()
        WHERE id = $1`,
      [clinic(), config.appointmentSlotMinutes, config.agentMayCancel, JSON.stringify(runtime)]
    );
    if (!r.rowCount) {
      console.warn(`[RUNTIME] no clinics row for ${clinic()} — the desk cannot see this service's switches`);
      return { ok: false, error: 'no_clinic_row' };
    }
    console.log(`[RUNTIME] reported to clinics: slot=${config.appointmentSlotMinutes}min agentMayCancel=${config.agentMayCancel} jobs=${JSON.stringify(runtime.jobs)}`);
    return { ok: true, runtime };
  } catch (err) {
    if (err.code === '42703') {
      console.warn('[RUNTIME] clinics has no slot_minutes column yet (migration 019_desk_loop not applied) — the desk will show defaults');
    } else {
      console.error('[RUNTIME] report failed:', err.message);
    }
    return { ok: false, error: err.message };
  }
}

async function markCallWhatsAppSent(callSid) {
  try { await pool.query('UPDATE calls SET whatsapp_sent = TRUE WHERE exotel_call_sid = $1', [callSid]); }
  catch (err) { console.error('markCallWhatsAppSent error:', err.message); }
}

// ─── LEAN MODE: preloaded doctor roster ──────────────────────────────────────
// Small clinics (1-2 doctors) don't need the find_doctor tool round-trip — we
// load the whole roster + weekly hours once and bake it into the lean-mode prompt,
// so the model can't stall on a tool, can't hallucinate a doctor, and answers in
// one LLM call. Returns prompt-ready text + the doctor list (for name→id at booking).
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function _hhmm(t) { return t ? String(t).slice(0, 5) : ''; }

// How far ahead the roster reports taken slots, and the hard cap on how many
// it will name. The horizon matches what a caller actually books into; the cap
// exists because this text goes into every prompt on the call path and
// ENABLE_ROSTER_SLICE was already added to keep it small at 25+ doctors. A busy
// clinic that blows the cap degrades to today's behaviour for the overflow —
// worse than perfect, identical to what shipped before this.
const TAKEN_HORIZON_DAYS = parseInt(process.env.ROSTER_TAKEN_HORIZON_DAYS || '8', 10);
const TAKEN_MAX_ROWS     = parseInt(process.env.ROSTER_TAKEN_MAX_ROWS || '60', 10);

// timestamptz → 'Mon 17 Aug 17:00' in clinic time. Intl does the IST
// conversion so this stays correct without hand-rolled offsets.
//
// THE DATE IS NOT DECORATION. An 8-day horizon contains the same weekday
// twice, so a bare "Mon 17:00" cannot say WHICH Monday is gone — and a model
// resolving that ambiguity wrongly either offers a taken slot (the bug this
// fixes) or refuses a free one. Ambiguity is the defect class here; six
// characters buys it away.
const _IST_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: process.env.CLINIC_TZ || 'Asia/Kolkata',
  weekday: 'short', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
// Clinic-local YYYY-MM-DD, for a key the slot walker can compare against.
const _IST_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.CLINIC_TZ || 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
// { key, label } — the key is what code compares, the label is what the model
// reads. Both from one conversion so they can never describe different instants.
function _istDayTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const parts = _IST_FMT.formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const hhmm = `${get('hour')}:${get('minute')}`;
  return {
    key: `${_IST_YMD.format(d)} ${hhmm}`,
    label: `${get('weekday')} ${get('day')} ${get('month')} ${hhmm}`,
  };
}
function _formatWeekly(rows) {
  if (!rows.length) return '';
  const byHours = {};
  for (const r of rows) {
    // Offerable range, NOT the raw window — the model reads this text and will
    // offer whatever end it sees. See tools/utils/offerWindow.js.
    const key = offerableRange(r.start_time, r.end_time);
    (byHours[key] = byHours[key] || []).push(r.day_of_week);
  }
  return Object.entries(byHours)
    .map(([hours, days]) => `${days.sort((a, b) => a - b).map(d => DOW_SHORT[d]).join(',')} ${hours}`)
    .join('; ');
}
// Already-booked starts per doctor, clinic-local, e.g. { <id>: ['Mon 17 Aug 17:00'] }.
//
// SEPARATE FROM THE ROSTER ON PURPOSE. Doctors and schedules are static and
// baked once at boot (brain-lean preloadRoster); bookings are not. A taken list
// frozen at boot goes wrong in BOTH directions as the day runs — it hides slots
// that were freed by a cancellation, and misses slots taken since. So this is
// ─── THE OFFER SIDE'S COPY OF THE HOLIDAY LIST ──────────────────────────────
// doctor_exceptions was read only by the accept side (availability.js and
// findDoctor.js). brain-lean's firstFreeSlot walked doctor_schedules alone, so
// it would offer a slot on a day the clinic had marked closed — the caller says
// yes and the commit refuses. The same shape as the taken-slot and window-end
// splits before it.
//
// Fetched for the whole roster in ONE query on the taken-slot TTL cycle rather
// than baked at boot: a clinic adds a holiday from the desk in the middle of a
// working day, which is the staleness profile bookings already have.
//
// The RULE lives in tools/utils/dayClosure.js. This is only the fetch.
async function getUpcomingExceptions(doctorIds, horizonDays = 30) {
  if (!doctorIds || !doctorIds.length) return [];
  const { rows } = await pool.query(
    `SELECT doctor_id, exception_date, exception_type
       FROM doctor_exceptions
      WHERE doctor_id = ANY($1::uuid[])
        AND exception_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND exception_date <= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + ($2 || ' days')::interval)
      ORDER BY exception_date`,
    [doctorIds, String(horizonDays)]
  );
  return rows;
}


// its own call, cheap enough to re-run on a short TTL.
async function getTakenSlots(doctorIds) {
  const out = {};
  if (!doctorIds || !doctorIds.length) return out;
  try {
    const { rows } = await pool.query(
      `SELECT doctor_id, appointment_time
         FROM appointments
        WHERE doctor_id = ANY($1::uuid[])
          AND status = 'booked' AND NOT is_walk_in
          AND appointment_time >= NOW()
          AND appointment_time < NOW() + ($2 || ' days')::interval
        ORDER BY appointment_time
        LIMIT $3`,
      [doctorIds, String(TAKEN_HORIZON_DAYS), TAKEN_MAX_ROWS]
    );
    for (const t of rows) {
      (out[t.doctor_id] = out[t.doctor_id] || []).push(_istDayTime(t.appointment_time));
    }
  } catch (err) {
    // FAIL-OPEN. Losing the taken list puts us back exactly where we were
    // before it existed — offering blind — while throwing would cost the model
    // the entire roster, i.e. every doctor, mid-call.
    console.error('getTakenSlots failed (Ritu will offer blind this turn):', err.message);
    return {};
  }
  return out;
}

// ─── TREATMENTS — THE ROSTER PATTERN, POINTED AT PRICES ─────────────────────
// Same shape as getDoctorsRoster on purpose. That function feeds a prompt block
// under one rule — "SIRF inhi mein se doctor bol; list ke bahar KABHI mat bana"
// — and the measured result is zero invented doctors across 137 production
// calls. A quoted price fails identically and costs more: a caller told
// ₹15,000 and charged ₹40,000 blames the receptionist who said it.
//
// So the text is built HERE, in code, from columns — never summarised by the
// model. Ranges are rendered as ranges because aesthetic pricing genuinely
// varies by area, and a clinic forced to pick one number will pick a wrong one.
// Both prices NULL renders as "poochhne par clinic confirm karega", which is an
// ─── THE CLINIC'S OWN ANSWERS, SPOKEN VERBATIM ──────────────────────────────
// A clone of getTreatments' shape on purpose: text built in code from columns,
// fail-open to an empty block, loaded beside the roster. Same staleness profile
// too — a clinic edits an answer on the desk and the next boot picks it up.
//
// The block that consumes this carries the "only from this list" rule, which is
// the same mechanism behind the roster's measured 0 invented doctors across 137
// calls. It is pointed at facts the clinic wrote rather than at doctor names.
async function getClinicFaqs(clinicId) {
  const cid = clinicId || clinic();
  if (!cid) return { text: '', faqs: [] };
  try {
    const { rows } = await pool.query(
      `SELECT question, answer
         FROM clinic_faqs WHERE clinic_id = $1 AND active = TRUE
        ORDER BY sort_order, question`,
      [cid]
    );
    if (!rows.length) return { text: '', faqs: [] };
    const text = rows.map((f) => `- Q: ${f.question}\n  A: ${f.answer}`).join('\n');
    return { text, faqs: rows };
  } catch (err) {
    // A clinic with no FAQ table entry — or a database predating migration 016 —
    // is the normal case. Never let it cost the roster.
    console.error('[DB] FAQ load failed (Ritu will offer to confirm instead):', err.message);
    return { text: '', faqs: [] };
  }
}


// ─── THE CLINIC'S OWN FEE POLICY, AND WHO IT BOOKS BY DEFAULT ───────────────
// Read beside the roster because both are boot-stable clinic facts and both
// feed the same prompt. Kept OUT of getDoctorsRoster so a clinic that has
// answered neither question costs nothing — an all-NULL row returns null here
// and the prompt renders no fee block at all, which is today's behaviour.
//
// NULL is a real answer here and means "not asked". A clinic with
// followup_fee_inr = 0 is saying follow-ups are free, which is a different fact
// from having never been asked — the distinction the caching investigation lost
// when it read a missing field as a zero.
async function getClinicFeePolicy(clinicId) {
  const cid = clinicId || clinic();
  if (!cid) return null;
  try {
    const { rows } = await pool.query(
      `SELECT c.followup_free_days, c.followup_fee_inr, c.default_doctor_id,
              d.name AS default_doctor_name
         FROM clinics c
         LEFT JOIN doctors d ON d.id = c.default_doctor_id AND d.active = TRUE
        WHERE c.id = $1`,
      [cid]
    );
    const r = rows[0];
    if (!r) return null;
    if (r.followup_free_days == null && r.followup_fee_inr == null && !r.default_doctor_name) return null;
    return {
      followupFreeDays: r.followup_free_days,
      followupFeeInr: r.followup_fee_inr,
      defaultDoctorName: r.default_doctor_name || null,
    };
  } catch (err) {
    // A database without migration 015 is the normal case for every clinic that
    // has not redeployed. Never let a missing column cost the roster.
    console.error('[DB] fee policy load failed (Ritu will not quote a follow-up fee):', err.message);
    return null;
  }
}


// honest sentence Ritu can say instead of guessing.
function _price(t) {
  // THE CLINIC SAID DO NOT QUOTE THIS ONE. The numbers stay on the row for the
  // desk; they simply never enter the string that becomes the prompt. The model
  // cannot leak a figure it was never shown, which is a different and much
  // stronger guarantee than telling it to keep one quiet.
  if (t.disclose_price === false) return 'price: doctor dekh kar batayenge';
  if (t.price_min == null && t.price_max == null) return 'price: clinic confirm karega';
  const unit = t.price_unit || 'session';
  if (t.price_max == null || t.price_max === t.price_min) return `₹${t.price_min}/${unit}`;
  return `₹${t.price_min}-${t.price_max}/${unit}`;
}
function _sessions(t) {
  if (t.sessions_min == null) return '';
  if (t.sessions_max == null || t.sessions_max === t.sessions_min) return `, ${t.sessions_min} session`;
  return `, ${t.sessions_min}-${t.sessions_max} sessions`;
}
async function getTreatments(clinicId) {
  const cid = clinicId || clinic();
  if (!cid) return { text: '', treatments: [] };
  try {
    const { rows } = await pool.query(
      `SELECT name, category, price_min, price_max, price_unit,
              sessions_min, sessions_max, duration_min, downtime, notes,
              disclose_price
         FROM treatments WHERE clinic_id = $1 AND active = TRUE
        ORDER BY category NULLS LAST, name`,
      [cid]
    );
    if (!rows.length) return { text: '', treatments: [] };
    const text = rows.map((t) => {
      const dur  = t.duration_min ? `, ${t.duration_min} min` : '';
      const down = t.downtime ? `, downtime: ${t.downtime}` : '';
      const note = t.notes ? ` — ${t.notes}` : '';
      return `- ${t.name}${t.category ? ` (${t.category})` : ''} — ${_price(t)}${_sessions(t)}${dur}${down}${note}`;
    }).join('\n');
    return { text, treatments: rows };
  } catch (err) {
    // FAIL-OPEN, like the roster. An empty list means Ritu says she will have
    // the clinic confirm — which is the same thing she says for an unlisted
    // treatment, and is never wrong. Throwing would cost the caller the turn.
    console.error('getTreatments error:', err.message);
    return { text: '', treatments: [] };
  }
}

async function getDoctorsRoster(clinicId) {
  const cid = clinicId || clinic();
  if (!cid) return { text: '', doctors: [] };
  try {
    const { rows: docs } = await pool.query(
      `SELECT id, name, specialty, fee_inr, is_on_call
         FROM doctors WHERE clinic_id = $1 AND active = TRUE
        ORDER BY is_on_call ASC, name`,
      [cid]
    );
    if (!docs.length) return { text: '', doctors: [] };
    const { rows: sched } = await pool.query(
      `SELECT doctor_id, day_of_week, start_time, end_time
         FROM doctor_schedules WHERE doctor_id = ANY($1::uuid[])
        ORDER BY doctor_id, day_of_week, start_time`,
      [docs.map(d => d.id)]
    );
    const byDoc = {};
    for (const s of sched) (byDoc[s.doctor_id] = byDoc[s.doctor_id] || []).push(s);

    // ─── SLOTS ALREADY TAKEN ────────────────────────────────────────────────
    // The roster told the model a doctor's HOURS and never which slots were
    // gone, so the offer side proposed times the accept side then refused.
    //
    // LIVE 2026-08-09 07:42Z, call 4843c8bc — Dr. Manoj Deo:
    //   RITU     "वो कल शाम 5:00 बजे उपलब्ध हैं। ... बुक करूँ?"
    //   PATIENT  "कर दो।"
    //   RITU     "उस समय उपलब्ध नहीं। कोई और समय बताइए?"
    //   PATIENT  "क्या कल शाम पाँच बजे आपने तो कहा है।"      ← the caller had to
    //   RITU     "माफ़ कीजिए, मेरी ही गलती थी।"                 argue with her
    // Then the SAME canned line twice more, before she finally offered 5:00–8:00
    // and the caller picked 5:30, which booked. Monday 17:00 had been taken on
    // 08-07; she never looked.
    //
    // The predicate below is uniq_doctor_slot's, deliberately: that partial
    // unique index IS the accept side's definition of "taken", and any other
    // definition here recreates the disagreement in a new place.
    //   uniq_doctor_slot UNIQUE (doctor_id, appointment_time)
    //                    WHERE status = 'booked' AND NOT is_walk_in
    // So cancelled and no_show rows free the slot again (they are excluded from
    // the index), and walk-in doctors are exempt from the constraint entirely —
    // marking their slots taken would hide capacity that genuinely exists.
    const takenByDoc = await getTakenSlots(docs.map(d => d.id));
    const doctors = docs.map(d => ({
      id: d.id, name: d.name, specialty: d.specialty, fee_inr: d.fee_inr,
      is_on_call: d.is_on_call, schedule: _formatWeekly(byDoc[d.id] || []),
      // Structured weekly windows so the lean prompt can compute LIVE availability
      // (anchored to the current moment) instead of making the model do time math.
      // `end` is the last OFFERABLE start, not the shift end. The lean prompt
      // computes live availability from these and speaks the result — handing
      // it the raw close is what produced "8:00 बजे तक उपलब्ध" for a shift that
      // stops accepting bookings at 20:00. tools/utils/offerWindow.js.
      windows: (byDoc[d.id] || []).map(s => ({
        dow: s.day_of_week, start: _hhmm(s.start_time), end: offerableEnd(s.end_time)
      })),
      // Already-booked starts as { key, label }. `label` ('Mon 17 Aug 17:00')
      // is what the model reads; `key` ('2026-08-17 17:00') is what
      // brain-lean's slot walker compares, so the offer can be COMPUTED rather
      // than left to the model to reconcile against a range.
      taken: takenByDoc[d.id] || []
    }));
    const text = doctors.map(d => {
      if (d.is_on_call) return `- ${d.name} (${d.specialty}) — on-call specialist; book mat kar, callback lagao.`;
      const fee = d.fee_inr ? `, fees ₹${d.fee_inr}` : '';
      // Stated positively and compactly, for the same reason closedDays is in
      // brain-lean.js: a taken slot the model has to INFER from an absence is a
      // check it can skip. Naming it costs ~10 chars per booking.
      const busy = d.taken.length ? ` — BOOKED (mat offer): ${d.taken.map(t => t.label).join(', ')}` : '';
      return `- ${d.name} (${d.specialty})${fee} — available: ${d.schedule || 'schedule not set'}${busy}`;
    }).join('\n');
    return { text, doctors };
  } catch (err) {
    console.error('getDoctorsRoster error:', err.message);
    return { text: '', doctors: [] };
  }
}

// ── Confirmed medications (migration 007) ───────────────────────────────────
// The consumer `confirmedMeds` never had. Before this, callHandler pushed every
// caller-verified molecule into an in-memory array that nothing read, so the
// whole read-back layer produced a console line and nothing else.
//
// FAIL-OPEN, DELIBERATELY. This is called mid-call, right after the caller says
// "haan" and immediately before Ritu speaks again. A database hiccup must never
// cost the caller a turn of silence, so every failure is logged and swallowed —
// the [READBACK-GOLD] line still lands in the logs, which is exactly the
// durability we had before this table existed. Nothing gets worse on failure.
async function saveConfirmedMedication(med) {
  if (!med || !med.canonical) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO patient_medications
         (clinic_id, patient_id, phone, call_sid, canonical, brand, heard_surface,
          resolution, match_score, via_brand, turn_offset_ms, language, entity_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [clinic(), med.patientId || null, med.phone || null, med.callSid || null,
       med.canonical, med.brand || null, med.heardSurface || null,
       med.resolution || 'affirmed', med.matchScore ?? null, !!med.viaBrand,
       med.turnOffsetMs ?? null, med.language || null,
       // 'medication' unless the caller explicitly says otherwise. Defaulting
       // here as well as in the DDL means an older deploy that has not been
       // updated still writes a row with correct meaning rather than NULL.
       med.entityType === 'allergy' ? 'allergy' : 'medication']
    );
    return rows[0].id;
  } catch (err) {
    console.error('DB Error saving confirmed medication:', err.message);
    return null;
  }
}

// This caller's previously confirmed molecules, newest first. Two jobs:
// a doctor-facing history, and — measured — the strongest available prior for
// the matcher. At N≈5 candidates a match can be accepted at 0.50 while holding
// false positives at 0.56%, against 0.28 for the full 1,751-molecule list.
async function getPatientMedications(phone, limit = 10) {
  if (!phone) return [];
  try {
    // ─── ONE HANDSET, TWO PATIENTS, ONE MEDICATION LIST ───────────────────
    // `patients` is UNIQUE (clinic_id, phone, name) and the comment above
    // upsertPatient says why — "a later real name creates a distinct row
    // (family-friendly)". Several people per handset is designed for, and
    // shared phones are the norm in Indian clinics. This function is called
    // with NOTHING but the phone (callHandler._loadPriorMeds), so on a shared
    // number it hands the matcher one family member's drugs while a different
    // one is speaking.
    //
    // That prior runs at PRIOR_MAX_DIST 0.50 — twice the general bar. MEASURED
    // with ['Metformin','Telmisartan','Atorvastatin'] loaded:
    //     "matarman" -> []  becomes  ["Metformin"]
    //     "tarasan"  -> []  becomes  ["Atorvastatin"]
    // Neither is a drug. Garbled speech from the person actually on the line is
    // pulled onto somebody else's prescription, read back as "आप Metformin ले
    // रहे हैं?", collects a "हाँ", and lands in the wrong patient's record.
    //
    // Same class as the cancel bug (556b9b4), different table, and the same
    // answer: when the handset carries more than one patient and nothing says
    // which is calling, the safe prior is NO prior. The greeting name cannot
    // rescue it — getReturningPatientName is ORDER BY created_at DESC LIMIT 1,
    // the newest REGISTERED name rather than the caller, so filtering by it
    // swaps a random household member for a confidently wrong one.
    //
    // A single-patient phone — the common case — is untouched.
    // COUNT(DISTINCT name) counted the junk as people. Every handset that had
    // ever produced an "Unknown" row alongside a real one looked like a
    // household and silently lost its prior — the guard firing on the single-
    // patient case it was written to protect. cleanPersonName already knows
    // what is not a name; case-folding collapses the "Siddharth"/"siddharth"
    // pairs that phoneVariants now brings into the same result set.
    //
    // ─── AND THAT LOSS WAS THE WHOLE FEATURE ──────────────────────────────
    // The paragraph above used to end "transliterating names is the fix rather
    // than loosening this", and predicted the cost exactly. MEASURED over 122
    // substantive calls across 60 days:
    //
    //     0 calls arrived with a usable prior
    //    22 calls HAD one and were suppressed here
    //   100 had none yet
    //
    // Zero. The medication prior — measured at +10.8pp drug capture at 0.00%
    // false positives, the single best-evidenced lever in the July research —
    // had never once reached the matcher in production. It was built, wired at
    // four call sites, and silently disarmed by its own guard.
    //
    // The cause is exactly the one the comment named: `patients` holds the same
    // human under both scripts, so "siddharth" and "सिद्धार्थ" counted as a
    // household of two. latinFormOf() (patientIdentity.js) already collapses
    // that pair — it is what the desk uses to show one name per person.
    //
    // THIS DOES NOT LOOSEN THE GUARD, it makes it accurate. Verified against
    // every handset in production that carries a prior:
    //   ["siddharth", "सिद्धार्थ"] -> 1  prior restored (one person)
    //   ["सिद्धार्थ", "atul"]      -> 2  still suppressed (two people)
    // A genuinely shared handset stays protected, which is the case the guard
    // exists for: a wrong prior runs at PRIOR_MAX_DIST 0.50 and can write
    // another patient's drug into this one's record.
    //
    // latinFormOf returns null for a name it cannot romanize (already Latin, or
    // no letters at all), so the fold is `latin || original` — an unromanizable
    // name keeps counting as itself and the guard behaves exactly as before.
    const { rows: names } = await pool.query(
      `SELECT name FROM patients WHERE clinic_id = $1 AND phone = ANY($2)`,
      [clinic(), phoneVariants(phone)]
    );
    const distinct = new Set(
      names
        .map((r) => cleanPersonName(r.name))
        .filter(Boolean)
        .map((n) => (latinFormOf(n) || n).toLowerCase())
    );
    if (distinct.size > 1) {
      console.log(`[PRIOR] ${distinct.size} patients share this number — no medication prior loaded`);
      return [];
    }

    const { rows } = await pool.query(
      // entity_type = 'medication' ONLY. This feeds the matcher prior at
      // PRIOR_MAX_DIST 0.50 — twice the general bar — so an allergen here would
      // make the matcher MORE likely to hear the one drug the patient cannot
      // have. Migration 009 added the column for exactly this filter.
      `SELECT DISTINCT ON (canonical) canonical, brand, resolution, created_at
         FROM patient_medications
        WHERE clinic_id = $1 AND phone = ANY($2) AND entity_type = 'medication'
          -- CONFIRMED GRADES ONLY. callHandler now records two grades the
          -- caller never actually confirmed: 'unconfirmed' (we read a drug back
          -- and nothing ever resolved it) and 'volunteered' (named mid-read-back
          -- with no chance to confirm). Both belong in the medical record, where
          -- a doctor can weigh them. Neither belongs in a prior that runs at
          -- PRIOR_MAX_DIST 0.50, twice the general bar: a drug we merely THOUGHT
          -- we heard would make the matcher likelier to hear it again next call,
          -- and confirm itself into the record on the second pass.
          AND resolution NOT IN ('unconfirmed', 'volunteered')
        ORDER BY canonical, created_at DESC
        LIMIT $3`,
      [clinic(), phoneVariants(phone), limit]
    );
    return rows;
  } catch (err) {
    console.error('DB Error reading patient medications:', err.message);
    return [];
  }
}

// ── Patient documents (WhatsApp report intake) ──────────────────────────────
async function savePatientDocument(doc) {
  const { rows } = await pool.query(
    `INSERT INTO patient_documents
       (clinic_id, patient_id, phone, wa_media_id, mime_type, caption, content, summary, summary_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [doc.clinicId, doc.patientId, doc.phone, doc.waMediaId, doc.mimeType,
     doc.caption, doc.content, doc.summary, doc.summaryJson ? JSON.stringify(doc.summaryJson) : null]
  );
  return rows[0].id;
}

module.exports = {
  savePatientDocument,
  saveConfirmedMedication,
  getPatientMedications,
  pool,
  getDoctorsRoster,
  getClinicFeePolicy,
  getClinicFaqs,
  getTreatments,
  getTakenSlots,
  getUpcomingExceptions,
  checkReturningPatient,
  getReturningPatientName,
  upsertPatient,
  getOrCreateConversation,
  saveWhatsAppMessage,
  getConversationHistory,
  updateConversationState, updateConversationIntake,
  getAppointmentsForReminder,
  getAppointmentsForFollowup,
  markReminderSent,
  markFollowupSent,
  markAppointmentConfirmed,
  markAppointmentCancelled,
  getMissedCallsForFollowup,
  logCallToDb,
  markCallWhatsAppSent,
  isTestCaller,
  reportRuntime,
  logStaffRequest,
  queueStaffAlert
};
